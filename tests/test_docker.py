"""Docker configuration safety and new-database bootstrap on disposable PostgreSQL."""
import base64
import importlib.util
import os
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("docker_configure", ROOT / "docker/configure.py")
configure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configure)


class DockerConfigurationTests(unittest.TestCase):
    def test_private_configuration_generates_independent_secrets_and_preserves_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env.docker"
            self.assertTrue(configure.prepare(path, "http://192.168.1.50:8080"))
            original = path.read_bytes()
            values = dict(line.split("=", 1) for line in original.decode().splitlines() if not line.startswith("#"))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(values["WEB_PORT"], "8080")
            passwords = [v for k, v in values.items() if "PASSWORD" in k]
            self.assertEqual(len(passwords), len(set(passwords)))
            for name in ("CONNECTIONS_ENCRYPTION_KEY", "EVIDENCE_ENCRYPTION_KEY"):
                self.assertEqual(len(base64.urlsafe_b64decode(values[name])), 32)
            self.assertFalse(configure.prepare(path, "http://other-server:9000"))
            self.assertEqual(path.read_bytes(), original)

    def test_invalid_origin_never_creates_configuration(self):
        for origin in ("https://server:8080", "http://server:0", "http://server:65536", "http://server/",
                       "http://user:password@server", "http://server?x=1", "http://server:80", "http://server:",
                       "http://server:08080", "http://ser ver", "http://$HOST:8080"):
            with self.subTest(origin=origin), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / ".env.docker"
                with self.assertRaises(ValueError):
                    configure.prepare(path, origin)
                self.assertFalse(path.exists())

    def test_configuration_refuses_symlinks_without_touching_target(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "original"
            target.write_text("existing-private-config")
            path = Path(directory) / ".env.docker"
            path.symlink_to(target)
            with self.assertRaises(ValueError):
                configure.prepare(path, "http://server:8080")
            self.assertEqual(target.read_text(), "existing-private-config")

    @unittest.skipUnless(os.environ.get("DATAQORE_COMPOSE_BIN"), "Requires a Docker Compose CLI (no daemon needed)")
    def test_compose_publishes_only_web_and_keeps_migrator_secrets_out_of_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env.docker"
            configure.prepare(path, "http://192.168.1.50:8080")
            result = subprocess.run([os.environ["DATAQORE_COMPOSE_BIN"], "--env-file", str(path),
                                     "-f", str(ROOT / "compose.yaml"), "config", "--format", "json"],
                                    check=True, capture_output=True, text=True)
            services = json.loads(result.stdout)["services"]
            self.assertEqual(set(services), {"web", "controller", "engine", "worker", "postgres", "migrate"})
            for name, service in services.items():
                if name == "web":
                    self.assertEqual(len(service["ports"]), 1)
                    self.assertEqual(service["ports"][0]["published"], "8080")
                else:
                    self.assertFalse(service.get("ports"))
                if name in ("controller", "engine", "worker"):
                    self.assertNotIn("MIGRATION_DATABASE_URL", service["environment"])
                    self.assertFalse(any("MIGRATION" in k or k == "POSTGRES_PASSWORD" for k in service["environment"]))
                    self.assertEqual(service["depends_on"]["migrate"]["condition"], "service_completed_successfully")


if os.environ.get("DATAQORE_PG_BIN"):
    from postgres_fixture import TemporaryPostgres

    class DockerBootstrapTests(TemporaryPostgres):
        def setUp(self):
            # These tests exercise a blank installation, unlike the legacy fixture.
            for service in ("app", "engine"):
                with self.connect(service) as connection:
                    connection.execute(f"DROP SCHEMA IF EXISTS {service} CASCADE")

        def test_new_database_passwords_migrations_and_repeat_start(self):
            environment = {**os.environ, "PGHOST": "127.0.0.1", "PGPORT": str(self.port), "POSTGRES_USER": "postgres"}
            passwords = {"APP_DB_PASSWORD": "app-'quoted-password", "ENGINE_DB_PASSWORD": "engine-secret",
                         "APP_MIGRATION_PASSWORD": "app-migrator-secret", "ENGINE_MIGRATION_PASSWORD": "engine-migrator-secret"}
            environment.update(passwords)
            # Provisioning 00/05 is already performed by TemporaryPostgres. Execute
            # the exact password block of the container entrypoint through psql.
            script = (ROOT / "docker/init-db.sh").read_text().split("<<'SQL'\n", 1)[1].rsplit("\nSQL", 1)[0]
            subprocess.run([str(self.bin / "psql"), "-X", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
                           input=script, text=True, env=environment, check=True, capture_output=True)
            for service in ("app", "engine"):
                environment[f"{service.upper()}_MIGRATION_DATABASE_URL"] = (
                    f"postgresql://srv_dataqore_{service}_migrator:{passwords[service.upper()+'_MIGRATION_PASSWORD']}"
                    f"@127.0.0.1:{self.port}/dataqore_{service}")
            for _ in range(2):
                result = subprocess.run([sys.executable, str(ROOT / "docker/migrate.py")],
                                        env=environment, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            with self.connect("app") as connection:
                self.assertTrue(connection.execute("SELECT count(*) > 0 FROM app._prisma_migrations").fetchone()[0])
                self.assertFalse(connection.execute("SELECT has_table_privilege('srv_dataqore_app','app._prisma_migrations','SELECT')").fetchone()[0])
            with self.connect("engine") as connection:
                self.assertEqual(connection.execute("SELECT version_num FROM engine.alembic_version").fetchone()[0], "0006_record_evidence")
                self.assertFalse(connection.execute("SELECT has_table_privilege('srv_dataqore_engine','engine.alembic_version','SELECT')").fetchone()[0])
                # The worker healthcheck must observe leadership without taking it.
                health_env = {**environment, "DATABASE_URL": f"postgresql://srv_dataqore_engine:{passwords['ENGINE_DB_PASSWORD']}@127.0.0.1:{self.port}/dataqore_engine"}
                def health():
                    return subprocess.run([sys.executable, str(ROOT / "docker/worker-health.py")], env=health_env, capture_output=True).returncode
                self.assertEqual(health(), 1)
                connection.execute("SELECT pg_advisory_lock(80419,1)")
                try:
                    self.assertEqual(health(), 0)
                finally:
                    connection.execute("SELECT pg_advisory_unlock(80419,1)")
                self.assertEqual(health(), 1)

        def test_migration_failure_does_not_continue_to_next_database(self):
            environment = {**os.environ, "APP_MIGRATION_DATABASE_URL": f"postgresql://srv_dataqore_engine_migrator@127.0.0.1:{self.port}/dataqore_app",
                           "ENGINE_MIGRATION_DATABASE_URL": f"postgresql://srv_dataqore_engine_migrator@127.0.0.1:{self.port}/dataqore_engine"}
            result = subprocess.run([sys.executable, str(ROOT / "docker/migrate.py")], env=environment, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            with self.connect("engine") as connection:
                self.assertIsNone(connection.execute("SELECT to_regclass('engine.alembic_version')").fetchone()[0])


if __name__ == "__main__":
    unittest.main()
