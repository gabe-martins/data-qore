"""Launcher safety tests: only disposable local processes, no personal database."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('local_app',Path(__file__).resolve().parents[1]/'tools/local_app.py')
launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='dataqore-launcher-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name)
        for name in ('run','logs'):(self.root/name).mkdir()
        self.state_patch=patch.object(launcher,'STATE',self.root);self.state_patch.start();self.addCleanup(self.state_patch.stop)

    def launch(self):
        command=[sys.executable,'-c','import time;time.sleep(120)']
        p=subprocess.Popen(command,cwd=self.root,start_new_session=True)
        self.addCleanup(lambda:p.poll() is None and (p.kill(),p.wait()))
        for _ in range(50):
            info=launcher.process_info(p.pid)
            if info and info['command']==[os.fsencode(s) for s in command]:break
            time.sleep(.01)
        self.service_patch=patch.object(launcher,'SERVICES',{'test':(self.root,command,None,None,None)})
        self.service_patch.start();self.addCleanup(self.service_patch.stop)
        (self.root/'run/test.json').write_text(json.dumps({'pid':p.pid,'start':info['start']}))
        return p

    def test_stop_only_terminates_the_recorded_matching_process_group(self):
        p=self.launch();self.assertEqual(launcher.managed('test'),p.pid)
        launcher.stop_one('test');p.wait(timeout=5)
        self.assertFalse((self.root/'run/test.json').exists())

    def test_stale_pid_record_never_kills_a_reused_process(self):
        p=self.launch();(self.root/'run/test.json').write_text(json.dumps({'pid':p.pid,'start':'invalid-old-start-time'}))
        self.assertIsNone(launcher.managed('test'));launcher.stop_one('test')
        self.assertIsNone(p.poll())

    def test_unrelated_process_with_different_cwd_or_command_is_not_managed(self):
        p=self.launch()
        with patch.object(launcher,'SERVICES',{'test':(self.root,['not-the-command'],None,None,None)}):
            self.assertIsNone(launcher.managed('test'));launcher.stop_one('test')
        self.assertIsNone(p.poll())

    def test_invalid_pid_file_is_ignored(self):
        (self.root/'run/test.json').write_text('not json')
        self.assertIsNone(launcher.managed('test'))


    def test_configuration_preserves_existing_secrets_and_urls_byte_for_byte(self):
        from cryptography.fernet import Fernet
        engine='\n'.join([
            'DATABASE_URL=postgresql+psycopg://srv_dataqore_engine:secret@configured-host/dataqore_engine',
            'ENGINE_API_KEY=existing-api-key-0123456789',
            'CONNECTIONS_ENCRYPTION_KEY='+Fernet.generate_key().decode(),
            'EVIDENCE_ENCRYPTION_KEY='+Fernet.generate_key().decode(),
            'CONNECTIONS_ENCRYPTION_KEY_VERSION=v1',
            'WORKER_HEARTBEAT_SECONDS=5','WORKER_JOB_TIMEOUT_SECONDS=600','WORKER_POLL_SECONDS=1',''])
        app='\n'.join([
            'DATABASE_URL=postgresql://srv_dataqore_app:secret@configured-host/dataqore_app?schema=app',
            'ENGINE_API_KEY=existing-api-key-0123456789','JWT_SECRET=existing-jwt-secret-01234567890123456789',
            'ENGINE_API_URL=http://127.0.0.1:8000','WEB_ORIGIN=http://127.0.0.1:5173',
            'ACCESS_TOKEN_SECONDS=900','REFRESH_TOKEN_SECONDS=604800',''])
        (self.root/'engine.env').write_text(engine);(self.root/'controller.env').write_text(app)
        with patch.object(launcher,'ROOT',self.root):launcher.configure()
        self.assertEqual((self.root/'engine.env').read_text(),engine)
        self.assertEqual((self.root/'controller.env').read_text(),app)
        self.assertEqual((self.root/'engine.env').stat().st_mode & 0o777,0o600)

    def test_invalid_existing_fernet_is_never_replaced(self):
        engine='DATABASE_URL=postgresql+psycopg://srv_dataqore_engine:secret@configured-host/dataqore_engine\nCONNECTIONS_ENCRYPTION_KEY=invalid-existing-key\n'
        app='DATABASE_URL=postgresql://srv_dataqore_app:secret@configured-host/dataqore_app\n'
        (self.root/'engine.env').write_text(engine);(self.root/'controller.env').write_text(app)
        with patch.object(launcher,'ROOT',self.root):
            with self.assertRaisesRegex(RuntimeError,'chave original'):launcher.configure()
        self.assertEqual((self.root/'engine.env').read_text(),engine)
        self.assertEqual((self.root/'controller.env').read_text(),app)


if __name__=='__main__':unittest.main()
