use crate::environment::CompiledEnvironment;
use crate::firebase::FirebaseClient;
use serde_json::{json, Value};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Heartbeat<'a> {
    pub client: &'a FirebaseClient,
    pub settings: &'a CompiledEnvironment,
    pub worker_id: &'a str,
    pub identity_source: &'a str,
    pub token_hash: &'a str,
    pub label: &'a str,
    pub started_at: u64,
}

impl Heartbeat<'_> {
    pub fn send(&self, status: &str, active_jobs: usize) -> Result<(), String> {
        let path = format!("workspaces/{}/agents/{}", self.settings.workspace_id, self.worker_id);
        let existing = self.client.get(&path).unwrap_or(Value::Null);
        let sharing = existing.get("sharing").and_then(Value::as_str).filter(|v| matches!(*v, "private" | "shared" | "public")).unwrap_or("private");
        let payload = json!({
            "id": self.worker_id,
            "runtime": "rust",
            "runtimeVersion": env!("CARGO_PKG_VERSION"),
            "workerVersion": env!("CARGO_PKG_VERSION"),
            "features": ["heartbeat", "claim", "queue-polling", "job-leasing"],
            "identitySource": self.identity_source,
            "label": self.label,
            "hostname": hostname(),
            "location": self.settings.worker_location,
            "poolId": self.settings.pool_id,
            "status": status,
            "activeJobs": active_jobs,
            "maxConcurrency": self.settings.max_concurrency,
            "shards": configured_shards(self.settings),
            "lastHeartbeat": now_millis(),
            "startedAt": self.started_at,
            "pid": std::process::id(),
            "platform": std::env::consts::OS.to_string() + "/" + std::env::consts::ARCH,
            "system": std::env::consts::OS,
            "machine": std::env::consts::ARCH,
            "cloneDir": self.settings.clone_dir,
            "dataDir": self.settings.data_dir,
            "ngrokEnabled": self.settings.ngrok_enabled,
            "ngrokRegion": self.settings.ngrok_region,
            "leaseSeconds": self.settings.lease_seconds,
            "pollSeconds": self.settings.poll_seconds,
            "docker": docker_summary(),
            "sharing": sharing,
            "shared": sharing == "shared" || sharing == "public",
            "public": sharing == "public",
            "sharingUpdatedAt": existing.get("sharingUpdatedAt").cloned().unwrap_or(Value::Null),
            "sharingUpdatedBy": existing.get("sharingUpdatedBy").cloned().unwrap_or(Value::Null),
            "workerTokenHash": self.token_hash,
            "claimedAt": existing.get("claimedAt").cloned().unwrap_or(Value::Null),
            "claimedBy": existing.get("claimedBy").cloned().unwrap_or(Value::Null),
            "ownerUid": existing.get("ownerUid").cloned().unwrap_or(Value::Null),
            "ownerEmail": existing.get("ownerEmail").cloned().unwrap_or(Value::Null),
            "sharedEmails": existing.get("sharedEmails").cloned().unwrap_or_else(|| json!([])),
        });
        self.client.put(&path, &payload).map(|_| ())
    }
}

pub fn configured_shards(settings: &CompiledEnvironment) -> Vec<String> {
    if !settings.worker_shards.is_empty() {
        return settings.worker_shards.iter().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).collect();
    }
    (0..settings.queue_shard_count.clamp(1, 16)).map(|index| format!("{index:02}")).collect()
}

pub fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn hostname() -> String {
    std::fs::read_to_string("/etc/hostname").unwrap_or_else(|_| "worker".into()).trim().to_string()
}

fn docker_summary() -> Value {
    let output = Command::new("docker").args(["version", "--format", "{{json .}}"] ).output();
    match output {
        Ok(output) if output.status.success() => serde_json::from_slice(&output.stdout).unwrap_or_else(|_| json!({"available": true})),
        Ok(output) => json!({"available": false, "error": String::from_utf8_lossy(&output.stderr).trim()}),
        Err(error) => json!({"available": false, "error": error.to_string()}),
    }
}
