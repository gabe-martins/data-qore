"""Prepare a private Compose configuration, without changing existing secrets."""
import argparse
import base64
import os
from pathlib import Path
import secrets
from urllib.parse import urlsplit

SECRET_KEYS = (
    "POSTGRES_PASSWORD", "APP_DB_PASSWORD", "ENGINE_DB_PASSWORD",
    "APP_MIGRATION_PASSWORD", "ENGINE_MIGRATION_PASSWORD", "ENGINE_API_KEY", "JWT_SECRET",
    "IDENTITY_ENCRYPTION_KEY", "CONNECTIONS_ENCRYPTION_KEY", "EVIDENCE_ENCRYPTION_KEY",
)


def configuration(origin):
    url = urlsplit(origin)
    try:
        port = url.port if url.port is not None else 80
    except ValueError:
        raise ValueError("Porta HTTP inválida.") from None
    host = url.hostname or ""
    authority = f"[{host}]" if ":" in host else host
    canonical = f"http://{authority}" + (f":{port}" if port != 80 else "")
    if (url.scheme != "http" or not url.hostname or url.username or url.password
            or url.path or url.query or url.fragment or any(c.isspace() for c in origin)
            or any(c in origin for c in "$#'\"\\") or not 1 <= port <= 65535
            or origin != canonical):
        raise ValueError("Use a origem HTTP exata, sem barra final; omita :80. Exemplo: http://192.168.1.50:8080")
    result = {
        "COMPOSE_PROJECT_NAME": "dataqore",
        "WEB_ORIGIN": origin,
        "WEB_PORT": str(port),
        "WEB_BIND_ADDRESS": "0.0.0.0",
    }
    for key in ("POSTGRES_PASSWORD", "APP_DB_PASSWORD", "ENGINE_DB_PASSWORD",
                "APP_MIGRATION_PASSWORD", "ENGINE_MIGRATION_PASSWORD", "ENGINE_API_KEY", "JWT_SECRET"):
        result[key] = secrets.token_hex(32)
    result["IDENTITY_ENCRYPTION_KEY"] = secrets.token_urlsafe(32)
    for key in ("CONNECTIONS_ENCRYPTION_KEY", "EVIDENCE_ENCRYPTION_KEY"):
        result[key] = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
    return result


def prepare(path, origin):
    values = configuration(origin)
    # Exclusive creation also protects against two concurrent setup commands.
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if path.is_symlink() or not path.is_file():
            raise ValueError("O caminho de configuração deve ser um arquivo regular.") from None
        path.chmod(0o600)
        return False
    with os.fdopen(fd, "w") as stream:
        stream.write("# Private DataQore Docker configuration. Back up with the database.\n")
        stream.writelines(f"{key}={value}\n" for key, value in values.items())
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--output", type=Path, default=Path(".env.docker"))
    args = parser.parse_args()
    try:
        created = prepare(args.output, args.origin)
    except (ValueError, OSError) as error:
        parser.exit(1, f"Configuração recusada: {error}\n")
    print("Configuração criada; segredos não exibidos." if created else
          "Configuração existente preservada. Para mudar o endereço, edite WEB_ORIGIN e WEB_PORT nesse arquivo.")


if __name__ == "__main__":
    main()
