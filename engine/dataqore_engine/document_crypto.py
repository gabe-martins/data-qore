"""Encrypt literal operands anywhere in persisted JSON, including frozen history."""
import base64
import json
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MARKER = '$dataqore_secret_v1'
LITERALS = frozenset({'value', 'values', 'allowed_values', 'examples', 'sample_rows'})

def is_envelope(value, purpose):
    return purpose in LITERALS and isinstance(value, dict) and set(value) == {MARKER} and isinstance(value[MARKER], str)

class DocumentCrypto:
    def __init__(self, master):
        Fernet(master.encode())  # Reject weak or malformed roots before any data can be rewritten.
        key = HKDF(algorithm=hashes.SHA256(), length=32, salt=b'dataqore.documents.v1',
                   info=b'json-literals').derive(base64.urlsafe_b64decode(master))
        self.cipher = Fernet(base64.urlsafe_b64encode(key))

    def protect(self, value):
        if isinstance(value, list): return [self.protect(v) for v in value]
        if not isinstance(value, dict): return value
        return {k: ({MARKER: self.cipher.encrypt(json.dumps({'purpose': k, 'value': v}, ensure_ascii=False,
                    allow_nan=False, separators=(',', ':')).encode()).decode()} if k in LITERALS and v is not None
                    else self.protect(v)) for k, v in value.items()}

    def reveal(self, value, purpose=None):
        if isinstance(value, list): return [self.reveal(v) for v in value]
        if not isinstance(value, dict): return value
        if is_envelope(value, purpose):
            try:
                if set(value) != {MARKER}: raise ValueError()
                payload = json.loads(self.cipher.decrypt(value[MARKER].encode()))
                if payload['purpose'] != purpose: raise ValueError()
                return payload['value']
            except (InvalidToken, ValueError, TypeError, KeyError, AttributeError):
                raise ValueError('Sensitive document cannot be decrypted with the configured key.') from None
        return {k: self.reveal(v, k) for k, v in value.items()}

    def dumps(self, value):
        from .storage import json_safe
        return json.dumps(self.protect(json_safe(value)), allow_nan=False)

    def loads(self, value): return self.reveal(json.loads(value))
