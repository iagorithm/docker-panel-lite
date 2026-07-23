use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::{fs, io, path::Path, process::Command};

pub fn resolve_token(data_dir: &str, compiled: &str) -> io::Result<String> {
    if !compiled.trim().is_empty() {
        return Ok(compiled.trim().to_string());
    }
    fs::create_dir_all(data_dir)?;
    let path = Path::new(data_dir).join("worker-token");
    if let Ok(value) = fs::read_to_string(&path) {
        if !value.trim().is_empty() {
            return Ok(value.trim().to_string());
        }
    }
    let mut bytes = [0_u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);
    fs::write(path, format!("{token}\n"))?;
    Ok(token)
}

pub fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

pub fn resolve_worker_id(data_dir: &str, pool: &str, compiled_id: &str, compiled_machine: &str) -> io::Result<(String, String)> {
    if !compiled_id.trim().is_empty() {
        return Ok((compiled_id.trim().to_string(), "compiled".into()));
    }
    let fingerprint = if !compiled_machine.trim().is_empty() {
        Some((compiled_machine.trim().to_string(), "compiled".to_string()))
    } else {
        Command::new("docker").args(["info", "--format", "{{.ID}}|{{.Name}}"])
            .output().ok().filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|value| value.trim().to_string()).filter(|value| !value.is_empty() && value != "|")
            .map(|value| (value, "docker".to_string()))
            .or_else(|| fs::read_to_string("/etc/machine-id").ok().map(|value| (value.trim().to_string(), "machine-id".to_string())))
    };
    fs::create_dir_all(data_dir)?;
    let marker = Path::new(data_dir).join("worker-id");
    if let Some((fingerprint, source)) = fingerprint {
        let digest = format!("{:x}", Sha256::digest(fingerprint.as_bytes()));
        let safe_pool: String = pool.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
        let id = format!("worker-{}-{}", safe_pool.trim_matches('-'), &digest[..12]);
        fs::write(marker, format!("{id}\n"))?;
        return Ok((id, source));
    }
    if let Ok(saved) = fs::read_to_string(&marker) {
        if !saved.trim().is_empty() {
            return Ok((saved.trim().to_string(), "marker".into()));
        }
    }
    let mut bytes = [0_u8; 4];
    rand::thread_rng().fill_bytes(&mut bytes);
    let id = format!("worker-{}-{}", pool, bytes.iter().map(|v| format!("{v:02x}")).collect::<String>());
    fs::write(marker, format!("{id}\n"))?;
    Ok((id, "marker".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_sha256_hex() {
        assert_eq!(token_hash("worker-token").len(), 64);
    }
}
