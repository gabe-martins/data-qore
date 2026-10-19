"""Local launcher internals. Secrets stay in env files, never shell source/arguments."""
from pathlib import Path
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error

ROOT=Path(__file__).resolve().parents[1]
STATE=ROOT/'.local'
PYTHON=ROOT/'engine/.venv/bin/python'
SERVICES={
    'engine':(ROOT,[str(PYTHON),'-m','dataqore_engine','api'],8000,'/health/ready','engine.env'),
    'controller':(ROOT/'controller',['node',str(ROOT/'controller/dist/src/main.js')],3000,'/health/ready','controller.env'),
    'worker':(ROOT,[str(PYTHON),'-m','dataqore_engine','worker'],None,None,'engine.env'),
    'web':(ROOT/'web',['node',str(ROOT/'web/node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','5173','--strictPort'],5173,'/',None),
}
CLEAN_ENV=('DATABASE_URL','MIGRATION_DATABASE_URL','DATAQORE_ENV_FILE','ENGINE_API_KEY','CONNECTIONS_ENCRYPTION_KEY',
    'CONNECTIONS_ENCRYPTION_KEY_VERSION','SQLITE_ALLOWED_ROOT','WORKER_HEARTBEAT_SECONDS','WORKER_JOB_TIMEOUT_SECONDS',
    'WORKER_POLL_SECONDS','ENGINE_API_URL','JWT_SECRET','WEB_ORIGIN','ACCESS_TOKEN_SECONDS','REFRESH_TOKEN_SECONDS','DATAQORE_CONTROLLER_URL')


def environment(filename=None):
    result={k:v for k,v in os.environ.items() if k not in CLEAN_ENV}
    result['PYTHONPATH']=str(ROOT/'engine')
    if filename:result['DATAQORE_ENV_FILE']=str(ROOT/filename)
    return result


def replace_values(path,updates):
    import re
    content=path.read_text()
    for key,value in updates.items():
        pattern=rf'(?m)^(?:export\s+)?{re.escape(key)}\s*=.*$'
        line=f'{key}={json.dumps(value,ensure_ascii=False)}'
        if re.search(pattern,content):content=re.sub(pattern,lambda _:line,content)
        else:content=content.rstrip('\n')+'\n'+line+'\n'
    path.chmod(0o600)
    if updates:path.write_text(content)


def configure():
    from dotenv import dotenv_values
    from cryptography.fernet import Fernet
    from sqlalchemy.engine import make_url
    from sqlalchemy import create_engine,text
    import secrets
    missing=[]
    for name in ('engine','controller'):
        path=ROOT/f'{name}.env'
        if not path.exists():
            path.touch(mode=0o600,exist_ok=False)
            path.write_text((ROOT/f'{name}.env.example').read_text())
            missing.append(path.name)
    if missing:
        raise RuntimeError('Criados exemplos locais: '+', '.join(missing)+'. Preencha as URLs reais dos bancos nesses arquivos e execute novamente.')
    engine=dotenv_values(ROOT/'engine.env',interpolate=False)
    controller=dotenv_values(ROOT/'controller.env',interpolate=False)
    for name,values,user,db in [('engine',engine,'srv_dataqore_engine','dataqore_engine'),('controller',controller,'srv_dataqore_app','dataqore_app')]:
        try:
            url=make_url(values.get('DATABASE_URL') or '')
            if url.get_backend_name()!='postgresql' or url.username!=user or url.database!=db or not url.host or url.host=='HOST' or (url.password or '').startswith('SUBSTITUIR'):raise ValueError
        except Exception:raise RuntimeError(f'Preencha DATABASE_URL em {name}.env com a conta de execução e database corretos.') from None
    e_updates={};c_updates={}
    key=engine.get('CONNECTIONS_ENCRYPTION_KEY') or ''
    try:Fernet(key.encode())
    except Exception:
        if key and not key.startswith('SUBSTITUIR'):
            raise RuntimeError('Chave Fernet inválida. Recupere a chave original; não será substituída automaticamente.') from None
        db_engine=create_engine(make_url(engine['DATABASE_URL']).set(drivername='postgresql+psycopg'),hide_parameters=True,connect_args={'connect_timeout':5})
        try:
            with db_engine.connect() as connection:
                if connection.scalar(text('SELECT count(*) FROM engine.connections')):
                    raise RuntimeError('Há conexões salvas. Recupere a chave Fernet original antes de iniciar.')
        finally:db_engine.dispose()
        e_updates['CONNECTIONS_ENCRYPTION_KEY']=Fernet.generate_key().decode()
    api_key=engine.get('ENGINE_API_KEY') or ''
    if len(api_key)<16 or api_key.startswith('SUBSTITUIR'):
        api_key=secrets.token_urlsafe(48);e_updates['ENGINE_API_KEY']=api_key
    if controller.get('ENGINE_API_KEY')!=api_key:c_updates['ENGINE_API_KEY']=api_key
    jwt=controller.get('JWT_SECRET') or ''
    if len(jwt)<32 or jwt.startswith('SUBSTITUIR'):c_updates['JWT_SECRET']=secrets.token_urlsafe(48)
    for key,value in [('CONNECTIONS_ENCRYPTION_KEY_VERSION','v1'),('WORKER_HEARTBEAT_SECONDS','5'),('WORKER_JOB_TIMEOUT_SECONDS','600'),('WORKER_POLL_SECONDS','1')]:
        if not engine.get(key):e_updates[key]=value
    for key,value in [('ENGINE_API_URL','http://127.0.0.1:8000'),('WEB_ORIGIN','http://127.0.0.1:5173'),('ACCESS_TOKEN_SECONDS','900'),('REFRESH_TOKEN_SECONDS','604800')]:
        if not controller.get(key):c_updates[key]=value
    if (controller.get('ENGINE_API_URL') or c_updates.get('ENGINE_API_URL'))!='http://127.0.0.1:8000' or (controller.get('WEB_ORIGIN') or c_updates.get('WEB_ORIGIN'))!='http://127.0.0.1:5173':
        raise RuntimeError('Este script usa ENGINE_API_URL=http://127.0.0.1:8000 e WEB_ORIGIN=http://127.0.0.1:5173. Revise controller.env.')
    for name,updates in [('engine',e_updates),('controller',c_updates)]:replace_values(ROOT/f'{name}.env',updates)
    print('Arquivos de ambiente preparados; segredos existentes e senha do administrador preservados.')


def check():
    from dotenv import dotenv_values
    from dataqore_engine.settings import load_settings
    from dataqore_engine.storage import database_engine
    from sqlalchemy import text
    os.environ.update(environment('engine.env'))
    settings=load_settings()
    engine=database_engine(settings)
    try:
        with engine.connect() as c:
            if c.scalar(text('SELECT current_user'))!='srv_dataqore_engine':raise RuntimeError('Use a conta restrita do motor.')
            for name in ('connections','datasets','comparison_definitions','runs','run_results','column_profiles','metrics'):
                c.execute(text(f'SELECT 1 FROM engine.{name} LIMIT 0'))
    finally:engine.dispose()
    result=subprocess.run(['node',str(ROOT/'controller/dist/src/check.js')],cwd=ROOT/'controller',env=environment('controller.env'),capture_output=True,text=True)
    if result.returncode:
        # check.js only prints sanitized errors, never raw database messages.
        print(result.stderr.strip(),file=sys.stderr)
        raise RuntimeError('Acesso ao banco do controller não foi aprovado.')
    print('Bancos e tabelas disponíveis com as contas restritas. Nenhuma migration executada.')


def process_info(pid):
    try:
        proc=Path('/proc')/str(pid)
        fields=(proc/'stat').read_text().rsplit(')',1)[1].split()
        if fields[0]=='Z':return None
        return {'start':fields[19],'group':int(fields[2]),'cwd':str((proc/'cwd').resolve()),
            'command':(proc/'cmdline').read_bytes().split(b'\0')[:-1]}
    except (OSError,ValueError,IndexError):return None


def managed(name):
    try:
        record=json.loads((STATE/'run'/f'{name}.json').read_text())
        info=process_info(record['pid'])
        cwd,command,*_=SERVICES[name]
        if info and info['start']==record['start'] and info['cwd']==str(cwd) and info['command']==[os.fsencode(arg) for arg in command] and info['group']==record['pid']:
            return record['pid']
    except (OSError,ValueError,KeyError,TypeError):pass
    return None


def healthy(port,path):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=2) as r:return r.status==200
    except (OSError,urllib.error.HTTPError):return False


