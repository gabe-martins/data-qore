"""Enabled exclusively by the disposable full-stack fixture's PYTHONPATH."""
import os
if os.environ.get('DATAQORE_ISOLATED_TEST')=='1' and os.environ.get('DATAQORE_DATABRICKS_STUB_ROOT'):
    from databricks_stub import connect
    from dataqore_engine.connectors import PLUGINS,Plugin
    PLUGINS['databricks']=Plugin('sqlite3',connect)
