"""One-shot migrations. Never load local or runtime service credentials."""
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.migrations import main


def migrate():
    os.environ["DATAQORE_ENV_FILE"] = "/dev/null"
    for service in ("app", "engine"):
        os.environ["MIGRATION_DATABASE_URL"] = os.environ[f"{service.upper()}_MIGRATION_DATABASE_URL"]
        for action in ("apply", "verify"):
            sys.argv = ["migrations.py", service, action]
            if main():
                return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(migrate())
