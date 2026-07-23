use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::{fs, io, path::Path};

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_sha256_hex() {
        assert_eq!(token_hash("worker-token").len(), 64);
    }
}
