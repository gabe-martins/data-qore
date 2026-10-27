"""One-command Compose bootstrap: persisted keys, isolated exports and first user."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "docker"))
from bootstrap import bootstrap
from configure import SECRET_KEYS, configuration


class ComposeBootstrapTests(unittest.TestCase):
    def test_generate_once_restore_exports_and_share_only_required_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = bootstrap(root, {"TZ": "America/Sao_Paulo"}, False)
            master = (root / "state/secrets.json").read_bytes()
            engine = root / "exports/engine/engine.env"
            engine.unlink()
            second = bootstrap(root, {"TZ": "Etc/UTC"}, False)
            self.assertEqual(first, second)
            self.assertEqual((root / "state/secrets.json").read_bytes(), master)
            self.assertTrue(engine.exists())
            for service in ("controller", "engine"):
                text = (root / f"exports/{service}/{service}.env").read_text()
                self.assertNotIn("MIGRATION", text)
                self.assertNotIn(first["POSTGRES_PASSWORD"], text)
                self.assertNotIn(first["APP_MIGRATION_PASSWORD"], text)
                self.assertNotIn(first["ENGINE_MIGRATION_PASSWORD"], text)
            self.assertNotIn(first["IDENTITY_ENCRYPTION_KEY"], engine.read_text())
            for path in root.rglob("*"):
                if path.is_file() and path.name != ".lock":
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_concurrent_bootstrap_reuses_the_same_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _: bootstrap(Path(directory), {}, False), range(4)))
            self.assertTrue(all(result == results[0] for result in results))

    def test_import_legacy_secrets_and_url_encode_database_passwords(self):
        with tempfile.TemporaryDirectory() as directory:
            original = {k: v for k, v in configuration("http://server:8080").items() if k in SECRET_KEYS}
            original["APP_DB_PASSWORD"] = "original-'special#$password"
            values = bootstrap(Path(directory), original, False)
            self.assertEqual(values, original)
            text = (Path(directory) / "exports/controller/controller.env").read_text()
            url = json.loads(text.splitlines()[0].split("=", 1)[1])
            self.assertEqual(unquote(urlsplit(url).password), original["APP_DB_PASSWORD"])
            with self.assertRaises(ValueError):
                bootstrap(Path(directory), {**original, "JWT_SECRET": "different-existing-secret"}, False)
            self.assertEqual(json.loads((Path(directory) / "state/secrets.json").read_text()), original)

    def test_missing_or_corrupt_original_configuration_never_rotates_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                bootstrap(root, {"ENGINE_API_KEY": "only-one-key"}, False)
            self.assertFalse((root / "state/secrets.json").exists())
            bootstrap(root, {}, False)
            path = root / "state/secrets.json"
            path.write_text("broken-original-file")
            with self.assertRaises(ValueError):
                bootstrap(root, {}, False)
            self.assertEqual(path.read_text(), "broken-original-file")

    def test_invalid_timezone_fails_before_generating_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(Exception):
                bootstrap(Path(directory), {"TZ": "Invalid/Timezone"}, False)
            self.assertFalse((Path(directory) / "state/secrets.json").exists())

    def test_existing_database_without_original_keys_does_not_generate_replacements(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "database").mkdir()
            (root / "database/PG_VERSION").write_text("16\n")
            with self.assertRaises(ValueError):
                bootstrap(root, {}, False)
            self.assertFalse((root / "state/secrets.json").exists())

    def test_invalid_imported_identity_key_fails_without_writing_master_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            original = {k: v for k, v in configuration("http://server:8080").items() if k in SECRET_KEYS}
            original["IDENTITY_ENCRYPTION_KEY"] = "invalid-original-key"
            with self.assertRaises(ValueError):
                bootstrap(Path(directory), original, False)
            self.assertFalse((Path(directory) / "state/secrets.json").exists())

    @unittest.skipUnless(os.environ.get("DATAQORE_COMPOSE_BIN"), "Requires standalone Compose CLI")
    def test_compose_loads_without_env_file_and_applies_timezone_to_every_service(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([os.environ["DATAQORE_COMPOSE_BIN"], "--project-directory", directory,
                "-f", str(ROOT / "compose.yaml"), "config", "--format", "json"], check=True, capture_output=True, text=True)
            services = json.loads(result.stdout)["services"]
            self.assertEqual(set(services), {"bootstrap", "postgres", "migrate", "controller", "engine", "worker", "web"})
            for name, service in services.items():
                self.assertEqual(service["environment"]["TZ"], "America/Sao_Paulo")
                self.assertFalse(any(k in SECRET_KEYS for k in service["environment"]))
                if name != "web":
                    self.assertFalse(service.get("ports"))
            self.assertEqual(services["postgres"]["depends_on"]["bootstrap"]["condition"], "service_completed_successfully")
            self.assertEqual(services["controller"]["depends_on"]["migrate"]["condition"], "service_completed_successfully")
            self.assertEqual(services["web"]["ports"][0]["host_ip"], "0.0.0.0")
            for name in ("controller", "engine", "worker"):
                configs = [v for v in services[name]["volumes"] if v["target"] == "/config"]
                self.assertEqual(len(configs), 1)
                self.assertTrue(configs[0]["read_only"])


if os.environ.get("DATAQORE_PG_BIN"):
    from postgres_fixture import TemporaryPostgres

    class FirstVisitorTests(TemporaryPostgres):
        def test_initial_setup_against_disposable_database(self):
            self.command("app", "baseline")
            self.command("app", "apply")
            environment = {**os.environ, "DATAQORE_ENV_FILE": "/dev/null", "DATAQORE_FIRST_RUN_TEST": "1",
                "DATABASE_URL": f"postgresql://srv_dataqore_app@127.0.0.1:{self.port}/dataqore_app",
                "ENGINE_API_URL": "http://127.0.0.1:8000", "ENGINE_API_KEY": "first-visitor-isolated-api-key",
                "JWT_SECRET": "first-visitor-isolated-jwt-secret-of-32-characters", "WEB_ORIGIN": "http://127.0.0.1:8080"}
            result = subprocess.run(["node", "--import", "tsx", "--test", "tests/initial-setup.test.ts"],
                cwd=ROOT / "controller", env=environment, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