def worker_available():
    from dataqore_engine.settings import load_settings
    from dataqore_engine.storage import database_engine
    from sqlalchemy import text
    os.environ['DATAQORE_ENV_FILE']=str(ROOT/'engine.env')
    engine=database_engine(load_settings())
    try:
        with engine.connect() as c:
            available=c.scalar(text('SELECT pg_try_advisory_lock(80419,1)'))
            if available:c.execute(text('SELECT pg_advisory_unlock(80419,1)'))
            return bool(available)
    finally:engine.dispose()


def stop_one(name):
    pid=managed(name)
    if pid:
        try:os.killpg(pid,signal.SIGTERM)
        except ProcessLookupError:pass
        deadline=time.monotonic()+15
        while managed(name) and time.monotonic()<deadline:time.sleep(.15)
        if managed(name):os.killpg(pid,signal.SIGKILL)
        print(f'{name}: encerrado.')
    (STATE/'run'/f'{name}.json').unlink(missing_ok=True)


def start():
    # Validate all ports before starting anything, so an external process is never killed.
    for name,(_,_,port,_,_) in SERVICES.items():
        if managed(name):continue
        if port:
            with socket.socket() as probe:
                # Match the servers' reuse behavior while prior TCP connections expire.
                # An active listener still prevents this bind (SO_REUSEPORT is not used).
                probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                try:probe.bind(('127.0.0.1',port))
                except OSError:raise RuntimeError(f'Porta {port} ocupada por um processo externo. Encerre a instância manual de {name} antes de usar este script.') from None
    if not managed('worker') and not worker_available():
        raise RuntimeError('Já há um worker externo ativo. Encerre sua instância manual antes de usar este script.')
    started=[]
    try:
        for name,(cwd,command,port,path,filename) in SERVICES.items():
            if managed(name):
                if port and not healthy(port,path):raise RuntimeError(f'{name} está em execução mas seu health check falhou. Consulte os logs ou use restart.')
                print(f'{name}: já iniciado.');continue
            logfile=STATE/'logs'/f'{name}.log'
            # Bound accumulated logs between starts; no bodies or credentials are logged.
            if logfile.exists() and logfile.stat().st_size>5*1024*1024:logfile.replace(logfile.with_suffix('.previous.log'))
            with logfile.open('ab') as log:
                proc=subprocess.Popen(command,cwd=cwd,env=environment(filename),stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,close_fds=True)
            info=process_info(proc.pid)
            if not info:raise RuntimeError(f'{name} encerrou durante a inicialização. Consulte {logfile}.')
            (STATE/'run'/f'{name}.json').write_text(json.dumps({'pid':proc.pid,'start':info['start']}))
            started.append(name)
            deadline=time.monotonic()+30
            while True:
                if proc.poll() is not None:raise RuntimeError(f'{name} encerrou. Consulte {logfile}.')
                if (port and healthy(port,path)) or (not port and not worker_available()):break
                if time.monotonic()>deadline:raise RuntimeError(f'Tempo de inicialização excedido para {name}. Consulte {logfile}.')
                time.sleep(.3)
            print(f'{name}: iniciado.')
    except BaseException:
        for name in reversed(started):stop_one(name)
        raise
    print('\nDataQore pronto: http://127.0.0.1:5173/\nLogs: '+str(STATE/'logs')+'\nParar: ./dataqore.sh stop')


