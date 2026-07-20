from __future__ import annotations

import json

import firebase_admin
from firebase_admin import credentials, db


def initialize(database_url: str, service_account_json: str) -> None:
    if firebase_admin._apps:  # type: ignore[attr-defined]
        return
    credential = credentials.Certificate(json.loads(service_account_json)) if service_account_json else credentials.ApplicationDefault()
    firebase_admin.initialize_app(credential, {"databaseURL": database_url})


def reference(path: str = "/") -> db.Reference:
    return db.reference(path)
