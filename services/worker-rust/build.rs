use std::{collections::HashMap, env, fs, path::Path};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let values = read_environment("/run/secrets/worker_config");
    let configured = !values.is_empty();
    let source = format!(
        r#"pub fn compiled_environment() -> CompiledEnvironment {{
    CompiledEnvironment {{
        firebase_database_url: {database:?},
        service_account_json: {account:?},
        workspace_id: {workspace:?},
        pool_id: {pool:?},
        worker_id: {worker_id:?},
        worker_machine_id: {machine_id:?},
        worker_token: {worker_token:?},
        worker_label: {label:?},
        worker_location: {location:?},
        worker_shards: {shards},
        queue_shard_count: {queue_shards},
        max_concurrency: {concurrency},
        lease_seconds: {lease},
        poll_seconds: {poll},
        clone_dir: "/app/clones",
        data_dir: "/app/data",
        encryption_key: {encryption:?},
        ngrok_enabled: {ngrok_enabled},
        ngrok_authtoken: {ngrok_token:?},
        ngrok_bin: {ngrok_bin:?},
        ngrok_region: {ngrok_region:?},
        configured_at_build: {configured},
    }}
}}
"#,
        database = first(&values, &["FIREBASE_DATABASE_URL", "NEXT_PUBLIC_FIREBASE_DATABASE_URL"]),
        account = first(&values, &["FIREBASE_SERVICE_ACCOUNT_JSON"]),
        workspace = fallback(first(&values, &["WORKER_WORKSPACE_ID", "DEFAULT_WORKSPACE_ID"]), "default"),
        pool = fallback(first(&values, &["WORKER_RUST_POOL", "WORKER_POOL"]), "default"),
        worker_id = first(&values, &["WORKER_RUST_ID", "WORKER_ID"]),
        machine_id = first(&values, &["WORKER_RUST_MACHINE_ID", "WORKER_MACHINE_ID", "HOST_MACHINE_ID"]),
        worker_token = first(&values, &["WORKER_RUST_TOKEN", "WORKER_TOKEN"]),
        label = first(&values, &["WORKER_RUST_LABEL", "WORKER_LABEL"]),
        location = first(&values, &["WORKER_RUST_LOCATION", "WORKER_LOCATION"]),
        shards = rust_vec(first(&values, &["WORKER_RUST_SHARDS", "WORKER_SHARDS"])),
        queue_shards = integer(&values, &["QUEUE_SHARDS"], 16),
        concurrency = integer(&values, &["WORKER_RUST_MAX_CONCURRENCY", "WORKER_MAX_CONCURRENCY"], 2),
        lease = integer(&values, &["WORKER_RUST_LEASE_SECONDS", "WORKER_LEASE_SECONDS"], 90),
        poll = integer(&values, &["WORKER_RUST_POLL_SECONDS", "WORKER_POLL_SECONDS"], 5),
        encryption = first(&values, &["CREDENTIAL_ENCRYPTION_KEY"]),
        ngrok_enabled = boolean(first(&values, &["NGROK_RUST_ENABLED", "NGROK_ENABLED"]))
            || !first(&values, &["NGROK_RUST_AUTHTOKEN", "NGROK_AUTHTOKEN"]).is_empty(),
        ngrok_token = first(&values, &["NGROK_RUST_AUTHTOKEN", "NGROK_AUTHTOKEN"]),
        ngrok_bin = fallback(first(&values, &["NGROK_RUST_BIN", "NGROK_BIN"]), "ngrok"),
        ngrok_region = first(&values, &["NGROK_RUST_REGION", "NGROK_REGION"]),
    );
    let output = Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).join("environment_generated.rs");
    fs::write(output, source).expect("write compiled Rust environment");
}

fn read_environment(path: &str) -> HashMap<String, String> {
    let Ok(content) = fs::read_to_string(path) else { return HashMap::new() };
    content
        .lines()
        .filter_map(|raw| {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') { return None; }
            let (key, raw_value) = line.split_once('=')?;
            let mut value = raw_value.trim().to_string();
            if value.len() >= 2 {
                let bytes = value.as_bytes();
                if (bytes[0] == b'"' || bytes[0] == b'\'') && bytes[0] == bytes[value.len() - 1] {
                    value = value[1..value.len() - 1].to_string();
                }
            }
            Some((key.trim().to_string(), value))
        })
        .collect()
}

fn first(values: &HashMap<String, String>, keys: &[&str]) -> String {
    keys.iter().find_map(|key| values.get(*key).filter(|value| !value.trim().is_empty()).cloned()).unwrap_or_default()
}

fn fallback(value: String, default_value: &str) -> String {
    if value.trim().is_empty() { default_value.to_string() } else { value }
}

fn integer(values: &HashMap<String, String>, keys: &[&str], default_value: u64) -> u64 {
    first(values, keys).parse::<u64>().ok().filter(|value| *value > 0).unwrap_or(default_value)
}

fn boolean(value: String) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on" | "enabled")
}

fn rust_vec(value: String) -> String {
    let items: Vec<String> = value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| format!("{item:?}.to_string()"))
        .collect();
    if items.is_empty() {
        "Vec::new()".to_string()
    } else {
        format!("vec![{}]", items.join(", "))
    }
}
