#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct CompiledEnvironment {
    pub firebase_database_url: &'static str,
    pub service_account_json: &'static str,
    pub workspace_id: &'static str,
    pub pool_id: &'static str,
    pub worker_id: &'static str,
    pub worker_machine_id: &'static str,
    pub worker_token: &'static str,
    pub worker_label: &'static str,
    pub worker_location: &'static str,
    pub worker_shards: Vec<String>,
    pub queue_shard_count: u64,
    pub max_concurrency: u64,
    pub lease_seconds: u64,
    pub poll_seconds: u64,
    pub clone_dir: &'static str,
    pub data_dir: &'static str,
    pub encryption_key: &'static str,
    pub ngrok_enabled: bool,
    pub ngrok_authtoken: &'static str,
    pub ngrok_bin: &'static str,
    pub ngrok_region: &'static str,
    pub configured_at_build: bool,
}

include!(concat!(env!("OUT_DIR"), "/environment_generated.rs"));

pub fn validate(environment: &CompiledEnvironment) -> Result<(), String> {
    if environment.firebase_database_url.trim().is_empty() {
        return Err("FirebaseDatabaseURL is empty in the compiled Rust environment".into());
    }
    if environment.service_account_json.trim().is_empty() {
        return Err("ServiceAccountJSON is empty in the compiled Rust environment".into());
    }
    let account: serde_json::Value = serde_json::from_str(environment.service_account_json)
        .map_err(|error| format!("ServiceAccountJSON is invalid: {error}"))?;
    if account.get("client_email").and_then(|value| value.as_str()).unwrap_or("").is_empty()
        || account.get("private_key").and_then(|value| value.as_str()).unwrap_or("").is_empty()
    {
        return Err("ServiceAccountJSON must include client_email and private_key".into());
    }
    if environment.encryption_key.trim().is_empty() {
        return Err("EncryptionKey is empty in the compiled Rust environment".into());
    }
    Ok(())
}
