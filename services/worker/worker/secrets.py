from __future__ import annotations

import base64

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def decrypt_secret(value: dict, encoded_key: str) -> str:
    if value.get("algorithm") != "aes-256-gcm" or value.get("version") != 1:
        raise ValueError("Unsupported credential encryption format")
    key = base64.b64decode(encoded_key, validate=True)
    if len(key) != 32:
        raise ValueError("CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes")
    iv = base64.b64decode(value["iv"])
    ciphertext = base64.b64decode(value["ciphertext"])
    tag = base64.b64decode(value["tag"])
    return AESGCM(key).decrypt(iv, ciphertext + tag, None).decode("utf-8")
