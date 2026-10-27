BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE app.users RENAME COLUMN email TO email_lookup;
ALTER TABLE app.users RENAME COLUMN display_name TO identity_ciphertext;
DROP INDEX app.users_email_unique;
CREATE UNIQUE INDEX users_email_lookup_unique ON app.users (email_lookup);
-- The mandatory application backfill seals existing rows and validates this check.
-- NOT VALID still rejects every new or updated plaintext row immediately.
ALTER TABLE app.users ADD CONSTRAINT users_identity_encrypted CHECK (
  email_lookup ~ '^[a-f0-9]{64}$' AND
  identity_ciphertext ~ '^dqpii:1:[a-f0-9]{16}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$'
) NOT VALID;
COMMIT;
