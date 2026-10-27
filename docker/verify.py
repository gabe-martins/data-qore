"""Read-only runtime smoke check. Never connects to a registered data source."""
import importlib
import json
import re
import urllib.request

for module in ("psycopg", "sqlite3", "pymysql", "oracledb", "mssql_python", "databricks.sql"):
    importlib.import_module(module)
print("Clients PostgreSQL, SQLite, MySQL, Oracle, SQL Server and Databricks imported.")

for service, port in (("engine", 8000), ("controller", 3000)):
    with urllib.request.urlopen(f"http://{service}:{port}/health/ready", timeout=10) as response:
        if json.load(response).get("status") != "ok":
            raise SystemExit(f"{service} is not ready")

web = "http://web:8080"
with urllib.request.urlopen(web + "/health/live", timeout=10) as response:
    if response.read() != b"ok":
        raise SystemExit("Web healthcheck failed")
for route in ("/", "/comparisons"):
    with urllib.request.urlopen(web + route, timeout=10) as response:
        html = response.read().decode()
    if '<div id="root">' not in html:
        raise SystemExit("SPA route did not return the built application")
    scripts = re.findall(r'<script[^>]+src="([^"]+)"', html)
    if not scripts:
        raise SystemExit("Built application scripts missing")
    for script in scripts:
        with urllib.request.urlopen(web + script, timeout=10) as response:
            if "javascript" not in response.headers.get("Content-Type", ""):
                raise SystemExit("JavaScript asset returned an unexpected content type")
with urllib.request.urlopen(web + "/api/openapi.json", timeout=10) as response:
    if "openapi" not in json.load(response):
        raise SystemExit("Nginx API proxy failed")
print("Engine, controller, built web assets, SPA routes and API proxy verified.")
