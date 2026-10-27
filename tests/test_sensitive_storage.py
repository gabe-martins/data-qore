"""Synthetic encryption and migration regressions; no personal sources or config."""
import json,os,secrets,subprocess,unittest
from unittest.mock import patch
from pathlib import Path
from cryptography.fernet import Fernet
from dataqore_engine.document_crypto import DocumentCrypto,MARKER
from dataqore_engine import connectors
from postgres_fixture import TemporaryPostgres,ROOT,IDENTITY_KEY,sealed_user
from psycopg.types.json import Jsonb

class DocumentCryptoTests(unittest.TestCase):
    def test_nested_filter_literals_roundtrip_randomize_and_reject_tampering(self):
        key=Fernet.generate_key().decode();codec=DocumentCrypto(key)
        value={'comparison_options':{'scope':{'filters':[{'value':['private@example.test',123,True]}]}},'metrics':{'row_match_rate':{'numerator':1,'denominator':2}}}
        a=codec.dumps(value);b=codec.dumps(value)
        self.assertNotIn('private@example.test',a);self.assertNotEqual(a,b)
        self.assertEqual(codec.loads(a),value)
        self.assertEqual(json.loads(a)['metrics'],value['metrics'])
        with self.assertRaises(ValueError):DocumentCrypto(Fernet.generate_key().decode()).loads(a)
        payload=json.loads(a);payload['comparison_options']['scope']['filters'][0]['value'][MARKER]='corrupt'
        with self.assertRaises(ValueError):codec.reveal(payload)
        # A real column name may equal our internal marker, or a protected field name.
        metadata={'columns':{MARKER:{'type':'text'},'value':{'type':'text'}},'filters':[{'value':'private@example.test'}]}
        self.assertEqual(codec.loads(codec.dumps(metadata)),metadata)
        from tools.encrypt_documents import needs_encryption
        self.assertTrue(needs_encryption(metadata))
        protected=codec.protect(metadata)
        self.assertFalse(needs_encryption(protected))
        self.assertEqual(codec.reveal(protected),metadata)
        for bad in ['', 'YWJj', Fernet.generate_key().decode()[:-2]]:
            with self.assertRaises((ValueError,TypeError)):DocumentCrypto(bad)

    def test_mysql_refuses_plaintext_server_before_sending_authentication(self):
        import pymysql
        from unittest.mock import Mock
        credentials={'hostname':'db.example.test','database':'app','username':'reader','password':'synthetic'}
        with patch.object(pymysql,'connect') as connect:
            connectors.mysql(credentials)
            arguments=connect.call_args.kwargs
        client=pymysql.connections.Connection(defer_connect=True,**arguments)
        client.server_version='8.0.0';client.server_capabilities=0
        client.write_packet=Mock();client._read_packet=Mock()
        with self.assertRaises(pymysql.err.OperationalError) as error:client._request_authentication()
        self.assertEqual(error.exception.args[0],2026)
        client.write_packet.assert_not_called();client._read_packet.assert_not_called()

    def test_mysql_and_oracle_honor_tls_and_certificate_validation(self):
        import ssl
        from unittest.mock import MagicMock
        driver=MagicMock();creds={'hostname':'db.example.test','database':'app','username':'reader','password':'synthetic'}
        with patch.object(connectors.importlib,'import_module',return_value=driver):
            connectors.mysql(creds);ctx=driver.connect.call_args.kwargs['ssl']
            self.assertTrue(ctx.check_hostname);self.assertEqual(ctx.verify_mode,ssl.CERT_REQUIRED)
            self.assertGreaterEqual(ctx.minimum_version,ssl.TLSVersion.TLSv1_2)
            connectors.mysql({**creds,'sslmode':'verify-ca'});ctx=driver.connect.call_args.kwargs['ssl']
            self.assertFalse(ctx.check_hostname);self.assertEqual(ctx.verify_mode,ssl.CERT_REQUIRED)
            connectors.mysql({**creds,'sslmode':'require'});self.assertEqual(driver.connect.call_args.kwargs['ssl'].verify_mode,ssl.CERT_NONE)
            connectors.mysql({**creds,'sslmode':'disable'});self.assertTrue(driver.connect.call_args.kwargs['ssl_disabled'])
            connectors.oracle(creds);params=driver.ConnectParams.call_args.kwargs
            self.assertEqual(params['protocol'],'tcps');self.assertTrue(params['ssl_server_dn_match'])

