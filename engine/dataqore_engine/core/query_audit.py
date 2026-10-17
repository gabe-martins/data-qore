"""Auditoria de consultas sem parâmetros, valores de linhas ou credenciais."""

from time import perf_counter


class RecordingCursor:
    def __init__(self, cursor, events):
        self._cursor, self._events, self._current = cursor, events, None

    def execute(self, sql, params=None):
        event = {"sql": sql, "parameter_count": len(params) if params is not None else 0,
                 "rows_fetched": 0, "status": "ok"}
        self._events.append(event)
        self._current = event
        start = perf_counter()
        try:
            return self._cursor.execute(sql) if params is None else self._cursor.execute(sql, params)
        except Exception as error:
            event.update(status="error", error_type=type(error).__name__)
            raise
        finally:
            event["execute_ms"] = round((perf_counter() - start) * 1000, 3)

    def _fetch(self, method, *args):
        rows = getattr(self._cursor, method)(*args)
        if self._current is not None:
            self._current["rows_fetched"] += int(rows is not None) if method == "fetchone" else len(rows)
        return rows

    def fetchone(self):
        return self._fetch("fetchone")

    def fetchmany(self, *args):
        return self._fetch("fetchmany", *args)

    def fetchall(self):
        return self._fetch("fetchall")

    def close(self):
        return self._cursor.close()

    def __getattr__(self, name):
        return getattr(self._cursor, name)


class RecordingConnection:
    def __init__(self, connection, events):
        self._connection, self._events = connection, events

    def cursor(self, *args, **kwargs):
        return RecordingCursor(self._connection.cursor(*args, **kwargs), self._events)

    def __getattr__(self, name):
        return getattr(self._connection, name)
