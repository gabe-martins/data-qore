import {test} from 'node:test';
import assert from 'node:assert/strict';
import {databaseFailure} from '../src/diagnostics.js';
test('database diagnostics classify nested driver codes without exposing messages',()=>{
 for(const [code,expected] of [['57P03','database_starting_up'],['EHOSTUNREACH','database_network_unreachable'],['DatabaseNotReachable','database_network_unreachable'],['ECONNREFUSED','database_connection_refused'],['28P01','database_authentication_failed'],['42501','database_access_denied'],['P2021','database_schema_unavailable'],['CERT_HAS_EXPIRED','database_tls_failed']]){
  const result=databaseFailure({message:'postgresql://user:PRIVATE_PASSWORD@private-host/db',meta:{driverAdapterError:{cause:{code}}}});
  assert.ok(result.includes(expected));assert.doesNotMatch(result,/PRIVATE_PASSWORD|private-host/);
 }
 assert.match(databaseFailure({message:'PRIVATE_PASSWORD'}),/database_operation_failed/);
});