@unittest.skipUnless(os.environ.get('DATAQORE_PG_BIN'),'Disposable PostgreSQL required')
class SensitiveMigrationTests(TemporaryPostgres):
    def test_identity_backfill_preserves_users_and_rejects_wrong_key_then_rotates(self):
        with self.connect('app') as conn:
            identifier=conn.execute("INSERT INTO app.users(email,display_name,password_hash) VALUES('Legacy@Example.test','Legacy Private User','original-hash') RETURNING id").fetchone()[0]
        self.command('app','baseline');self.command('app','apply');self.command('app','verify')
        with self.connect('app') as conn:
            old=conn.execute('SELECT id,email_lookup,identity_ciphertext,password_hash FROM app.users').fetchone()
            self.assertEqual(old[0],identifier);self.assertEqual(old[3],'original-hash')
            self.assertNotIn('Legacy',str(old));self.assertNotIn('@',old[1]);self.assertTrue(old[2].startswith('dqpii:1:'))
        self.command('app','apply')
        with patch.dict(os.environ,{'IDENTITY_ENCRYPTION_KEY':secrets.token_urlsafe(32)}):self.command('app','apply',success=False)
        with self.connect('app') as conn:self.assertEqual(conn.execute('SELECT id,email_lookup,identity_ciphertext,password_hash FROM app.users').fetchone(),old)
        new=secrets.token_urlsafe(32)
        with patch.dict(os.environ,{'IDENTITY_ENCRYPTION_KEY':new,'IDENTITY_PREVIOUS_ENCRYPTION_KEY':IDENTITY_KEY}):self.command('app','apply')
        with self.connect('app') as conn:
            rotated=conn.execute('SELECT email_lookup,identity_ciphertext,password_hash FROM app.users').fetchone()
            self.assertNotEqual(rotated[:2],old[1:3]);self.assertEqual(rotated[2],'original-hash')
        with patch.dict(os.environ,{'IDENTITY_ENCRYPTION_KEY':new}):self.command('app','apply')

    def test_engine_backfill_encrypts_existing_literals_and_is_idempotent(self):
        self.command('engine','baseline');self.command('engine','apply')
        with self.connect('engine') as conn:
            cid=conn.execute("INSERT INTO engine.connections(name,connector,credentials_ciphertext) VALUES('synthetic','sqlite','unused') RETURNING id").fetchone()[0]
            original={'filters':[{'operator':'eq','value':'private@example.test'}]}
            identifier=conn.execute("INSERT INTO engine.datasets(connection_id,table_name,metadata) VALUES(%s,'synthetic',%s) RETURNING id",(cid,Jsonb(original))).fetchone()[0]
        self.command('engine','apply')
        with self.connect('engine') as conn:
            stored=conn.execute('SELECT metadata FROM engine.datasets WHERE id=%s',(identifier,)).fetchone()[0]
            self.assertNotIn('private@example.test',json.dumps(stored));self.assertIn(MARKER,json.dumps(stored))
        codec=DocumentCrypto(os.environ['CONNECTIONS_ENCRYPTION_KEY']);self.assertEqual(codec.reveal(stored),original)
        self.command('engine','apply')
        with self.connect('engine') as conn:self.assertEqual(conn.execute('SELECT metadata FROM engine.datasets WHERE id=%s',(identifier,)).fetchone()[0],stored)
