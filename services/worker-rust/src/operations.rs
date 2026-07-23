use crate::environment::CompiledEnvironment;
use crate::firebase::FirebaseClient;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

pub struct OperationResult {
    pub message: String,
    pub job_updates: Map<String, Value>,
    pub repository_updates: Map<String, Value>,
}

impl OperationResult {
    fn message(value: impl Into<String>) -> Self {
        Self { message: value.into(), job_updates: Map::new(), repository_updates: Map::new() }
    }
}

pub fn execute(client: &FirebaseClient, settings: &CompiledEnvironment, worker_id: &str, job: &Value) -> Result<OperationResult, String> {
    let action = text(job, "action");
    match action.as_str() {
        "inventory_refresh" => publish_container_inventory(client, settings, worker_id),
        "worker_command" => worker_command(settings, job),
        "container_exec" => container_exec(job),
        "container_start" | "container_stop" | "container_restart" | "container_delete" | "container_logs" => container_action(&action, job),
        "container_tunnel_start" => container_tunnel_start(settings, job),
        "discover_branches" => discover_branches(client, settings, job),
        "sync" | "read_compose" | "read_dockerfile" | "deploy" | "build" | "stop" | "tunnel_start" | "tunnel_stop" => {
            repository_action(client, settings, job, &action)
        }
        _ => Err(format!("unsupported worker action: {action}")),
    }
}

pub fn publish_container_inventory(client: &FirebaseClient, settings: &CompiledEnvironment, worker_id: &str) -> Result<OperationResult, String> {
    let (output, code) = command_output(Command::new("docker").args([
        "ps", "-a", "--no-trunc", "--format",
        "{{json .}}",
    ]))?;
    if code != 0 { return Err(format!("container inventory failed: {}", tail(&output, 1000))); }
    let mut updates = Map::new();
    let now = crate::heartbeat::now_millis();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let item: Value = serde_json::from_str(line).map_err(|e| format!("parse Docker inventory: {e}"))?;
        let docker_id = item.get("ID").and_then(Value::as_str).unwrap_or("");
        let name = item.get("Names").and_then(Value::as_str).unwrap_or(docker_id);
        if docker_id.is_empty() { continue; }
        let record_id = format!("{worker_id}--{}", safe_name(name));
        let is_worker = name.to_ascii_lowercase().contains("worker")
            || item.get("Labels").and_then(Value::as_str).unwrap_or("").contains("com.docker.compose.service=worker");
        updates.insert(
            format!("workspaces/{}/containers/{record_id}", settings.workspace_id),
            json!({
                "id": record_id,
                "dockerId": docker_id,
                "name": name,
                "image": item.get("Image").cloned().unwrap_or(Value::Null),
                "status": item.get("Status").cloned().unwrap_or(Value::Null),
                "state": item.get("State").cloned().unwrap_or(Value::Null),
                "ports": item.get("Ports").cloned().unwrap_or(Value::Null),
                "labels": item.get("Labels").cloned().unwrap_or(Value::Null),
                "workerId": worker_id,
                "workerLabel": if settings.worker_label.is_empty() { "Rust" } else { settings.worker_label },
                "poolId": settings.pool_id,
                "isWorkerContainer": is_worker,
                "protectedActions": if is_worker { json!(["container_stop", "container_delete", "container_exec"]) } else { json!([]) },
                "lastSeenAt": now,
                "updatedAt": now,
            }),
        );
    }
    if !updates.is_empty() { client.patch("", &Value::Object(updates))?; }
    Ok(OperationResult::message("Container inventory refreshed"))
}

fn worker_command(settings: &CompiledEnvironment, job: &Value) -> Result<OperationResult, String> {
    let command = text(job, "command");
    if command.trim().is_empty() {
        return Err("command is required".into());
    }
    let workdir = text(job, "workdir");
    let cwd = if workdir.is_empty() { PathBuf::from(settings.clone_dir) } else { safe_child(Path::new(settings.clone_dir), &workdir)? };
    let output = run_shell(&command, &cwd, &HashMap::new())?;
    let mut result = OperationResult::message(if output.1 == 0 { "Command completed" } else { "Command failed" });
    result.job_updates.insert("commandOutput".into(), json!(output.0));
    result.job_updates.insert("commandExitCode".into(), json!(output.1));
    if output.1 != 0 { return Err(format!("command exited with code {}: {}", output.1, tail(&output.0, 1000))); }
    Ok(result)
}

fn container_exec(job: &Value) -> Result<OperationResult, String> {
    let container = resolve_container(job)?;
    let command = text(job, "command");
    if command.trim().is_empty() { return Err("command is required".into()); }
    ensure_not_worker(&container, "container_exec")?;
    let output = command_output(Command::new("docker").args(["exec", &container, "sh", "-lc", &command]))?;
    let mut result = OperationResult::message(if output.1 == 0 { "Container command completed" } else { "Container command failed" });
    result.job_updates.insert("commandOutput".into(), json!(output.0));
    result.job_updates.insert("commandExitCode".into(), json!(output.1));
    if output.1 != 0 { return Err(format!("container command exited with code {}: {}", output.1, tail(&output.0, 1000))); }
    Ok(result)
}

