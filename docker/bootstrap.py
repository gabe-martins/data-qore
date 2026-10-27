"""Generate persistent configuration before PostgreSQL and application startup."""
import base64
import fcntl
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import quote
from zoneinfo import ZoneInfo
from configure import SECRET_KEYS, configuration


def validate(values):
    if not isinstance(values, dict) or any(not isinstance(values.get(k), str) or not values[k] for k in SECRET_KEYS):
        raise ValueError("Incomplete persisted configuration. Restore the original secrets before starting.")
    if any("\n" in values[k] or "\r" in values[k] or "\0" in values[k] for k in SECRET_KEYS):
        raise ValueError("Invalid persisted configuration.")
    for key in ("CONNECTIONS_ENCRYPTION_KEY", "EVIDENCE_ENCRYPTION_KEY"):
        if len(base64.b64decode(values[key], altchars=b"-_", validate=True)) != 32:
            raise ValueError("Invalid persisted encryption key.")
    identity = values["IDENTITY_ENCRYPTION_KEY"]
    decoded = base64.b64decode(identity + "=", altchars=b"-_", validate=True)
    if len(decoded) != 32 or base64.urlsafe_b64encode(decoded).decode().rstrip("=") != identity:
        raise ValueError("Invalid persisted identity encryption key.")
    if len(values["ENGINE_API_KEY"]) < 16 or len(values["JWT_SECRET"]) < 32:
        raise ValueError("Invalid persisted authentication secret.")


def private_file(path, text, owner=None):
    if path.is_symlink():
        raise ValueError("Configuration files must not be symbolic links.")
    fd, temporary = tempfile.mkstemp(prefix=".bootstrap-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        if owner is not None:
            os.chown(temporary, owner, owner)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def bootstrap(root=Path("/"), environment=None, ownership=True):
    env = os.environ if environment is None else environment
    ZoneInfo(env.get("TZ", "America/Sao_Paulo"))
    state = root / "state"
    if state.is_symlink():
        raise ValueError("The configuration directory must not be a symbolic link.")
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.chmod(0o700)
    with (state / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = state / "secrets.json"
        if path.is_symlink():
            raise ValueError("The persisted configuration must not be a symbolic link.")
        imported = {key: env[key] for key in SECRET_KEYS if env.get(key)}
        if path.exists():
            values = json.loads(path.read_text())
            validate(values)
            if any(values.get(k) != v for k, v in imported.items()):
                raise ValueError("Imported configuration differs from persisted secrets. Refusing rotation.")
            path.chmod(0o600)
        else:
            if imported and len(imported) != len(SECRET_KEYS):
                raise ValueError("Incomplete legacy configuration. Supply all original secrets before starting.")
            if not imported and (root / "database/PG_VERSION").exists():
                raise ValueError("Existing database found without its original configuration. Restore the original keys.")
            values = imported or {k: v for k, v in configuration("http://localhost:8080").items() if k in SECRET_KEYS}
            validate(values)
            private_file(path, json.dumps(values, sort_keys=True) + "\n")

        def url(role, password, database, driver="postgresql", schema=""):
            suffix = "?sslmode=disable" + (f"&schema={schema}" if schema else "")
            return f"{driver}://{role}:{quote(password, safe='')}@postgres:5432/{database}{suffix}"

        exports = {
            "postgres": {
                "postgres-password": values["POSTGRES_PASSWORD"],
                **{key: values[key] for key in ("APP_DB_PASSWORD", "ENGINE_DB_PASSWORD", "APP_MIGRATION_PASSWORD", "ENGINE_MIGRATION_PASSWORD")},
            },
            "controller": {"controller.env": {
                "DATABASE_URL": url("srv_dataqore_app", values["APP_DB_PASSWORD"], "dataqore_app", schema="app"),
                **{key: values[key] for key in ("ENGINE_API_KEY", "JWT_SECRET", "IDENTITY_ENCRYPTION_KEY")},
            }},
            "engine": {"engine.env": {
                "DATABASE_URL": url("srv_dataqore_engine", values["ENGINE_DB_PASSWORD"], "dataqore_engine", "postgresql+psycopg"),
                **{key: values[key] for key in ("ENGINE_API_KEY", "CONNECTIONS_ENCRYPTION_KEY", "EVIDENCE_ENCRYPTION_KEY")},
                "CONNECTIONS_ENCRYPTION_KEY_VERSION": "v1",
            }},
            "migrate": {"migrate.env": {
                "APP_MIGRATION_DATABASE_URL": url("srv_dataqore_app_migrator", values["APP_MIGRATION_PASSWORD"], "dataqore_app", schema="app"),
                "ENGINE_MIGRATION_DATABASE_URL": url("srv_dataqore_engine_migrator", values["ENGINE_MIGRATION_PASSWORD"], "dataqore_engine", "postgresql+psycopg"),
                **{key: values[key] for key in ("IDENTITY_ENCRYPTION_KEY", "CONNECTIONS_ENCRYPTION_KEY")},
            }},
        }
        for service, files in exports.items():
            directory = root / "exports" / service
            if directory.is_symlink():
                raise ValueError("Export directories must not be symbolic links.")
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            directory.chmod(0o700)
            owner = (999 if service == "postgres" else 1000) if ownership else None
            if owner is not None:
                os.chown(directory, owner, owner)
            for filename, content in files.items():
                text = "".join(f"{k}={json.dumps(v, ensure_ascii=False)}\n" for k, v in content.items()) if isinstance(content, dict) else content
                private_file(directory / filename, text, owner)
    return values


if __name__ == "__main__":
    try:
        bootstrap()
    except Exception:
        print("Bootstrap failed. Check persisted configuration, original keys, volume permissions and TZ.", flush=True)
        raise SystemExit(1) from None
    print("Persistent configuration ready. Secrets were not printed.", flush=True)
