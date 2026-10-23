"""Disposable four-process acceptance fixture. Never reads personal .env files."""
import json,os,socket,sqlite3,subprocess,sys,time,urllib.request,unittest,pty,select
from pathlib import Path
from cryptography.fernet import Fernet
from postgres_fixture import TemporaryPostgres,ROOT


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0));return s.getsockname()[1]


@unittest.skipUnless(os.environ.get('DATAQORE_PG_BIN') and (ROOT/'web/node_modules').exists(), 'Requires disposable PostgreSQL and web/controller dependencies')
class FullStackTests(TemporaryPostgres):
    def test_browser_and_controller_against_real_disposable_services(self):
        self.command('app','baseline')
        self.command('app','apply')
        self.command('engine','baseline')
        self.command('engine','apply')
        engine_port,controller_port,web_port=free_port(),free_port(),free_port()
        source=self.directory/'sources';source.mkdir()
        with sqlite3.connect(source/'delete.sqlite') as db:
            db.execute('CREATE TABLE records(id integer PRIMARY KEY, amount numeric)')
            for index in range(21):db.execute(f'CREATE TABLE dependency_{index:02}(id integer PRIMARY KEY, amount numeric)')
        for side in ('left','right'):
            with sqlite3.connect(source/f'{side}.sqlite') as db:
                db.execute('CREATE TABLE records(id integer PRIMARY KEY, amount numeric NOT NULL, status text,created date)')
                db.executemany('INSERT INTO records VALUES(?,?,?,?)',[(1,10 if side=='left' else 12,'paid','2026-10-01'),(2,20,'pending','2026-10-02')])
        for side in ('left','right'):
            with sqlite3.connect(source/f'evaluation-{side}.sqlite') as db:
                db.execute('CREATE TABLE records(id integer PRIMARY KEY, amount numeric, label text, null_text text, created date)')
                db.executemany('INSERT INTO records VALUES(?,?,?,?,?)',[(1,0,'same',None,'2026-10-01'),(2,0,'same',None,'2026-10-02')])
        for side in ('left','right'):
            with sqlite3.connect(source/f'timezone-{side}.sqlite') as db:
                db.execute('CREATE TABLE records(id integer PRIMARY KEY, sold timestamp'+(', ingestion_datetime text' if side=='right' else '')+')')
                if side=='left':
                    db.executemany('INSERT INTO records VALUES(?,?)',[(1,'2026-10-20T12:00:00'),(2,'2026-10-20T13:00:00')])
                else:
                    db.executemany('INSERT INTO records VALUES(?,?,?)',[(1,'2026-10-20T15:00:00+00:00','extra'),(2,'2026-10-20T16:00:00+00:00','extra')])
        for side in ('nokey-left','nokey-right','empty'):
            with sqlite3.connect(source/f'{side}.sqlite') as db:
                db.execute('CREATE TABLE records(id integer, amount numeric)')
                if side!='empty':
                    db.executemany('INSERT INTO records VALUES(?,?)',[(1,10),(2,20)])
        for side in ('business-left','business-right'):
            with sqlite3.connect(source/f'{side}.sqlite') as db:
                cols='account text, item integer, day date, batch text, amount numeric' if side=='business-left' else 'customer text, line integer, loaded date, batch text, total numeric'
                db.execute('CREATE TABLE records('+cols+')')
                db.executemany('INSERT INTO records VALUES(?,?,?,?,?)',[
                    ('A',1,'2026-10-01','B',10),('A',2,'2026-10-01','B',20),
                    ('A',1,'2026-09-30','B',999),(None,9,'2026-10-01','OTHER',999)])
        with sqlite3.connect(source/'databricks.sqlite') as db:
            db.execute('CREATE TABLE records(id integer PRIMARY KEY, amount numeric NOT NULL, status text)')
            db.executemany('INSERT INTO records VALUES(?,?,?)',[(1,10,'paid'),(2,20,'pending')])
            db.execute('CREATE VIEW records_view AS SELECT * FROM records')
        for side in ('invalid-left','invalid-right'):
            with sqlite3.connect(source/f'{side}.sqlite') as db:
                db.execute('CREATE TABLE records(id integer,value text,created date)')
                db.executemany('INSERT INTO records VALUES(?,?,?)',[(1,'x','2026-10-01'),(1,'y','2026-10-02')])
        env=os.environ.copy()
        for name in ('MIGRATION_DATABASE_URL','DATAQORE_ENV_FILE'):
            env.pop(name,None)
        cfg={'DATAQORE_ISOLATED_TEST':'1','DATABASE_URL':f'postgresql://srv_dataqore_app@127.0.0.1:{self.port}/dataqore_app',
            'ENGINE_API_URL':f'http://127.0.0.1:{engine_port}','ENGINE_API_KEY':'isolated-api-key-for-tests-only',
            'JWT_SECRET':'isolated-jwt-secret-for-acceptance-tests-only','WEB_ORIGIN':f'http://127.0.0.1:{web_port}',
            'TEST_CONTROLLER_PORT':str(controller_port),'DATAQORE_CONTROLLER_URL':f'http://127.0.0.1:{controller_port}',
            'DATAQORE_WEB_URL':f'http://127.0.0.1:{web_port}','PYTHONPATH':os.pathsep.join(map(str,[ROOT/'tests/databricks_test_support',ROOT/'tests',ROOT/'engine'])),'DATAQORE_DATABRICKS_STUB_ROOT':str(source),'WORKER_POLL_SECONDS':'.1'}
        env.update(cfg)
        engine_env={**env,'DATABASE_URL':f'postgresql+psycopg://srv_dataqore_engine@127.0.0.1:{self.port}/dataqore_engine',
            'CONNECTIONS_ENCRYPTION_KEY':Fernet.generate_key().decode(),'CONNECTIONS_ENCRYPTION_KEY_VERSION':'v1','SQLITE_ALLOWED_ROOT':str(source)}
        # Ensure that neither service falls back to the personal file for any setting.
        empty=self.directory/'empty.env';empty.write_text('');env['DATAQORE_ENV_FILE']=str(empty);engine_env['DATAQORE_ENV_FILE']=str(empty)
        def admin_cli(command,expected=0):
            master,slave=pty.openpty()
            proc=subprocess.Popen(['node','--import','tsx','src/admin.ts',command],cwd=ROOT/'controller',env=env,
                stdin=slave,stdout=slave,stderr=slave)
            os.close(slave);output=b''
            def read_until(marker):
                nonlocal output
                deadline=time.monotonic()+15
                while marker.encode() not in output:
                    if time.monotonic()>deadline:proc.kill();self.fail('CLI prompt not available: '+marker+' '+output.decode(errors='replace'))
                    if select.select([master],[],[],.2)[0]:
                        try:output+=os.read(master,65536)
                        except OSError:break
                self.assertIn(marker.encode(),output)
            try:
                read_until('Administrator email: ');os.write(master,b'admin@dataqore.test\n')
                if command=='create':read_until('Display name: ');os.write(master,b'Test Administrator\n')
                read_until('Password (at least 12 characters, hidden): ');os.write(master,b'DataQore-test-password-2026\n')
                read_until('Confirm password (hidden): ');os.write(master,b'DataQore-test-password-2026\n')
                deadline=time.monotonic()+15
                while proc.poll() is None and time.monotonic()<deadline:
                    if select.select([master],[],[],.2)[0]:
                        try:output+=os.read(master,65536)
                        except OSError:break
                proc.wait(timeout=5)
                self.assertEqual(proc.returncode,expected,output.decode(errors='replace'))
                self.assertNotIn(b'DataQore-test-password-2026',output)
            finally:
                if proc.poll() is None:proc.kill();proc.wait()
                os.close(master)
        admin_cli('create')
        admin_cli('create',1)
        admin_cli('reset-password')
        with self.connect('app') as c:
            self.assertTrue(c.execute("SELECT must_change_password FROM app.users WHERE email='admin@dataqore.test'").fetchone()[0])
            # This fixture reuses its seeded password; lifecycle enforcement is tested separately.
            c.execute("UPDATE app.users SET must_change_password=false WHERE email='admin@dataqore.test'")
        handles=[]
        def start(command,environment,cwd,name):
            log=open(self.directory/(name+'.log'),'w+');p=subprocess.Popen(command,cwd=cwd,env=environment,stdout=log,stderr=subprocess.STDOUT)
            handles.append((p,log,name));return p
        def stop():
            for proc,log,name in reversed(handles):
                if proc.poll() is None:
                    proc.terminate()
                    try:proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:proc.kill();proc.wait()
                if self._outcome.result and (self._outcome.result.failures or self._outcome.result.errors):
                    log.seek(0);print('\nSERVICE',name,log.read()[-15000:])
                log.close()
        self.addCleanup(stop)
        python=str(ROOT/'engine/.venv/bin/python')
        start([python,'-c',f'import uvicorn;uvicorn.run("dataqore_engine.api:create_app",factory=True,host="127.0.0.1",port={engine_port},access_log=False)'],engine_env,ROOT,'engine')
        start([python,'-m','dataqore_engine','worker'],engine_env,ROOT,'worker')
        controller_command=['node','--import','tsx','tests/server.ts']
        controller_process=start(controller_command,env,ROOT/'controller','controller')
        start(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',str(web_port),'--strictPort'],env,ROOT/'web','web')
        for url in (cfg['ENGINE_API_URL']+'/health/ready',cfg['DATAQORE_CONTROLLER_URL']+'/health/ready',cfg['DATAQORE_WEB_URL']):
            deadline=time.monotonic()+60
            while True:
                try:
                    with urllib.request.urlopen(url,timeout=1) as r:
                        if r.status==200:break
                except Exception:pass
                if time.monotonic()>deadline:
                    for p,log,name in handles:log.flush();log.seek(0);print(name,log.read())
                    self.fail('Service did not start: '+url)
                time.sleep(.2)
        commands=[(['node','--import','tsx','--test','tests/controller.test.ts','tests/diagnostics.test.ts'],ROOT/'controller'),
            (['node','node_modules/@playwright/test/cli.js','test','critical-metrics.spec.ts','comparison-animation.spec.ts','result-interpretation.spec.ts','--output','test-results/critical-artifacts'],ROOT/'web'),
            (['node','node_modules/@playwright/test/cli.js','test','ui-appearance.spec.ts','--output','test-results/appearance-artifacts'],ROOT/'web'),
            (['node','--import','tsx','--test','tests/comparison-delete.test.ts','tests/schedules.test.ts'],ROOT/'controller'),
            (['node','--import','tsx','--test','tests/access.test.ts'],ROOT/'controller'),
            (['node','node_modules/@playwright/test/cli.js','test','access-control.spec.ts','navigation-branding.spec.ts','--output','test-results/access-artifacts'],ROOT/'web')]
        for group,(cmd,cwd) in enumerate(commands):
            if group:
                # Each suite gets fresh process-local rate limits; database sessions
                # remain intact. Do not relax the application's production limits.
                controller_process.terminate();controller_process.wait(timeout=10)
                controller_process=start(controller_command,env,ROOT/'controller',f'controller-{group}')
                deadline=time.monotonic()+20
                while True:
                    try:
                        with urllib.request.urlopen(cfg['DATAQORE_CONTROLLER_URL']+'/health/ready',timeout=1) as r:
                            if r.status==200:break
                    except Exception:pass
                    if time.monotonic()>deadline:self.fail('Isolated controller did not restart')
                    time.sleep(.1)
            result=subprocess.run(cmd,cwd=cwd,env=env,text=True,capture_output=True,timeout=240)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            print(result.stdout)
        with self.connect('app') as c:
            audit=c.execute('SELECT details FROM app.audit_log').fetchall()
            self.assertTrue(audit)
        with self.connect('engine') as c:
            rows=c.execute('SELECT result FROM engine.run_results').fetchall()
            self.assertGreaterEqual(len(rows),2)
            self.assertNotIn('sample_rows',json.dumps(rows))
            for (result,) in rows:self.assertEqual(len(result['metrics']),5)
