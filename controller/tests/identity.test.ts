import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { IdentityCrypto } from '../src/identity.js';
test('identity storage is randomized, authenticated and bound to its user; email lookup remains case insensitive', () => {
 const key=randomBytes(32).toString('base64url'), codec=new IdentityCrypto(key), id=randomUUID();
 const a=codec.seal('Person@Example.test','Private User',id), b=codec.seal('person@example.test','Private User',id);
 assert.equal(a.emailLookup,b.emailLookup);assert.notEqual(a.identityCiphertext,b.identityCiphertext);
 assert.equal(codec.lookup(' PERSON@EXAMPLE.TEST '),a.emailLookup);
 for(const text of ['person@example.test','Private User'])assert.equal(JSON.stringify(a).includes(text),false);
 assert.equal(codec.open(a).email,'person@example.test');assert.equal(codec.open(a).displayName,'Private User');
 for(const bad of [{...a,id:randomUUID()},{...a,emailLookup:'0'.repeat(64)},{...a,identityCiphertext:a.identityCiphertext.slice(0,-8)+'AAAAAAAA'},{...a,identityCiphertext:'Private User'}])assert.throws(()=>codec.open(bad),/unavailable/);
 assert.throws(()=>new IdentityCrypto(randomBytes(32).toString('base64url')).open(a),/unavailable/);
 for(const key of ['', 'x'.repeat(32),randomBytes(31).toString('base64url')])assert.throws(()=>new IdentityCrypto(key));
});