fn container_action(action: &str, job: &Value) -> Result<OperationResult, String> {
    let container = resolve_container(job)?;
    if matches!(action, "container_stop" | "container_delete") { ensure_not_worker(&container, action)?; }
    let args: Vec<&str> = match action {
        "container_start" => vec!["start", &container],
        "container_stop" => vec!["stop", &container],
        "container_restart" => vec!["restart", &container],
        "container_delete" => vec!["rm", "-f", &container],
        "container_logs" => vec!["logs", "--tail", "300", &container],
        _ => unreachable!(),
    };
    let (output, code) = command_output(Command::new("docker").args(args))?;
    if code != 0 { return Err(format!("Docker action failed: {}", tail(&output, 1000))); }
    let mut result = OperationResult::message(format!("{} completed", action.replace('_', " ")));
    if action == "container_logs" {
        result.job_updates.insert("commandOutput".into(), json!(output));
        result.job_updates.insert("commandExitCode".into(), json!(0));
    }
    Ok(result)
}

fn discover_branches(client: &FirebaseClient, settings: &CompiledEnvironment, job: &Value) -> Result<OperationResult, String> {
    let repository = load_repository(client, settings, job)?;
    let url = repo_url(&repository)?;
    let output = command_output(Command::new("git").args(["ls-remote", "--heads", &url]))?;
    if output.1 != 0 { return Err(format!("discover branches failed: {}", tail(&output.0, 1000))); }
    let branches: Vec<String> = output.0.lines().filter_map(|line| line.split("refs/heads/").nth(1)).map(str::to_string).collect();
    let mut result = OperationResult::message(format!("Found {} branches", branches.len()));
    result.repository_updates.insert("branches".into(), json!(branches));
    Ok(result)
}

fn repository_action(client: &FirebaseClient, settings: &CompiledEnvironment, job: &Value, action: &str) -> Result<OperationResult, String> {
    let repository = load_repository(client, settings, job)?;
    let repository_id = text(job, "repositoryId");
    let project = safe_name(repository.get("name").and_then(Value::as_str).unwrap_or(&repository_id));
    let repo_path = Path::new(settings.clone_dir).join(&project);
    if action == "sync" || action == "deploy" || action == "build" || action == "read_compose" || action == "read_dockerfile" {
        sync_repo(&repository, &repo_path)?;
    }
    let mode = repository.get("deploymentMode").or_else(|| repository.get("mode")).and_then(Value::as_str).unwrap_or("compose");
    let env = repository_environment(&repository);
    match action {
        "sync" => Ok(OperationResult::message("Repository synchronized")),
        "read_compose" => read_file_result(&repo_path, repository.get("composeFile").and_then(Value::as_str).unwrap_or("docker-compose.yml"), "composeContent"),
        "read_dockerfile" => read_file_result(&repo_path, repository.get("dockerfile").and_then(Value::as_str).unwrap_or("Dockerfile"), "dockerfileContent"),
        "deploy" => {
            if mode != "compose" { return Err("deploy requires Docker Compose mode".into()); }
            write_env(&repo_path, &env)?;
            let compose = safe_child(&repo_path, repository.get("composeFile").and_then(Value::as_str).unwrap_or("docker-compose.yml"))?;
            let (output, code) = command_output(Command::new("docker").current_dir(&repo_path).args(["compose", "-p", &project, "-f"]).arg(compose).args(["up", "-d", "--build"]))?;
            if code != 0 { return Err(format!("Compose deployment failed: {}", tail(&output, 2000))); }
            Ok(OperationResult::message("Compose stack deployed"))
        }
        "build" => {
            if mode != "dockerfile" { return Err("build requires Dockerfile mode".into()); }
            let dockerfile = safe_child(&repo_path, repository.get("dockerfile").and_then(Value::as_str).unwrap_or("Dockerfile"))?;
            let image = format!("worqer-{project}:latest");
            let (build_output, build_code) = command_output(Command::new("docker").current_dir(&repo_path).args(["build", "-f"]).arg(dockerfile).args(["-t", &image, "."]))?;
            if build_code != 0 { return Err(format!("Dockerfile build failed: {}", tail(&build_output, 2000))); }
            let _ = command_output(Command::new("docker").args(["rm", "-f", &project]));
            let mut command = Command::new("docker");
            command.args(["run", "-d", "--name", &project]);
            for (key, value) in &env { command.args(["-e", &format!("{key}={value}")]); }
            for port in ports(&repository) { command.args(["-p", &port]); }
            command.arg(&image);
            let (output, code) = command_output(&mut command)?;
            if code != 0 { return Err(format!("Dockerfile container failed: {}", tail(&output, 2000))); }
            Ok(OperationResult::message("Dockerfile service deployed"))
        }
        "stop" => {
            let output = if mode == "dockerfile" {
                command_output(Command::new("docker").args(["rm", "-f", &project]))?
            } else {
                let compose = safe_child(&repo_path, repository.get("composeFile").and_then(Value::as_str).unwrap_or("docker-compose.yml"))?;
                command_output(Command::new("docker").current_dir(&repo_path).args(["compose", "-p", &project, "-f"]).arg(compose).arg("down"))?
            };
            if output.1 != 0 { return Err(format!("stop failed: {}", tail(&output.0, 1000))); }
            Ok(OperationResult::message("Deployment stopped"))
        }
        "tunnel_start" => start_repository_tunnel(settings, &repository, &project),
        "tunnel_stop" => stop_tunnel(settings, &project),
        _ => Err(format!("unsupported repository action: {action}")),
    }
}

