// The managed schema's own privileges that are target setup rather than the
// desired schema's: its owner's and the deploy role's. A target's schema may
// belong to an administrator who granted the deploy role its privileges
// (with grant option, so it can grant USAGE); neither is declared by the
// migrations. The catalog comparison counts both as the owner, rebuild
// leaves them alone and adoption doesn't write them.

/**
 * SQL selecting the oids of those roles: the schema's owner (`owner`, an SQL
 * expression for its oid) and the session's role (the deploy role on a
 * target). Use as `grantee IN (${schemaSetupRoles("n.nspowner")})`.
 */
export const schemaSetupRoles = (owner: string): string =>
  `SELECT ${owner} UNION SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user`;
