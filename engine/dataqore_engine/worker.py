"""Worker único com subprocessos supervisionados, heartbeat e timeout."""
import logging
import multiprocessing
import signal
import time

from sqlalchemy import text

from .jobs import Queue,run_job
from .settings import load_settings
from .storage import DomainError,database_engine

logger=logging.getLogger("dataqore.worker")


class Worker:
    def __init__(self,settings):
        self.settings=settings
        self.engine=database_engine(settings)
        self.queue=Queue(self.engine)
        self.leader=None
        self.stopping=False
        self.child=None

    def __enter__(self):
        self.leader=self.engine.connect().execution_options(isolation_level="AUTOCOMMIT")
        try:
            if not self.leader.scalar(text("SELECT pg_try_advisory_lock(80419,1)")):
                raise DomainError(409,"worker_already_running","Já existe um worker ativo.")
            self.queue.recover_interrupted()
        except BaseException:
            self.leader.close()
            self.leader=None
            self.engine.dispose()
            raise
        return self

    def stop(self,*_):
        self.stopping=True

    def process_one(self,target=run_job):
        if self.leader is None:
            raise RuntimeError("O worker precisa adquirir a liderança antes de executar jobs.")
        # Falha da sessão que mantém o lock encerra o worker antes de coletar outro job.
        self.leader.execute(text("SELECT 1"))
        identifier=self.queue.claim()
        if identifier is None:
            return False
        self.child=multiprocessing.get_context("spawn").Process(target=target,args=(self.settings,identifier))
        start=time.monotonic()
        try:
            self.child.start()
            while self.child.is_alive():
                self.child.join(timeout=min(self.settings.heartbeat_seconds,0.25))
                if self.stopping or time.monotonic()-start>=self.settings.job_timeout_seconds:
                    self._terminate_child()
                    self.queue.fail(identifier,"worker_stopped" if self.stopping else "execution_timeout")
                    break
                self.leader.execute(text("SELECT 1"))
                if time.monotonic()-getattr(self,"_heartbeat",0)>=self.settings.heartbeat_seconds:
                    self.queue.heartbeat(identifier)
                    self._heartbeat=time.monotonic()
            # Não sobrescreve um resultado concluído ou uma falha específica.
            self.queue.fail(identifier,"worker_process_exited")
        except BaseException:
            self._terminate_child()
            try:
                self.queue.fail(identifier,"worker_interrupted")
            finally:
                raise
        finally:
            self._terminate_child()
            self.child=None
        return True

    def _terminate_child(self):
        if self.child is not None and self.child.pid is not None:
            if self.child.is_alive():
                self.child.terminate()
                self.child.join(timeout=2)
            if self.child.is_alive():
                self.child.kill()
            self.child.join(timeout=2)

    def __exit__(self,*_):
        self._terminate_child()
        try:
            if self.leader is not None:
                try:
                    self.leader.execute(text("SELECT pg_advisory_unlock(80419,1)"))
                finally:
                    self.leader.close()
        finally:
            self.engine.dispose()

    def run_forever(self):
        while not self.stopping:
            if not self.process_one():
                time.sleep(self.settings.poll_seconds)


def main():
    logging.basicConfig(level=logging.INFO,format="%(name)s %(levelname)s %(message)s")
    try:
        with Worker(load_settings()) as worker:
            signal.signal(signal.SIGTERM,worker.stop)
            signal.signal(signal.SIGINT,worker.stop)
            worker.run_forever()
    except Exception:
        logger.error("Worker encerrado; confira configuração e acesso ao Postgres.")
        return 1
    return 0


if __name__=="__main__":
    raise SystemExit(main())
