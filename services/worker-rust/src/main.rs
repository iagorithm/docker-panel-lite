mod environment;
mod firebase;
mod heartbeat;
mod identity;
mod operations;
mod queue;

use environment::{compiled_environment, validate};
use firebase::FirebaseClient;
use heartbeat::{now_millis, Heartbeat};
use queue::QueueRunner;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn main() {
    let settings = compiled_environment();
    if let Err(error) = validate(&settings) {
        eprintln!("load settings: {error}");
        std::process::exit(1);
    }
    if std::env::args().nth(1).as_deref() == Some("--check-config") {
        println!(
            "Compiled Rust worker configuration is valid: workspace={} pool={} shards={}",
            settings.workspace_id, settings.pool_id, settings.queue_shard_count
        );
        return;
    }

    let token = identity::resolve_token(settings.data_dir, settings.worker_token)
        .unwrap_or_else(|error| panic!("resolve worker token: {error}"));
    let token_hash = identity::token_hash(&token);
    let (worker_id, identity_source) = identity::resolve_worker_id(
        settings.data_dir,
        settings.pool_id,
        settings.worker_id,
        settings.worker_machine_id,
    ).unwrap_or_else(|error| panic!("resolve worker identity: {error}"));
    let client = FirebaseClient::new(settings.firebase_database_url, settings.service_account_json)
        .unwrap_or_else(|error| panic!("initialize Firebase: {error}"));
    let label = if settings.worker_label.trim().is_empty() { "Rust" } else { settings.worker_label };
    let heartbeat = Heartbeat {
        client: &client,
        settings: &settings,
        worker_id: &worker_id,
        identity_source: &identity_source,
        token_hash: &token_hash,
        label,
        started_at: now_millis(),
    };
    let running = Arc::new(AtomicBool::new(true));
    let signal = Arc::clone(&running);
    ctrlc::set_handler(move || signal.store(false, Ordering::SeqCst))
        .unwrap_or_else(|error| panic!("install signal handler: {error}"));
    heartbeat.send("online", 0).unwrap_or_else(|error| panic!("initial heartbeat: {error}"));
    if let Err(error) = operations::publish_container_inventory(&client, &settings, &worker_id) {
        eprintln!("initial container inventory failed: {error}");
    }
    println!("Rust worker {worker_id} ({label}) online pool={}", settings.pool_id);
    QueueRunner::new(&client, &settings, &heartbeat, &worker_id).run(&running);
    let _ = heartbeat.send("offline", 0);
    println!("Rust worker {worker_id} stopped");
}