def main():
    STATE.mkdir(mode=0o700,exist_ok=True)
    for directory in ('run','logs'):(STATE/directory).mkdir(mode=0o700,exist_ok=True)
    command=sys.argv[1]
    try:
        if command=='configure':configure()
        elif command=='check':check()
        elif command=='start':start()
        elif command=='stop':
            for name in reversed(SERVICES):stop_one(name)
        elif command=='status':
            all_ready=True
            for name,(_,_,port,path,_) in SERVICES.items():
                pid=managed(name);ready=bool(pid) and (not port or healthy(port,path));all_ready &= ready
                print(f'{name}: '+(f'ativo (PID {pid})' if ready else 'não gerenciado ou indisponível'))
            return 0 if all_ready else 1
        elif command=='logs':
            for name in SERVICES:
                path=STATE/'logs'/f'{name}.log';print(f'\n[{name}]')
                print(''.join(path.read_text(errors='replace').splitlines(keepends=True)[-30:]) if path.exists() else 'Ainda sem log.')
        return 0
    except KeyboardInterrupt:print('Operação interrompida.',file=sys.stderr);return 130
    except Exception as error:
        # Do not print exceptions from database drivers, URLs or .env parser inputs.
        print(str(error) if type(error) is RuntimeError else 'Não foi possível concluir. Confira os arquivos .env, a rede e o PostgreSQL (sem reset).',file=sys.stderr)
        return 1


if __name__=='__main__':raise SystemExit(main())