fn container_tunnel_start(settings: &CompiledEnvironment, job: &Value) -> Result<OperationResult, String> {
    let container = resolve_container(job)?;
    let port = job.get("port").and_then(Value::as_u64).unwrap_or(80);
    start_tunnel(settings, &format!("container-{container}"), &format!("http://{container}:{port}"), &text(job, "domain"))
}

fn start_repository_tunnel(settings: &CompiledEnvironment, repository: &Value, project: &str) -> Result<OperationResult, String> {
    let port = repository.get("publicPort").or_else(|| repository.get("port")).and_then(Value::as_u64).unwrap_or(80);
    start_tunnel(settings, project, &format!("http://host.docker.internal:{port}"), repository.get("ngrokDomain").and_then(Value::as_str).unwrap_or(""))
}

fn start_tunnel(settings: &CompiledEnvironment, project: &str, target: &str, domain: &str) -> Result<OperationResult, String> {
    if !settings.ngrok_enabled { return Err("ngrok is not enabled for this worker".into()); }
    let state_dir = Path::new(settings.data_dir).join("ngrok");
    fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;
    let safe = safe_name(project);
    let log_path = state_dir.join(format!("{safe}.log"));
    let log = fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut command = Command::new(settings.ngrok_bin);
    command.args(["http", target, "--log", "stdout", "--log-format", "json"]);
    if !settings.ngrok_authtoken.is_empty() { command.args(["--authtoken", settings.ngrok_authtoken]); }
    if !settings.ngrok_region.is_empty() { command.args(["--region", settings.ngrok_region]); }
    if !domain.is_empty() { command.args(["--domain", domain]); }
    let child = command.stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?)).stderr(Stdio::from(log)).spawn().map_err(|e| format!("start ngrok: {e}"))?;
    fs::write(state_dir.join(format!("{safe}.pid")), child.id().to_string()).map_err(|e| e.to_string())?;
    for _ in 0..20 {
        thread::sleep(Duration::from_millis(250));
        if let Ok(response) = reqwest::blocking::get("http://127.0.0.1:4040/api/tunnels") {
            if let Ok(value) = response.json::<Value>() {
                if let Some(url) = value.get("tunnels").and_then(Value::as_array).and_then(|items| items.iter().find_map(|item| item.get("public_url").and_then(Value::as_str))) {
                    let mut result = OperationResult::message(format!("Public URL opened: {url}"));
                    result.repository_updates.insert("publicUrl".into(), json!(url));
                    result.repository_updates.insert("publicTunnelStatus".into(), json!("online"));
                    return Ok(result);
                }
            }
        }
    }
    Err(format!("ngrok started but no public URL was reported; inspect {}", log_path.display()))
}

fn stop_tunnel(settings: &CompiledEnvironment, project: &str) -> Result<OperationResult, String> {
    let pid_path = Path::new(settings.data_dir).join("ngrok").join(format!("{}.pid", safe_name(project)));
    if let Ok(pid) = fs::read_to_string(&pid_path) {
        let _ = command_output(Command::new("kill").arg(pid.trim()));
    }
    let _ = fs::remove_file(pid_path);
    let mut result = OperationResult::message("Public URL closed");
    result.repository_updates.insert("publicUrl".into(), json!(""));
    result.repository_updates.insert("publicUrls".into(), json!({}));
    result.repository_updates.insert("publicTunnels".into(), json!({}));
    result.repository_updates.insert("publicTunnelStatus".into(), json!("stopped"));
    Ok(result)
}

