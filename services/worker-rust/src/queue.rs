use crate::environment::CompiledEnvironment;
use crate::firebase::FirebaseClient;
use crate::heartbeat::{configured_shards, now_millis, Heartbeat};
use crate::operations;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub struct QueueRunner<'a> {
    client: &'a FirebaseClient,
    settings: &'a CompiledEnvironment,
    heartbeat: &'a Heartbeat<'a>,
    worker_id: &'a str,
}

impl<'a> QueueRunner<'a> {
    pub fn new(client: &'a FirebaseClient, settings: &'a CompiledEnvironment, heartbeat: &'a Heartbeat<'a>, worker_id: &'a str) -> Self {
        Self { client, settings, heartbeat, worker_id }
    }

    pub fn run(&self, running: &AtomicBool) {
        while running.load(Ordering::SeqCst) {
            if let Err(error) = self.scan() { eprintln!("queue scan failed: {error}"); }
            let seconds = self.settings.poll_seconds.max(1);
            for _ in 0..seconds * 10 {
                if !running.load(Ordering::SeqCst) { return; }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }

    fn scan(&self) -> Result<(), String> {
        for shard in configured_shards(self.settings) {
            let path = format!("queues/{}/{shard}", self.settings.pool_id);
            let queued = self.client.get(&path)?;
            let Some(items) = queued.as_object() else { continue };
            let mut jobs: Vec<(&String, &Value)> = items.iter().collect();
            jobs.sort_by_key(|(_, item)| number(item, "createdAt"));
            for (job_id, queue_item) in jobs.into_iter().take(self.settings.max_concurrency as usize) {
                let target = text(queue_item, "targetWorkerId");
                if !target.is_empty() && target != self.worker_id { continue; }
                self.process(job_id, &shard);
            }
        }
        Ok(())
    }

    fn process(&self, job_id: &str, shard: &str) {
        let queue_path = format!("queues/{}/{shard}/{job_id}", self.settings.pool_id);
        let job = match self.claim(job_id) {
            Ok(Some(job)) => job,
            Ok(None) => return,
            Err(error) => { eprintln!("job {job_id} claim failed: {error}"); return; }
        };
        if text(&job, "workspaceId") != self.settings.workspace_id {
            let _ = self.fail(&job, "worker is not assigned to this workspace");
            let _ = self.client.delete(&queue_path);
            return;
        }
        if job.get("cancellationRequested").and_then(Value::as_bool).unwrap_or(false) {
            let _ = self.publish(&job, json!({"status":"cancelled", "message":"Cancelled before execution", "finishedAt":now_millis(), "leaseExpiresAt":null}));
            let _ = self.client.delete(&queue_path);
            return;
        }
        let lock_path = format!("locks/{}/{}", self.settings.workspace_id, lock_key(&job));
        match self.acquire_lock(&lock_path, &job) {
            Ok(true) => {}
            Ok(false) => { let _ = self.publish(&job, json!({"status":"queued", "workerId":null, "leaseExpiresAt":null, "message":"Waiting for repository lock"})); return; }
            Err(error) => { let _ = self.fail(&job, &error); return; }
        }
        let _ = self.publish(&job, json!({"status":"running", "progress":10, "message":"Worker claimed deployment"}));
        let _ = self.heartbeat.send("online", 1);
        let renewing = AtomicBool::new(true);
        let result = std::thread::scope(|scope| {
            scope.spawn(|| {
                let interval = (self.settings.lease_seconds / 3).max(10);
                while renewing.load(Ordering::SeqCst) {
                    for _ in 0..interval * 10 {
                        if !renewing.load(Ordering::SeqCst) { return; }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    let expires = now_millis() + self.settings.lease_seconds * 1000;
                    let _ = self.publish(&job, json!({"leaseExpiresAt": expires}));
                    let _ = self.client.put(&format!("{lock_path}/expiresAt"), &json!(expires));
                }
            });
            let result = operations::execute(self.client, self.settings, self.worker_id, &job);
            renewing.store(false, Ordering::SeqCst);
            result
        });
        match result {
            Ok(result) => {
                if !result.repository_updates.is_empty() {
                    let repository_id = text(&job, "repositoryId");
                    let container_id = text(&job, "containerId");
                    if text(&job, "action") == "container_tunnel_start" && !container_id.is_empty() {
                        let _ = self.client.patch(&format!("workspaces/{}/containers/{container_id}", self.settings.workspace_id), &Value::Object(result.repository_updates));
                    } else if !repository_id.is_empty() {
                        let _ = self.client.patch(&format!("workspaces/{}/repositories/{repository_id}", self.settings.workspace_id), &Value::Object(result.repository_updates));
                    }
                }
                let mut updates = result.job_updates;
                updates.insert("status".into(), json!("completed"));
                updates.insert("progress".into(), json!(100));
                updates.insert("message".into(), json!(result.message));
                updates.insert("finishedAt".into(), json!(now_millis()));
                updates.insert("leaseExpiresAt".into(), Value::Null);
                let _ = self.publish(&job, Value::Object(updates));
            }
            Err(error) => { let _ = self.fail(&job, &error); }
        }
        self.release_lock(&lock_path, &job);
        let _ = self.client.delete(&queue_path);
        let _ = self.heartbeat.send("online", 0);
    }

    fn claim(&self, job_id: &str) -> Result<Option<Value>, String> {
        let path = format!("jobs/{job_id}");
        for _ in 0..3 {
            let (etag, mut job) = self.client.get_etag(&path)?;
            if job.is_null() { return Ok(None); }
            let status = text(&job, "status");
            if matches!(status.as_str(), "completed" | "failed" | "cancelled") { return Ok(None); }
            let target = text(&job, "targetWorkerId");
            if !target.is_empty() && target != self.worker_id { return Ok(None); }
            let lease_expired = number(&job, "leaseExpiresAt") < now_millis();
            if !matches!(status.as_str(), "queued" | "leased" | "running") || (!text(&job, "workerId").is_empty() && !lease_expired) { return Ok(None); }
            let object = job.as_object_mut().ok_or("job payload is not an object")?;
            object.insert("status".into(), json!("leased"));
            object.insert("workerId".into(), json!(self.worker_id));
            object.insert("leaseExpiresAt".into(), json!(now_millis() + self.settings.lease_seconds * 1000));
            object.insert("attempt".into(), json!(number(&Value::Object(object.clone()), "attempt") + 1));
            if number(&Value::Object(object.clone()), "startedAt") == 0 { object.insert("startedAt".into(), json!(now_millis())); }
            if let Some(updated) = self.client.put_if_match(&path, &etag, &job)? {
                if text(&updated, "workerId") == self.worker_id && text(&updated, "status") == "leased" { return Ok(Some(updated)); }
                return Ok(None);
            }
        }
        Ok(None)
    }

    fn acquire_lock(&self, path: &str, job: &Value) -> Result<bool, String> {
        for _ in 0..3 {
            let (etag, current) = self.client.get_etag(path)?;
            if !current.is_null() && number(&current, "expiresAt") >= now_millis() && text(&current, "jobId") != text(job, "id") { return Ok(false); }
            let next = json!({"jobId":text(job,"id"), "workerId":self.worker_id, "expiresAt":now_millis()+self.settings.lease_seconds*1000});
            if let Some(updated) = self.client.put_if_match(path, &etag, &next)? {
                return Ok(text(&updated, "jobId") == text(job, "id") && text(&updated, "workerId") == self.worker_id);
            }
        }
        Ok(false)
    }

    fn release_lock(&self, path: &str, job: &Value) {
        if let Ok(current) = self.client.get(path) {
            if text(&current, "jobId") == text(job, "id") { let _ = self.client.delete(path); }
        }
    }

    fn publish(&self, job: &Value, values: Value) -> Result<(), String> {
        let values = values.as_object().ok_or("job updates must be an object")?;
        let mut updates = Map::new();
        let job_id = text(job, "id");
        let workspace_id = text(job, "workspaceId");
        for (key, value) in values {
            updates.insert(format!("jobs/{job_id}/{key}"), value.clone());
            updates.insert(format!("workspaces/{workspace_id}/deployments/{job_id}/{key}"), value.clone());
        }
        self.client.patch("", &Value::Object(updates)).map(|_| ())
    }

    fn fail(&self, job: &Value, error: &str) -> Result<(), String> {
        self.publish(job, json!({"status":"failed", "message":tail(error,1000), "finishedAt":now_millis(), "leaseExpiresAt":null}))
    }
}

fn lock_key(job: &Value) -> String {
    let repository = text(job, "repositoryId");
    if !repository.is_empty() { repository } else { format!("container-{}", text(job, "containerId")) }
}

fn text(value: &Value, key: &str) -> String { value.get(key).and_then(Value::as_str).unwrap_or("").to_string() }
fn number(value: &Value, key: &str) -> u64 { value.get(key).and_then(Value::as_u64).unwrap_or(0) }
fn tail(value: &str, limit: usize) -> &str {
    if value.len() <= limit { return value; }
    let mut start = value.len() - limit;
    while !value.is_char_boundary(start) { start += 1; }
    &value[start..]
}
