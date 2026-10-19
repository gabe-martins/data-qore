/** Public diagnostics: classify codes, never print driver messages or connection URLs. */
export function databaseFailure(error: unknown): string {
  const codes = new Set<string>();
  const visited = new Set<object>();
  function inspect(value: unknown, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 5 || visited.has(value)) return;
    visited.add(value);
    const item = value as Record<string, unknown>;
    for (const key of ['code', 'sqlstate', 'originalCode', 'kind']) {
      if (typeof item[key] === 'string') codes.add(item[key] as string);
    }
    for (const key of ['cause', 'meta', 'driverAdapterError']) inspect(item[key], depth + 1);
  }
  inspect(error);
  const has = (...values: string[]) => values.some(value => codes.has(value));
  if (has('57P03'))
    return 'PostgreSQL is still starting up or recovering. Wait until the server is ready, then retry. [database_starting_up]';
  if (has('EHOSTUNREACH', 'ENETUNREACH', 'DatabaseNotReachable'))
    return 'Database host is unreachable. Check the server address, LAN/VPN access and the PostgreSQL port published by the existing container. [database_network_unreachable]';
  if (has('ECONNREFUSED'))
    return 'Database connection was refused. Check that PostgreSQL is running and listening on the configured port. [database_connection_refused]';
  if (has('ETIMEDOUT', 'P1001', 'P1002', 'ConnectionTimeout'))
    return 'Database connection timed out. Check network access, firewall and server availability. [database_connection_timeout]';
  if (has('ENOTFOUND', 'EAI_AGAIN'))
    return 'Database hostname could not be resolved. Check the host configured in controller.env. [database_host_not_found]';
  if (has('28P01', 'P1000', 'DatabaseAuthenticationFailed'))
    return 'Database authentication failed. Check the password of srv_dataqore_app and its URL encoding. [database_authentication_failed]';
  if (has('42501', 'P1010', 'DatabaseAccessDenied'))
    return 'The runtime account lacks access to the app database or tables. Review its existing grants without granting owner privileges. [database_access_denied]';
  if (has('42P01', 'P2021', 'P2022', 'TableDoesNotExist', 'ColumnNotFound'))
    return 'The app schema is unavailable or incomplete. Check migration status; do not reset the database. [database_schema_unavailable]';
  if (has('SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'P1011', 'TlsConnectionError'))
    return 'Database TLS verification failed. Review the configured SSL mode and trusted server certificate. [database_tls_failed]';
  return 'Unable to access the app database. Check configuration and database access. [database_operation_failed]';
}
