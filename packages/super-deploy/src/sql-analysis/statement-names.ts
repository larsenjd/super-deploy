// Human names for statement node types, used in rule messages.
const names: Record<string, string> = {
  AlterDatabaseSetStmt: "ALTER DATABASE ... SET",
  AlterDatabaseStmt: "ALTER DATABASE",
  AlterDefaultPrivilegesStmt: "ALTER DEFAULT PRIVILEGES",
  AlterDomainStmt: "ALTER DOMAIN",
  AlterEnumStmt: "ALTER TYPE ... ADD VALUE",
  AlterExtensionStmt: "ALTER EXTENSION",
  AlterFunctionStmt: "ALTER FUNCTION",
  AlterObjectSchemaStmt: "ALTER ... SET SCHEMA",
  AlterOwnerStmt: "ALTER ... OWNER TO",
  AlterPolicyStmt: "ALTER POLICY",
  AlterRoleSetStmt: "ALTER ROLE ... SET",
  AlterRoleStmt: "ALTER ROLE",
  AlterSeqStmt: "ALTER SEQUENCE",
  AlterSubscriptionStmt: "ALTER SUBSCRIPTION",
  AlterSystemStmt: "ALTER SYSTEM",
  AlterTableStmt: "ALTER TABLE",
  CallStmt: "CALL",
  CheckPointStmt: "CHECKPOINT",
  ClosePortalStmt: "CLOSE",
  ClusterStmt: "CLUSTER",
  CommentStmt: "COMMENT",
  CompositeTypeStmt: "CREATE TYPE",
  CopyStmt: "COPY",
  CreateCastStmt: "CREATE CAST",
  CreateDomainStmt: "CREATE DOMAIN",
  CreateEnumStmt: "CREATE TYPE ... AS ENUM",
  CreateEventTrigStmt: "CREATE EVENT TRIGGER",
  CreateExtensionStmt: "CREATE EXTENSION",
  CreateFdwStmt: "CREATE FOREIGN DATA WRAPPER",
  CreateForeignServerStmt: "CREATE SERVER",
  CreateForeignTableStmt: "CREATE FOREIGN TABLE",
  CreateFunctionStmt: "CREATE FUNCTION",
  CreatePolicyStmt: "CREATE POLICY",
  CreatePublicationStmt: "CREATE PUBLICATION",
  CreateRangeStmt: "CREATE TYPE ... AS RANGE",
  CreateRoleStmt: "CREATE ROLE",
  CreateSchemaStmt: "CREATE SCHEMA",
  CreateSeqStmt: "CREATE SEQUENCE",
  CreateStatsStmt: "CREATE STATISTICS",
  CreateStmt: "CREATE TABLE",
  CreateSubscriptionStmt: "CREATE SUBSCRIPTION",
  CreateTableAsStmt: "CREATE TABLE AS / CREATE MATERIALIZED VIEW",
  CreateTableSpaceStmt: "CREATE TABLESPACE",
  CreateTrigStmt: "CREATE TRIGGER",
  CreateUserMappingStmt: "CREATE USER MAPPING",
  CreatedbStmt: "CREATE DATABASE",
  DeallocateStmt: "DEALLOCATE",
  DeclareCursorStmt: "DECLARE",
  DefineStmt: "CREATE AGGREGATE / OPERATOR / COLLATION / TYPE",
  DeleteStmt: "DELETE",
  DiscardStmt: "DISCARD",
  DoStmt: "DO",
  DropRoleStmt: "DROP ROLE",
  DropStmt: "DROP",
  DropSubscriptionStmt: "DROP SUBSCRIPTION",
  DropTableSpaceStmt: "DROP TABLESPACE",
  DropdbStmt: "DROP DATABASE",
  ExecuteStmt: "EXECUTE",
  ExplainStmt: "EXPLAIN",
  FetchStmt: "FETCH",
  GrantRoleStmt: "GRANT role",
  GrantStmt: "GRANT / REVOKE",
  IndexStmt: "CREATE INDEX",
  InsertStmt: "INSERT",
  ListenStmt: "LISTEN",
  LoadStmt: "LOAD",
  LockStmt: "LOCK TABLE",
  MergeStmt: "MERGE",
  NotifyStmt: "NOTIFY",
  PrepareStmt: "PREPARE",
  RefreshMatViewStmt: "REFRESH MATERIALIZED VIEW",
  ReindexStmt: "REINDEX",
  RenameStmt: "ALTER ... RENAME",
  RuleStmt: "CREATE RULE",
  SecLabelStmt: "SECURITY LABEL",
  SelectStmt: "SELECT",
  TransactionStmt: "Transaction control",
  TruncateStmt: "TRUNCATE",
  UnlistenStmt: "UNLISTEN",
  UpdateStmt: "UPDATE",
  VacuumStmt: "VACUUM / ANALYZE",
  VariableSetStmt: "SET",
  VariableShowStmt: "SHOW",
  ViewStmt: "CREATE VIEW",
};

export function statementName(nodeType: string): string {
  return names[nodeType] ?? `A ${nodeType} statement`;
}

/** `OBJECT_MATVIEW` -> `materialized view`. */
export function objectTypeName(objectType: string | undefined): string {
  const special: Record<string, string> = {
    OBJECT_MATVIEW: "materialized view",
    OBJECT_TABCONSTRAINT: "constraint",
    OBJECT_DOMCONSTRAINT: "domain constraint",
    OBJECT_FDW: "foreign-data wrapper",
    OBJECT_FOREIGN_SERVER: "server",
    OBJECT_LARGEOBJECT: "large object",
    OBJECT_PARAMETER_ACL: "parameter",
    OBJECT_STATISTIC_EXT: "statistics object",
    OBJECT_TSCONFIGURATION: "text search configuration",
    OBJECT_TSDICTIONARY: "text search dictionary",
    OBJECT_TSPARSER: "text search parser",
    OBJECT_TSTEMPLATE: "text search template",
  };
  if (objectType === undefined) {
    return "object";
  }
  return (
    special[objectType] ??
    objectType
      .replace(/^OBJECT_/, "")
      .toLowerCase()
      .replaceAll("_", " ")
  );
}

/** `OBJECT_MATVIEW` -> `MATERIALIZED VIEW`, as SQL names it after `DROP`, `COMMENT ON` or `GRANT ... ON`. */
export function objectTypeKeyword(objectType: unknown): string {
  return objectTypeName(
    typeof objectType === "string" ? objectType : undefined,
  ).toUpperCase();
}
