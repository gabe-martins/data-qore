"""Bounded, encrypted sample evidence. Never reads source databases."""
import base64
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
import hashlib
import hmac
import json
from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select, text

from . import models as m
from .core.quality import UnavailableValue, metadata_family, value_token
from .core.sampling import canonical_key
from .storage import DomainError, json_safe

MAX_POSITIONS = 10_000
MAX_BYTES = 32 * 1024 * 1024
RETENTION_DAYS = 30


def key_digest(secret, run_id, values, metadata):
    token = canonical_key(values, metadata)
    return hmac.new(base64.urlsafe_b64decode(secret), b"record-key-v1:" + str(run_id).encode() + b":" + token, hashlib.sha256).hexdigest()


def cell(value, info, present=True):
    if not present:
        return {"kind": "missing", "raw": None, "type": info.get("type")}
    if value is None:
        return {"kind": "null", "raw": None, "type": info.get("type")}
    token = value_token(value, info)
    if isinstance(value, UnavailableValue) or token[0] in {"unsupported", "unavailable", "nonfinite"}:
        return {"kind": "unavailable", "raw": None, "type": info.get("type")}
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = base64.b64encode(bytes(value)).decode()
    elif isinstance(value, (Decimal, int, float)) and not isinstance(value, bool):
        raw = str(value)  # Preserve numbers beyond JavaScript's precision.
    elif isinstance(value,(dict,list,tuple)):
        raw = json.dumps(json_safe(value),ensure_ascii=False,allow_nan=False)
    else:
        raw = json_safe(value)
    normalized = None
    if token[0] in {"datetime", "time", "date", "number", "uuid"}:
        normalized = str(token[-1])
        if token[0] in {"datetime", "time"} and token[1] == "aware":
            normalized += "Z"
    return {"kind": "value", "raw": raw, "normalized": normalized,
            "type": info.get("type"), "family": metadata_family(info)}


class EvidenceCapture:
    def __init__(self, secret, run_id, max_bytes=MAX_BYTES, max_positions=MAX_POSITIONS):
        self.secret = secret
        self.run_id = str(run_id)
        self.cipher = Fernet(secret.encode()) if secret else None
        self.rows = []
        self.bytes = 0
        self.max_bytes = min(max_bytes, MAX_BYTES)
        self.max_positions = min(max_positions, MAX_POSITIONS)
        self.limited = False

    def capture(self, values, key_metadata, state, cells):
        if not self.cipher:
            return
        if len(self.rows) >= self.max_positions:
            self.limited = True
            return
        ordinal = len(self.rows)
        payload = {"run_id": self.run_id, "ordinal": ordinal,
                   "key": [cell(v, info) for v, info in zip(values, key_metadata)], "cells": cells}
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
        if self.bytes + len(encoded) > self.max_bytes:
            self.limited = True
            return
        affected = [c["id"] for c in cells if c["status"] != "equal"]
        self.rows.append({"run_id": self.run_id, "ordinal": ordinal, "state": state,
                          "affected_columns": affected,
                          "key_digest": key_digest(self.secret, self.run_id, values, key_metadata),
                          "payload_ciphertext": self.cipher.encrypt(encoded).decode()})
        self.bytes += len(encoded)

    def manifest(self, selected, valid, finished_at):
        reason = "encryption_key_unavailable" if not self.cipher else "alignment_unavailable" if not valid else "capture_budget_exceeded" if self.limited else None
        return {"status": "unavailable" if reason and reason != "capture_budget_exceeded" else "partial" if self.limited else "available",
                "reason": reason, "selected_positions": selected, "stored_positions": len(self.rows),
                "serialized_bytes": self.bytes, "max_bytes": self.max_bytes, "max_positions": self.max_positions,
                "expires_at": (datetime.fromisoformat(finished_at) + timedelta(days=RETENTION_DAYS)).isoformat(),
                "retention_days": RETENTION_DAYS, "scope": "selected_key_sample", "key_version": "v1"}


def evidence_state(result, at=None):
    value = dict(result.get("evidence") or {"status": "not_captured", "reason": "historical_result_without_evidence", "stored_positions": 0})
    if value.get("status") in {"available","partial"} and value.get("expires_at") and datetime.fromisoformat(value["expires_at"]) <= (at or datetime.now(timezone.utc)):
        value.update(status="expired", reason="retention_elapsed")
    return value


def decrypt_row(secret, row):
    try:
        payload = json.loads(Fernet(secret.encode()).decrypt(row["payload_ciphertext"].encode()))
        if payload["run_id"] != str(row["run_id"]) or payload["ordinal"] != row["ordinal"]:
            raise ValueError()
        return payload
    except (InvalidToken, ValueError, KeyError, TypeError):
        raise DomainError(503, "evidence_unavailable", "Record evidence cannot be decrypted with the configured key.") from None


def purge_expired(engine):
    """One bounded batch; API expiry is enforced independently of maintenance."""
    with engine.begin() as conn:
        return conn.execute(text("""DELETE FROM engine.run_record_evidence
            WHERE (run_id,ordinal) IN (SELECT run_id,ordinal FROM engine.run_record_evidence
            WHERE expires_at <= now() ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)""")).rowcount
