/** Offline backfill/rotation. Never reads runtime DSNs or local .env files. */
import pg from 'pg';
import { IdentityCrypto } from './identity.js';
const url = process.env.MIGRATION_DATABASE_URL ?? '';
const current = new IdentityCrypto(process.env.IDENTITY_ENCRYPTION_KEY ?? '');
const previous = process.env.IDENTITY_PREVIOUS_ENCRYPTION_KEY ? new IdentityCrypto(process.env.IDENTITY_PREVIOUS_ENCRYPTION_KEY) : current;
const parsed = (() => { try { return new URL(url); } catch { throw Error('Configure a valid app migrator DSN.'); } })();
if (parsed.protocol !== 'postgresql:' || decodeURIComponent(parsed.username) !== 'srv_dataqore_app_migrator' || parsed.pathname !== '/dataqore_app') throw Error('Use the app migrator DSN for identity migration.');
parsed.searchParams.delete('schema');
const client = new pg.Client({ connectionString: parsed.toString(), connectionTimeoutMillis: 10000 });
try {
  await client.connect(); await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='5s'"); await client.query("SET LOCAL statement_timeout='60s'");
  await client.query('SELECT pg_advisory_xact_lock(80420,1)');
  const identity = await client.query('SELECT session_user,current_user,current_database()');
  if (identity.rows[0].current_user !== 'dataqore_app_owner') throw Error('App owner role required.');
  await client.query('LOCK TABLE app.users IN SHARE ROW EXCLUSIVE MODE');
  const rows = await client.query('SELECT id,email_lookup,identity_ciphertext FROM app.users ORDER BY id FOR UPDATE');
  let changed = 0;
  for (const row of rows.rows) {
    let email: string, displayName: string;
    if (row.identity_ciphertext.startsWith('dqpii:')) {
      const stored = { id: row.id, emailLookup: row.email_lookup, identityCiphertext: row.identity_ciphertext };
      try { current.open(stored); continue; } catch { /* Rotation requires the explicit original key. */ }
      ({ email, displayName } = previous.open(stored));
    } else { email = row.email_lookup; displayName = row.identity_ciphertext; }
    const sealed = current.seal(email, displayName, row.id); current.open(sealed);
    await client.query('UPDATE app.users SET email_lookup=$1,identity_ciphertext=$2 WHERE id=$3', [sealed.emailLookup, sealed.identityCiphertext, row.id]); changed++;
  }
  await client.query('ALTER TABLE app.users VALIDATE CONSTRAINT users_identity_encrypted');
  await client.query('COMMIT'); console.log(`User identities verified; ${changed} encrypted. No personal values displayed.`);
} catch {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Identity migration failed; all identity updates rolled back. Check the original key and migration configuration.'); process.exitCode = 1;
} finally { await client.end(); }