fn load_repository(client: &FirebaseClient, settings: &CompiledEnvironment, job: &Value) -> Result<Value, String> {
    let id = text(job, "repositoryId");
    if id.is_empty() { return Err("repositoryId is required".into()); }
    let repository = client.get(&format!("workspaces/{}/repositories/{id}", settings.workspace_id))?;
    if repository.is_null() { Err("repository no longer exists".into()) } else { Ok(repository) }
}

fn sync_repo(repository: &Value, path: &Path) -> Result<(), String> {
    let url = repo_url(repository)?;
    let branch = repository.get("branch").and_then(Value::as_str).unwrap_or("main");
    let output = if path.join(".git").exists() {
        command_output(Command::new("git").current_dir(path).args(["pull", "--ff-only", "origin", branch]))?
    } else {
        fs::create_dir_all(path.parent().unwrap_or(Path::new("/app/clones"))).map_err(|e| e.to_string())?;
        command_output(Command::new("git").args(["clone", "--branch", branch, "--single-branch", &url]).arg(path))?
    };
    if output.1 == 0 { Ok(()) } else { Err(format!("Git synchronization failed: {}", tail(&output.0, 1000))) }
}

fn repo_url(repository: &Value) -> Result<String, String> {
    ["cloneUrl", "repositoryUrl", "url"].iter().find_map(|key| repository.get(*key).and_then(Value::as_str)).filter(|v| !v.trim().is_empty()).map(str::to_string).ok_or_else(|| "repository URL is missing".into())
}

fn read_file_result(root: &Path, relative: &str, key: &str) -> Result<OperationResult, String> {
    let path = safe_child(root, relative)?;
    let content = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut result = OperationResult::message(format!("Read {relative}"));
    result.repository_updates.insert(key.into(), json!(content));
    Ok(result)
}

fn write_env(path: &Path, values: &HashMap<String, String>) -> Result<(), String> {
    let content = values.iter().map(|(key, value)| format!("{key}={}\n", value.replace('\n', "\\n"))).collect::<String>();
    fs::write(path.join(".env"), content).map_err(|e| format!("write deployment environment: {e}"))
}

fn repository_environment(repository: &Value) -> HashMap<String, String> {
    repository.get("environment").or_else(|| repository.get("environmentVariables")).and_then(Value::as_object).map(|map| map.iter().map(|(key, value)| (key.clone(), value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()))).collect()).unwrap_or_default()
}

fn ports(repository: &Value) -> Vec<String> {
    repository.get("ports").and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

fn resolve_container(job: &Value) -> Result<String, String> {
    let candidate = ["containerRef", "dockerId", "containerId"].iter().find_map(|key| job.get(*key).and_then(Value::as_str)).unwrap_or("").trim().to_string();
    if candidate.is_empty() { return Err("container reference is missing".into()); }
    let output = command_output(Command::new("docker").args(["inspect", "--format", "{{.Id}}", &candidate]))?;
    if output.1 != 0 { return Err(format!("container was not found: {candidate}")); }
    Ok(candidate)
}

fn ensure_not_worker(container: &str, action: &str) -> Result<(), String> {
    let output = command_output(Command::new("docker").args(["inspect", "--format", "{{.Name}} {{index .Config.Labels \"com.docker.compose.service\"}}", container]))?;
    let value = output.0.to_ascii_lowercase();
    if value.contains("worker") { Err(format!("{action} is disabled for worker containers")) } else { Ok(()) }
}

fn safe_child(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir)) { return Err(format!("unsafe relative path: {relative}")); }
    Ok(root.join(path))
}

fn safe_name(value: &str) -> String {
    let result: String = value.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    result.trim_matches('-').to_string()
}

fn text(value: &Value, key: &str) -> String { value.get(key).and_then(Value::as_str).unwrap_or("").to_string() }

fn run_shell(command: &str, cwd: &Path, environment: &HashMap<String, String>) -> Result<(String, i32), String> {
    command_output(Command::new("sh").current_dir(cwd).envs(environment).args(["-lc", command]))
}

fn command_output(command: &mut Command) -> Result<(String, i32), String> {
    let output = command.output().map_err(|e| format!("start command: {e}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok((text.trim().to_string(), output.status.code().unwrap_or(1)))
}

fn tail(value: &str, limit: usize) -> &str {
    if value.len() <= limit { return value; }
    let mut start = value.len() - limit;
    while !value.is_char_boundary(start) { start += 1; }
    &value[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_cannot_escape_repository() {
        assert!(safe_child(Path::new("/app/clones/repo"), "../secret").is_err());
        assert!(safe_child(Path::new("/app/clones/repo"), "/etc/passwd").is_err());
        assert_eq!(safe_child(Path::new("/app/clones/repo"), "deploy/Dockerfile").unwrap(), PathBuf::from("/app/clones/repo/deploy/Dockerfile"));
    }

    #[test]
    fn unicode_tail_does_not_split_codepoint() {
        assert_eq!(tail("áéíóú", 5), "óú");
    }
}
