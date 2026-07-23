mod environment;
mod identity;

use environment::{compiled_environment, validate};

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
    let _token_hash = identity::token_hash(&token);
    eprintln!("Rust worker bootstrap is configured, but queue execution is not enabled yet.");
    std::process::exit(2);
}
