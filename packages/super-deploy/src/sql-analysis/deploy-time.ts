// Rules for deploy-time SQL (spec "Rules: deploy-time SQL", ADR-0002):
// generated schema changes, pre- and post-migration scripts and seed data.
// The hazards they guard against are catalogued in
// .scratch/super-deploy/research/transactional-hazards.md.
//
// Three layers, each an allowlist where it can be:
// 1. Statements: every statement type is classified (DDL, privileges, data,
//    temporary tables, maintenance) or refused with the reason; each kind of
//    file allows only some classes. Unknown statement types are refused.
// 2. Statement details: ALTER TABLE subcommands, DROP and RENAME object
//    types, function languages, temporary-table lifetime and unsupported
//    features.
// 3. Expressions, walked over the whole statement except routine bodies:
//    function calls, schema references, column-order constructs and
//    identity columns. Routine bodies get the same body rules as the
//    desired schema (routine-bodies.ts).
//
// A migration's files are analysed in the order they run, so state (the
// migration's temporary tables and identity columns created on the way)
// carries from one file to the next. Override markers (overrides.ts) are
// applied per statement. Destructive statements and lock warnings are found
// alongside (destructive.ts).
import type {
  ColumnDef,
  Constraint,
  CreateFunctionStmt,
  CreateStmt,
  DropStmt,
  GrantStmt,
  InsertStmt,
  MergeStmt,
  MergeWhenClause,
  Node,
  ObjectWithArgs,
  RangeVar,
  RenameStmt,
  ResTarget,
  SelectStmt,
  TypeName,
  UpdateStmt,
} from "@pgsql/types";
import type { RuleViolation } from "../errors.ts";
import { denylistedCall } from "./denylist.ts";
import {
  ChangeTracker,
  type ColumnTypes,
  type DestructiveStatement,
  type LockWarning,
} from "./destructive.ts";
import { applyMarker, type Override, scanMarkers } from "./overrides.ts";
import { type ParsedStatement, parseSqlFile, type SqlFile } from "./parse.ts";
import { pgCatalogFunctions, pgCatalogRelations } from "./pg-catalog-names.ts";
import { plpgsqlFindings, sqlBodyFindings } from "./routine-bodies.ts";
import type { RuleId } from "./rule-catalogue.ts";
import type { RuleContext } from "./rule-types.ts";
import {
  objectTypeKeyword,
  objectTypeName,
  statementName,
} from "./statement-names.ts";
import {
  alterTableCommands,
  type Json,
  statementBody,
  stringList,
  unwrap,
  walkNodes,
  wrapped,
} from "./syntax-tree.ts";

export type DeployTimeKind =
  | "schema-change"
  | "pre-migration"
  | "post-migration"
  | "seed-data";

export interface DeployTimeFile extends SqlFile {
  readonly kind: DeployTimeKind;
}

/** Identity columns by table name (unqualified, as PostgreSQL folds it). */
export type IdentityColumns = ReadonlyMap<string, ReadonlySet<string>>;

export interface DeployTimeOptions extends Partial<RuleContext> {
  /**
   * Identity columns that exist before or after the migration (from the
   * desired-schema snapshots, see `identityColumnsOf`). Identity columns the
   * migration's own DDL creates are found as the files are analysed.
   */
  readonly identityColumns?: IdentityColumns;
  /**
   * Column types before the migration (from the previous desired-schema
   * snapshot, see `columnTypesOf`), to tell a lossy type change from a
   * widening. Without them every type change counts as lossy.
   */
  readonly columnTypes?: ColumnTypes;
}

export interface MigrationAnalysis {
  /** Every rule violation, in file and statement order. */
  readonly violations: readonly RuleViolation[];
  /** The override markers accepted, in file and statement order. */
  readonly overrides: readonly Override[];
  /** Statements that drop structure or delete data (finalize needs them acknowledged), in order. */
  readonly destructive: readonly DestructiveStatement[];
  /** Statements that rewrite or scan an existing table while holding its lock, in order. */
  readonly warnings: readonly LockWarning[];
}

interface Finding {
  readonly rule: RuleId;
  readonly message: string;
  /** Absolute line, for findings inside a routine body. */
  readonly line?: number;
}

interface MigrationState {
  readonly managedSchema: string;
  /** Schemas PL/pgSQL bodies may reference. */
  readonly externalSchemas: readonly string[];
  readonly identity: Map<string, Set<string>>;
  /** Temporary tables created so far in this migration. */
  readonly temporary: Set<string>;
}

/** Analyses one migration's deploy-time files, given in the order they run. */
export async function analyseMigration(
  files: readonly DeployTimeFile[],
  options: DeployTimeOptions = {},
): Promise<MigrationAnalysis> {
  const state: MigrationState = {
    managedSchema: options.managedSchema ?? "public",
    externalSchemas: options.externalSchemas ?? [],
    identity: copyIdentity(options.identityColumns),
    temporary: new Set(),
  };
  const violations: RuleViolation[] = [];
  const overrides: Override[] = [];
  const changes = new ChangeTracker(state.managedSchema, options.columnTypes);
  for (const file of files) {
    const parsed = await parseSqlFile(file);
    if (!parsed.ok) {
      violations.push(parsed.violation);
      continue;
    }
    const scan = scanMarkers(file, parsed.statements);
    const pending = [...scan.violations];
    parsed.statements.forEach((statement, index) => {
      while (pending[0] !== undefined && pending[0].line < statement.line) {
        violations.push(pending.shift() as RuleViolation);
      }
      const found: RuleViolation[] = [];
      const seen = new Set<string>();
      for (const { line, ...finding } of checkStatement(
        statement,
        file.kind,
        state,
      )) {
        const key = `${line}\n${finding.rule}\n${finding.message}`;
        if (!seen.has(key)) {
          seen.add(key);
          found.push({
            file: statement.file,
            line: line ?? statement.line,
            statement: statement.text,
            ...finding,
          });
        }
      }
      const marked = applyMarker(
        statement,
        scan.markers.get(index),
        found,
        state.managedSchema,
      );
      violations.push(...marked.violations);
      if (marked.override !== undefined) {
        overrides.push(marked.override);
      }
      remember(statement, state);
      changes.statement(statement);
    });
    violations.push(...pending);
  }
  return {
    violations,
    overrides,
    destructive: changes.destructive,
    warnings: changes.warnings,
  };
}

/** Identity columns created by CREATE TABLE and ALTER TABLE statements, e.g. a desired schema. */
export function identityColumnsOf(
  statements: readonly ParsedStatement[],
): IdentityColumns {
  const state: MigrationState = {
    managedSchema: "",
    externalSchemas: [],
    identity: new Map(),
    temporary: new Set(),
  };
  for (const statement of statements) {
    remember(statement, state);
  }
  return state.identity;
}

function copyIdentity(
  identity: IdentityColumns | undefined,
): Map<string, Set<string>> {
  const copy = new Map<string, Set<string>>();
  for (const [table, columns] of identity ?? []) {
    copy.set(table, new Set(columns));
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Layer 1: statements

type StatementClass =
  | "ddl"
  | "privileges"
  | "data"
  | "temporary"
  | "maintenance";

type Classification =
  | { readonly class: StatementClass }
  | { readonly refused: Finding };

const allowedClasses: Record<DeployTimeKind, readonly StatementClass[]> = {
  "schema-change": ["ddl", "privileges"],
  "pre-migration": ["ddl", "data", "temporary", "maintenance"],
  "post-migration": ["data", "temporary", "maintenance"],
  "seed-data": ["data"],
};

const kindNames: Record<DeployTimeKind, string> = {
  "schema-change": "a schema change",
  "pre-migration": "a pre-migration script",
  "post-migration": "a post-migration script",
  "seed-data": "seed data",
};

const refuse = (rule: RuleId, message: string): Classification => ({
  refused: { rule, message },
});

const transactionKinds: Record<string, string> = {
  TRANS_STMT_BEGIN: "BEGIN",
  TRANS_STMT_START: "START TRANSACTION",
  TRANS_STMT_COMMIT: "COMMIT",
  TRANS_STMT_ROLLBACK: "ROLLBACK",
  TRANS_STMT_SAVEPOINT: "SAVEPOINT",
  TRANS_STMT_RELEASE: "RELEASE SAVEPOINT",
  TRANS_STMT_ROLLBACK_TO: "ROLLBACK TO SAVEPOINT",
  TRANS_STMT_PREPARE: "PREPARE TRANSACTION",
  TRANS_STMT_COMMIT_PREPARED: "COMMIT PREPARED",
  TRANS_STMT_ROLLBACK_PREPARED: "ROLLBACK PREPARED",
};

const transactionEffects: Record<string, string> = {
  TRANS_STMT_BEGIN: "would start a transaction inside the deploy transaction",
  TRANS_STMT_START: "would start a transaction inside the deploy transaction",
  TRANS_STMT_COMMIT: "would end the deploy transaction early",
  TRANS_STMT_ROLLBACK: "would end the deploy transaction early",
  TRANS_STMT_SAVEPOINT:
    "would let part of the deployment be rolled back on its own",
  TRANS_STMT_RELEASE:
    "would let part of the deployment be rolled back on its own",
  TRANS_STMT_ROLLBACK_TO:
    "would let part of the deployment be rolled back on its own",
  TRANS_STMT_PREPARE: "would detach the deploy transaction from its session",
  TRANS_STMT_COMMIT_PREPARED: "cannot run inside a transaction block",
  TRANS_STMT_ROLLBACK_PREPARED: "cannot run inside a transaction block",
};

/** Statement types PostgreSQL refuses inside a transaction block (hazards §1). */
const notInTransaction = new Set([
  "CreatedbStmt",
  "DropdbStmt",
  "AlterDatabaseStmt",
  "CreateTableSpaceStmt",
  "DropTableSpaceStmt",
  "AlterSystemStmt",
  "CreateSubscriptionStmt",
  "AlterSubscriptionStmt",
  "DropSubscriptionStmt",
]);

/** Statement types whose effects escape or outlive the transaction (hazards §2). */
const escaping: Record<string, string> = {
  ListenStmt: "takes effect at commit and lasts for the rest of the session",
  UnlistenStmt: "changes session state that outlives the transaction",
  NotifyStmt: "reaches listeners outside the deployment",
  PrepareStmt: "creates a prepared statement that outlives the transaction",
  ExecuteStmt: "runs a prepared statement the rules cannot see",
  DeallocateStmt: "changes session state that outlives the transaction",
  DeclareCursorStmt: "opens a cursor; cursors are session state",
  FetchStmt: "reads a cursor; cursors are session state",
  ClosePortalStmt: "closes a cursor; cursors are session state",
  LoadStmt: "loads a shared library that stays loaded after a rollback",
  CheckPointStmt: "forces cluster-wide I/O that no rollback undoes",
  DiscardStmt: "discards session state",
  CopyStmt:
    "reads or writes server files, programs or the client stream, and depends on column order; use INSERT ... SELECT with a column list",
  AlterDatabaseSetStmt: "changes settings for future sessions",
  AlterRoleSetStmt: "changes settings for future sessions",
  AlterDatabaseRefreshCollStmt: "changes the database, not the managed schema",
};

/** Statement types for objects or features V1 does not support. */
const unsupported: Record<string, string> = {
  CreateRoleStmt: "roles are cluster-wide and never managed by super-deploy",
  AlterRoleStmt: "roles are cluster-wide and never managed by super-deploy",
  DropRoleStmt: "roles are cluster-wide and never managed by super-deploy",
  GrantRoleStmt: "roles are cluster-wide and never managed by super-deploy",
  ReassignOwnedStmt: "ownership is not managed by super-deploy",
  DropOwnedStmt: "roles are cluster-wide and never managed by super-deploy",
  AlterOwnerStmt: "ownership is not managed by super-deploy",
  AlterDefaultPrivilegesStmt:
    "default privileges are not managed by super-deploy",
  CreateEnumStmt:
    "enums are not supported; use a lookup table or a CHECK constraint",
  AlterEnumStmt:
    "enums are not supported; a new enum value cannot be used until commit",
  AlterExtensionStmt: "extensions other than plpgsql are not supported",
  AlterExtensionContentsStmt: "extensions other than plpgsql are not supported",
  CreatePLangStmt: "languages other than sql and plpgsql are not supported",
  CreateFdwStmt: "foreign data wrappers are not supported",
  AlterFdwStmt: "foreign data wrappers are not supported",
  CreateForeignServerStmt: "foreign data wrappers are not supported",
  AlterForeignServerStmt: "foreign data wrappers are not supported",
  CreateForeignTableStmt: "foreign tables are not supported",
  CreateUserMappingStmt: "foreign data wrappers are not supported",
  AlterUserMappingStmt: "foreign data wrappers are not supported",
  DropUserMappingStmt: "foreign data wrappers are not supported",
  ImportForeignSchemaStmt: "foreign tables are not supported",
  CreateEventTrigStmt:
    "event triggers are not supported; they run code the rules cannot see",
  AlterEventTrigStmt: "event triggers are not supported",
  RuleStmt: "rules are not supported",
  CreatePublicationStmt: "publications are not supported",
  AlterPublicationStmt: "publications are not supported",
  CreateCastStmt: "custom casts are not supported",
  DefineStmt:
    "custom aggregates, operators, collations, base types and text-search objects are not supported",
  CreateRangeStmt: "range types are not supported",
  CreateOpClassStmt: "operator classes are not supported",
  CreateOpFamilyStmt: "operator families are not supported",
  AlterOpFamilyStmt: "operator families are not supported",
  AlterOperatorStmt: "custom operators are not supported",
  AlterTypeStmt: "base types are not supported",
  CreateConversionStmt: "conversions are not supported",
  CreateTransformStmt: "transforms are not supported",
  CreateAmStmt: "access methods are not supported",
  CreateStatsStmt: "CREATE STATISTICS is not supported",
  AlterStatsStmt: "CREATE STATISTICS is not supported",
  AlterTSDictionaryStmt: "text-search configurations are not supported",
  AlterTSConfigurationStmt: "text-search configurations are not supported",
  AlterCollationStmt: "custom collations are not supported",
  CreateSeqStmt:
    "standalone sequences are not supported; use an identity column",
  SecLabelStmt: "security labels are not supported",
  CreateSchemaStmt: "super-deploy manages exactly one schema",
  AlterObjectSchemaStmt: "super-deploy manages exactly one schema",
  AlterTableSpaceOptionsStmt: "tablespaces are not managed by super-deploy",
  AlterTableMoveAllStmt: "tablespaces are not managed by super-deploy",
};

const ddl = new Set([
  "CreateStmt",
  "AlterTableStmt",
  "IndexStmt",
  "DropStmt",
  "RenameStmt",
  "CreateDomainStmt",
  "AlterDomainStmt",
  "CompositeTypeStmt",
  "ViewStmt",
  "CreateFunctionStmt",
  "AlterFunctionStmt",
  "CreateTrigStmt",
  "CreatePolicyStmt",
  "AlterPolicyStmt",
  "AlterSeqStmt",
]);

const data = new Set([
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
  "TruncateStmt",
]);

function classify(statement: ParsedStatement): Classification {
  const type = statement.nodeType;
  const body = statementBody(statement);
  const name = statementName(statement.nodeType);

  if (type === "TransactionStmt") {
    const kind = String(body.kind ?? "");
    const command =
      kind === "TRANS_STMT_COMMIT" && body.chain === true
        ? "COMMIT AND CHAIN"
        : (transactionKinds[kind] ?? "Transaction control");
    return refuse(
      "transaction-control",
      `${command} ${transactionEffects[kind] ?? "would alter the deploy transaction"}; super-deploy runs every pending migration in one transaction`,
    );
  }
  if (type === "CallStmt") {
    return refuse(
      "call-statement",
      "CALL is not allowed: a procedure can end the deploy transaction, and deploy-time SQL may not call user-defined routines",
    );
  }
  if (type === "DoStmt") {
    return refuse(
      "do-statement",
      "DO is not allowed: its body is code the rules cannot check",
    );
  }
  if (type === "VariableSetStmt") {
    const variable = String(body.name ?? "").toLowerCase();
    if (
      body.kind === "VAR_SET_MULTI" ||
      variable === "transaction_isolation" ||
      variable === "transaction_read_only" ||
      variable === "transaction_deferrable"
    ) {
      return refuse(
        "transaction-control",
        "SET TRANSACTION would alter the deploy transaction; super-deploy runs every pending migration in one transaction",
      );
    }
    return refuse(
      "escapes-transaction",
      `${body.kind === "VAR_RESET" || body.kind === "VAR_RESET_ALL" ? "RESET" : "SET"} is not allowed: super-deploy pins the session settings, and a plain SET outlives the transaction`,
    );
  }
  if (type === "ConstraintsSetStmt") {
    return refuse(
      "escapes-transaction",
      "SET CONSTRAINTS is not allowed: super-deploy checks deferred constraints at each migration boundary",
    );
  }
  if (notInTransaction.has(type)) {
    return refuse(
      "not-in-transaction",
      `${name} cannot run inside a transaction block, and it is outside what super-deploy manages`,
    );
  }
  if (type === "VacuumStmt") {
    return body.is_vacuumcmd === true
      ? refuse(
          "not-in-transaction",
          "VACUUM cannot run inside a transaction block (ANALYZE can)",
        )
      : { class: "maintenance" };
  }
  if (type === "ReindexStmt") {
    const concurrent = hasOption(body.params, "concurrently");
    const kind = String(body.kind ?? "");
    if (concurrent || !/_(TABLE|INDEX)$/.test(kind)) {
      return refuse(
        "not-in-transaction",
        `REINDEX ${concurrent ? "CONCURRENTLY" : kind.replace("REINDEX_OBJECT_", "")} cannot run inside a transaction block`,
      );
    }
    return refuse(
      "deploy-time-statement",
      "REINDEX is not allowed in deploy-time SQL: it locks the table until commit and changes no structure",
    );
  }
  if (type === "ClusterStmt") {
    return body.relation === undefined
      ? refuse(
          "not-in-transaction",
          "CLUSTER without a table cannot run inside a transaction block",
        )
      : refuse(
          "deploy-time-statement",
          "CLUSTER is not allowed in deploy-time SQL: it rewrites the table under an exclusive lock and changes no structure",
        );
  }
  if (type === "DiscardStmt" && body.target === "DISCARD_ALL") {
    return refuse(
      "not-in-transaction",
      "DISCARD ALL cannot run inside a transaction block",
    );
  }
  if (type === "IndexStmt" && body.concurrent === true) {
    return refuse(
      "not-in-transaction",
      "CREATE INDEX CONCURRENTLY cannot run inside a transaction block; use CREATE INDEX (it blocks writes to the table until commit)",
    );
  }
  if (type === "DropStmt" && body.concurrent === true) {
    return refuse(
      "not-in-transaction",
      "DROP INDEX CONCURRENTLY cannot run inside a transaction block; use DROP INDEX",
    );
  }
  if (type === "AlterTableStmt") {
    for (const cmd of alterTableCommands(body)) {
      const partition = unwrap<{ concurrent?: boolean }>(
        cmd.def,
        "PartitionCmd",
      );
      if (
        cmd.subtype === "AT_DetachPartitionFinalize" ||
        (cmd.subtype === "AT_DetachPartition" && partition?.concurrent === true)
      ) {
        return refuse(
          "not-in-transaction",
          "DETACH PARTITION CONCURRENTLY / FINALIZE cannot run inside a transaction block",
        );
      }
    }
  }
  const effect = escaping[type];
  if (effect !== undefined) {
    return refuse(
      "escapes-transaction",
      `${name} is not allowed: it ${effect}`,
    );
  }
  if (type === "CreateExtensionStmt") {
    return body.extname === "plpgsql"
      ? { class: "ddl" }
      : refuse(
          "unsupported-object",
          `CREATE EXTENSION ${String(body.extname ?? "")} is not supported: extensions other than plpgsql run install scripts the rules cannot see`,
        );
  }
  const reason = unsupported[type];
  if (reason !== undefined) {
    return refuse("unsupported-object", `${name} is not supported: ${reason}`);
  }
  if (type === "CreateStmt" || type === "ViewStmt") {
    const relation = (type === "CreateStmt" ? body.relation : body.view) as
      | RangeVar
      | undefined;
    if (relation !== undefined && isTemporary(relation)) {
      if (type === "CreateStmt" && body.oncommit === "ONCOMMIT_DROP") {
        return { class: "temporary" };
      }
      return refuse(
        "temp-table-without-on-commit-drop",
        type === "CreateStmt"
          ? "A temporary table must be created ON COMMIT DROP, or it outlives the deployment in the session"
          : "Temporary views outlive the deployment in the session; use a temporary table created ON COMMIT DROP",
      );
    }
    if (relation?.relpersistence === "u") {
      return refuse("unsupported-object", "Unlogged tables are not supported");
    }
    return { class: "ddl" };
  }
  if (type === "CreateTableAsStmt") {
    const into = body.into as { rel?: RangeVar; onCommit?: string } | undefined;
    if (body.objtype === "OBJECT_MATVIEW") {
      return { class: "ddl" };
    }
    if (into?.rel !== undefined && isTemporary(into.rel)) {
      return into.onCommit === "ONCOMMIT_DROP"
        ? { class: "temporary" }
        : refuse(
            "temp-table-without-on-commit-drop",
            "A temporary table must be created ON COMMIT DROP, or it outlives the deployment in the session",
          );
    }
    return refuse(
      "deploy-time-statement",
      "CREATE TABLE AS creates a permanent table outside the desired schema; stage data in CREATE TEMP TABLE ... ON COMMIT DROP AS ... instead",
    );
  }
  if (type === "SelectStmt") {
    return body.intoClause !== undefined
      ? refuse(
          "deploy-time-statement",
          "SELECT INTO creates a permanent table outside the desired schema; stage data in CREATE TEMP TABLE ... ON COMMIT DROP AS ... instead",
        )
      : refuse(
          "deploy-time-statement",
          "A standalone SELECT is not allowed: its result goes nowhere in a deployment",
        );
  }
  if (type === "RefreshMatViewStmt") {
    return body.concurrent === true
      ? refuse(
          "deploy-time-statement",
          "REFRESH MATERIALIZED VIEW CONCURRENTLY is not allowed; use a plain REFRESH MATERIALIZED VIEW",
        )
      : { class: "maintenance" };
  }
  if (type === "LockStmt") {
    return { class: "maintenance" };
  }
  if (type === "GrantStmt" || type === "CommentStmt") {
    return { class: "privileges" };
  }
  if (ddl.has(type)) {
    return { class: "ddl" };
  }
  if (data.has(type)) {
    return { class: "data" };
  }
  return refuse(
    "deploy-time-statement",
    `${name} is not allowed in deploy-time SQL`,
  );
}

function wrongKind(
  statement: ParsedStatement,
  kind: DeployTimeKind,
  statementClass: StatementClass,
): Finding {
  const name = statementName(statement.nodeType);
  const where = `${name} is not allowed in ${kindNames[kind]}`;
  let why: string;
  if (kind === "seed-data") {
    why = "seed data may contain only INSERT statements with a column list";
  } else if (kind === "schema-change") {
    why = "a generated schema change contains only DDL, grants and comments";
  } else if (statementClass === "privileges") {
    why = "grants and comments belong in the desired schema";
  } else {
    why =
      "post-migration scripts may only change data; structure belongs in the desired schema or the pre-migration script";
  }
  return { rule: "deploy-time-statement", message: `${where}: ${why}` };
}

// ---------------------------------------------------------------------------
// Layer 2: statement details

const alterTableAllowed = new Set([
  "AT_AddColumn",
  "AT_ColumnDefault",
  "AT_DropNotNull",
  "AT_SetNotNull",
  "AT_SetExpression",
  "AT_DropExpression",
  "AT_SetStatistics",
  "AT_SetOptions",
  "AT_ResetOptions",
  "AT_SetStorage",
  "AT_SetCompression",
  "AT_DropColumn",
  "AT_AddConstraint",
  "AT_AlterConstraint",
  "AT_ValidateConstraint",
  "AT_DropConstraint",
  "AT_AlterColumnType",
  "AT_ClusterOn",
  "AT_DropCluster",
  "AT_SetRelOptions",
  "AT_ResetRelOptions",
  "AT_ReplaceRelOptions",
  "AT_EnableTrig",
  "AT_EnableAlwaysTrig",
  "AT_EnableReplicaTrig",
  "AT_DisableTrig",
  "AT_EnableTrigAll",
  "AT_DisableTrigAll",
  "AT_EnableTrigUser",
  "AT_DisableTrigUser",
  "AT_ReplicaIdentity",
  "AT_EnableRowSecurity",
  "AT_DisableRowSecurity",
  "AT_ForceRowSecurity",
  "AT_NoForceRowSecurity",
  "AT_AddIdentity",
  "AT_SetIdentity",
  "AT_DropIdentity",
]);

const alterTableUnsupported: Record<string, string> = {
  AT_ChangeOwner: "ownership is not managed by super-deploy",
  AT_SetLogged: "unlogged tables are not supported",
  AT_SetUnLogged: "unlogged tables are not supported",
  AT_SetTableSpace: "tablespaces are not managed by super-deploy",
  AT_SetAccessMethod: "table access methods are not managed by super-deploy",
  AT_AddInherit: "table inheritance is not supported",
  AT_DropInherit: "table inheritance is not supported",
  AT_AddOf: "typed tables are not supported",
  AT_DropOf: "typed tables are not supported",
  AT_AttachPartition: "partitioned tables are not supported",
  AT_DetachPartition: "partitioned tables are not supported",
  AT_GenericOptions: "foreign tables are not supported",
  AT_AlterColumnGenericOptions: "foreign tables are not supported",
  AT_EnableRule: "rules are not supported",
  AT_EnableAlwaysRule: "rules are not supported",
  AT_EnableReplicaRule: "rules are not supported",
  AT_DisableRule: "rules are not supported",
};

/** Object types DROP, ALTER ... RENAME and COMMENT ON may name. */
const managedObjectTypes = new Set([
  "OBJECT_TABLE",
  "OBJECT_COLUMN",
  "OBJECT_VIEW",
  "OBJECT_MATVIEW",
  "OBJECT_INDEX",
  "OBJECT_TABCONSTRAINT",
  "OBJECT_DOMCONSTRAINT",
  "OBJECT_FUNCTION",
  "OBJECT_PROCEDURE",
  "OBJECT_ROUTINE",
  "OBJECT_TRIGGER",
  "OBJECT_POLICY",
  "OBJECT_TYPE",
  "OBJECT_DOMAIN",
  "OBJECT_ATTRIBUTE",
  "OBJECT_SEQUENCE",
]);

/** Object types GRANT and REVOKE may name. */
const grantableObjectTypes = new Set([
  "OBJECT_TABLE",
  "OBJECT_SEQUENCE",
  "OBJECT_FUNCTION",
  "OBJECT_PROCEDURE",
  "OBJECT_ROUTINE",
  "OBJECT_TYPE",
  "OBJECT_DOMAIN",
  "OBJECT_SCHEMA",
]);

const serialTypes = new Set([
  "serial",
  "serial2",
  "serial4",
  "serial8",
  "smallserial",
  "bigserial",
]);

function detailFindings(
  statement: ParsedStatement,
  state: MigrationState,
): Finding[] {
  const type = statement.nodeType;
  const body = statementBody(statement);
  const findings: Finding[] = [];
  const unsupportedFeature = (message: string) =>
    findings.push({ rule: "unsupported-object", message });

  if (type === "CreateStmt") {
    const create = body as CreateStmt;
    if (create.partspec !== undefined || create.partbound !== undefined) {
      unsupportedFeature("Partitioned tables are not supported");
    }
    if ((create.inhRelations ?? []).length > 0) {
      unsupportedFeature("Table inheritance is not supported");
    }
    if (create.ofTypename !== undefined) {
      unsupportedFeature(
        "Typed tables (CREATE TABLE ... OF) are not supported",
      );
    }
    for (const element of create.tableElts ?? []) {
      const column = unwrap<ColumnDef>(element, "ColumnDef");
      findings.push(...(column ? columnFindings(column) : []));
      const constraint = unwrap<Constraint>(element, "Constraint");
      findings.push(...(constraint ? constraintFindings(constraint) : []));
    }
  }
  if (type === "AlterTableStmt") {
    if (body.objtype === "OBJECT_FOREIGN_TABLE") {
      unsupportedFeature("Foreign tables are not supported");
    }
    for (const cmd of alterTableCommands(body)) {
      const subtype = String(cmd.subtype ?? "");
      const reason = alterTableUnsupported[subtype];
      if (reason !== undefined) {
        unsupportedFeature(
          `ALTER TABLE ... ${alterTableCommandName(subtype)} is not supported: ${reason}`,
        );
      } else if (!alterTableAllowed.has(subtype)) {
        findings.push({
          rule: "deploy-time-statement",
          message: `ALTER TABLE ... ${alterTableCommandName(subtype)} is not allowed in deploy-time SQL`,
        });
      }
      const column = unwrap<ColumnDef>(cmd.def, "ColumnDef");
      if (column !== undefined && subtype === "AT_AddColumn") {
        findings.push(...columnFindings(column));
      }
      if (
        column?.raw_default !== undefined &&
        subtype === "AT_AlterColumnType"
      ) {
        // USING runs for every existing row during the deployment.
        findings.push(
          ...expressionFindings(column.raw_default, "executed", state),
        );
      }
      const constraint = unwrap<Constraint>(cmd.def, "Constraint");
      findings.push(...(constraint ? constraintFindings(constraint) : []));
    }
  }
  if (type === "DropStmt") {
    const drop = body as DropStmt;
    if (!managedObjectTypes.has(drop.removeType ?? "")) {
      unsupportedFeature(
        `DROP ${objectTypeKeyword(drop.removeType)} is not supported: super-deploy manages only the objects in its schema`,
      );
    }
  }
  if (type === "RenameStmt") {
    const rename = body as RenameStmt;
    if (!managedObjectTypes.has(rename.renameType ?? "")) {
      unsupportedFeature(
        `Renaming a ${objectTypeName(rename.renameType)} is not supported: super-deploy manages only the objects in its schema`,
      );
    }
  }
  if (type === "CommentStmt") {
    if (
      !managedObjectTypes.has(String(body.objtype ?? "")) &&
      body.objtype !== "OBJECT_SCHEMA"
    ) {
      unsupportedFeature(
        `COMMENT ON ${objectTypeKeyword(body.objtype)} is not supported: super-deploy manages only the objects in its schema`,
      );
    }
  }
  if (type === "GrantStmt") {
    const grant = body as GrantStmt;
    if (!grantableObjectTypes.has(grant.objtype ?? "")) {
      unsupportedFeature(
        `GRANT and REVOKE on a ${objectTypeName(grant.objtype)} are not supported: super-deploy manages only the objects in its schema`,
      );
    }
    // The desired schema grants only USAGE on the managed schema; CREATE
    // belongs to the deploy role's setup outside super-deploy.
    const privileges = (grant.privileges ?? []).map(
      (privilege) =>
        unwrap<{ priv_name?: string }>(privilege, "AccessPriv")?.priv_name ??
        "all",
    );
    if (
      grant.objtype === "OBJECT_SCHEMA" &&
      grant.is_grant === true &&
      (privileges.length === 0 ||
        privileges.some((privilege) => privilege !== "usage"))
    ) {
      unsupportedFeature(
        "GRANT on a schema may grant only USAGE: CREATE on the managed schema is set up outside super-deploy",
      );
    }
  }
  if (type === "CreateFunctionStmt") {
    const language = functionLanguage(body as CreateFunctionStmt);
    if (language !== "sql" && language !== "plpgsql") {
      unsupportedFeature(
        `LANGUAGE ${language} is not supported: routines may be written only in sql or plpgsql`,
      );
    }
  }
  return findings;
}

function columnFindings(column: ColumnDef): Finding[] {
  const findings: Finding[] = [];
  const typeNames = stringList(column.typeName?.names);
  const last = typeNames.at(-1);
  if (
    last !== undefined &&
    serialTypes.has(last) &&
    (typeNames.length === 1 || typeNames[0] === "pg_catalog")
  ) {
    findings.push({
      rule: "unsupported-object",
      message: `${last} columns are not supported: they create a standalone sequence; use GENERATED ... AS IDENTITY`,
    });
  }
  for (const item of column.constraints ?? []) {
    const constraint = unwrap<Constraint>(item, "Constraint");
    findings.push(...(constraint ? constraintFindings(constraint) : []));
  }
  return findings;
}

function constraintFindings(constraint: Constraint): Finding[] {
  if (
    constraint.contype === "CONSTR_GENERATED" &&
    constraint.generated_kind === "v"
  ) {
    return [
      {
        rule: "unsupported-object",
        message:
          "Virtual generated columns are not supported (PostgreSQL 18 makes a generated column virtual unless it says STORED); add STORED",
      },
    ];
  }
  if (
    constraint.contype === "CONSTR_ATTR_NOT_ENFORCED" ||
    ((constraint.contype === "CONSTR_CHECK" ||
      constraint.contype === "CONSTR_FOREIGN") &&
      constraint.is_enforced !== true)
  ) {
    return [
      {
        rule: "unsupported-object",
        message: "NOT ENFORCED constraints are not supported",
      },
    ];
  }
  return [];
}

function functionLanguage(create: CreateFunctionStmt): string {
  for (const option of create.options ?? []) {
    const element = unwrap<{ defname?: string; arg?: Node }>(option, "DefElem");
    if (element?.defname === "language") {
      return unwrap<{ sval?: string }>(element.arg, "String")?.sval ?? "";
    }
  }
  // A BEGIN ATOMIC or RETURN body is SQL; anything else needs a LANGUAGE.
  return create.sql_body !== undefined ? "sql" : "";
}

function alterTableCommandName(subtype: string): string {
  return subtype
    .replace(/^AT_/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// Layer 3: expressions

type ExpressionMode =
  /** Runs during the deployment (DML, temp-table staging, USING). */
  | "executed"
  /** Stored in a definition (defaults, checks, views, policies, indexes). */
  | "stored";

/** Fields naming the relation a statement writes to. */
const writeTargetFields: Record<string, readonly string[]> = {
  InsertStmt: ["relation"],
  UpdateStmt: ["relation"],
  DeleteStmt: ["relation"],
  MergeStmt: ["relation"],
  TruncateStmt: ["relations"],
  LockStmt: ["relations"],
  AlterTableStmt: ["relation"],
  IndexStmt: ["relation"],
  CreateStmt: ["relation"],
  ViewStmt: ["view"],
  CreateTableAsStmt: ["into"],
  RenameStmt: ["relation"],
  CreateTrigStmt: ["relation"],
  CreatePolicyStmt: ["table"],
  AlterPolicyStmt: ["table"],
  RefreshMatViewStmt: ["relation"],
  VacuumStmt: ["rels"],
  GrantStmt: ["objects"],
  CompositeTypeStmt: ["typevar"],
  AlterSeqStmt: ["sequence"],
};

/**
 * Function calls and references in one statement or expression. `mode`
 * decides whether calling a user-defined function is a violation: stored
 * definitions may (the desired schema defines them), executed SQL may not.
 */
function expressionFindings(
  root: unknown,
  mode: ExpressionMode,
  state: MigrationState,
): Finding[] {
  const findings: Finding[] = [];
  const writeTargets = new Set<unknown>();
  const creating = new Set<unknown>();
  walkNodes(root, ({ type, node }) => {
    for (const field of writeTargetFields[type] ?? []) {
      walkNodes(node[field], (inner) => {
        if (inner.type === "RangeVar") {
          writeTargets.add(inner.node);
        }
      });
    }
    if (type === "CreateFunctionStmt") {
      // Routine bodies get the body rules (routineBodyFindings); only the
      // signature is checked here.
      const create = node as CreateFunctionStmt;
      findings.push(
        ...nameFindings(stringList(create.funcname), 1, "write", state),
        ...expressionFindings(
          { parameters: create.parameters, returnType: create.returnType },
          mode,
          state,
        ),
      );
      return false;
    }
    if (type === "FuncCall") {
      findings.push(...functionCallFindings(node, mode, state));
    }
    if (type === "CreateStmt") {
      creating.add(node.relation);
    }
    if (type === "CreateTableAsStmt") {
      creating.add((node.into as { rel?: unknown } | undefined)?.rel);
    }
    if (type === "RangeVar") {
      findings.push(
        ...rangeVarFindings(
          node as RangeVar,
          creating.has(node)
            ? "create"
            : writeTargets.has(node)
              ? "write"
              : "read",
          state,
        ),
      );
    }
    if (type === "TypeName" && (node as TypeName).pct_type !== true) {
      findings.push(
        ...nameFindings(stringList((node as TypeName).names), 1, "read", state),
      );
    }
    if (type === "ObjectWithArgs") {
      findings.push(
        ...nameFindings(
          stringList((node as ObjectWithArgs).objname),
          1,
          "write",
          state,
        ),
      );
      return false;
    }
    if (
      type === "DropStmt" ||
      type === "CommentStmt" ||
      type === "RenameStmt"
    ) {
      findings.push(...objectNameFindings(type, node, state));
    }
    if (type === "GrantStmt") {
      for (const object of (node as GrantStmt).objects ?? []) {
        const schema = unwrap<{ sval?: string }>(object, "String");
        if (schema !== undefined) {
          findings.push(...schemaFindings(schema.sval ?? "", "write", state));
        }
      }
    }
    if (type === "CreateDomainStmt") {
      findings.push(
        ...nameFindings(
          stringList(node.domainname as Node[]),
          1,
          "write",
          state,
        ),
      );
    }
    if (type === "AlterDomainStmt") {
      findings.push(
        ...nameFindings(stringList(node.typeName as Node[]), 1, "write", state),
      );
    }
    if (type === "CreateTrigStmt") {
      findings.push(
        ...nameFindings(stringList(node.funcname as Node[]), 1, "read", state),
      );
    }
    return undefined;
  });
  return findings;
}

function functionCallFindings(
  call: Json,
  mode: ExpressionMode,
  state: MigrationState,
): Finding[] {
  const parts = stringList(call.funcname as Node[]);
  const name = parts.at(-1) ?? "";
  const schema = parts.length >= 2 ? parts.at(-2) : undefined;
  const display = `${qualifiedName(parts)}()`;
  const denied = denylistedCall(call);
  if (denied !== undefined) {
    return [{ rule: "denylisted-call", message: denied.message }];
  }
  if (
    parts.length > 3 ||
    (schema !== undefined &&
      schema !== "pg_catalog" &&
      schema !== state.managedSchema)
  ) {
    return [outsideManagedSchema(display, state)];
  }
  if (mode === "stored") {
    return [];
  }
  const builtin =
    (schema === undefined || schema === "pg_catalog") &&
    pgCatalogFunctions.has(name);
  return builtin
    ? []
    : [
        {
          rule: "user-function-call",
          message: `${display} is not a built-in pg_catalog function; deploy-time SQL may not call user-defined functions`,
        },
      ];
}

function rangeVarFindings(
  range: RangeVar,
  access: "read" | "write" | "create",
  state: MigrationState,
): Finding[] {
  const write = access !== "read";
  const display = qualifiedName(
    [range.catalogname, range.schemaname, range.relname].filter(
      (part): part is string => part !== undefined,
    ),
  );
  const schema = range.schemaname;
  const relation = range.relname ?? "";
  if (range.catalogname !== undefined) {
    return [outsideManagedSchema(display, state)];
  }
  if (schema === undefined) {
    return write &&
      pgCatalogRelations.has(relation) &&
      !state.temporary.has(relation)
      ? [catalogWrite(display, state)]
      : [];
  }
  if (schema === "pg_temp") {
    return access === "create" || state.temporary.has(relation)
      ? []
      : [
          {
            rule: "outside-managed-schema",
            message: `${display} is not a temporary table created earlier in this migration`,
          },
        ];
  }
  return schemaFindings(schema, write ? "write" : "read", state, display);
}

/** A qualified object name: the schema is the part before the last `trailing` parts. */
function nameFindings(
  parts: readonly string[],
  trailing: number,
  access: "read" | "write",
  state: MigrationState,
): Finding[] {
  if (parts.length <= trailing) {
    return [];
  }
  if (parts.length > trailing + 1) {
    return [outsideManagedSchema(qualifiedName(parts), state)];
  }
  return schemaFindings(parts[0] ?? "", access, state, qualifiedName(parts));
}

function schemaFindings(
  schema: string,
  access: "read" | "write",
  state: MigrationState,
  display = schema,
): Finding[] {
  if (schema === state.managedSchema) {
    return [];
  }
  if (schema === "pg_catalog") {
    return access === "read" ? [] : [catalogWrite(display, state)];
  }
  return [outsideManagedSchema(display, state)];
}

/** Object names in DROP, COMMENT ON and ALTER ... RENAME, which are lists of identifiers. */
function objectNameFindings(
  type: string,
  node: Json,
  state: MigrationState,
): Finding[] {
  const objectType = String(
    (type === "DropStmt"
      ? node.removeType
      : type === "RenameStmt"
        ? node.renameType
        : node.objtype) ?? "",
  );
  // Columns, constraints, triggers and policies are named table.name.
  const trailing = [
    "OBJECT_COLUMN",
    "OBJECT_TABCONSTRAINT",
    "OBJECT_TRIGGER",
    "OBJECT_POLICY",
    "OBJECT_RULE",
  ].includes(objectType)
    ? 2
    : 1;
  const objects =
    type === "DropStmt" ? ((node.objects as unknown[]) ?? []) : [node.object];
  const findings: Finding[] = [];
  for (const object of objects) {
    const list = unwrap<{ items?: Node[] }>(object, "List");
    if (list !== undefined) {
      findings.push(
        ...nameFindings(stringList(list.items), trailing, "write", state),
      );
    }
    const schema = unwrap<{ sval?: string }>(object, "String");
    if (schema !== undefined && objectType === "OBJECT_SCHEMA") {
      findings.push(...schemaFindings(schema.sval ?? "", "write", state));
    }
  }
  return findings;
}

function outsideManagedSchema(display: string, state: MigrationState): Finding {
  return {
    rule: "outside-managed-schema",
    message: `${display} is outside the managed schema ${state.managedSchema}; deploy-time SQL may reference only the managed schema, the migration's own temporary tables and pg_catalog (read-only)`,
  };
}

function catalogWrite(display: string, state: MigrationState): Finding {
  return {
    rule: "catalog-write",
    message: `${display} is in pg_catalog, which deploy-time SQL may read but never change${display.includes(".") ? "" : ` (qualify it as ${state.managedSchema}.${display} if you mean your own table)`}`,
  };
}

// Column order and identity columns (scripts and seed data only). Generated
// schema changes are exempt: their view and routine definitions are
// PostgreSQL's own deparse of the desired schema, whose rules cover them.

function scriptFindings(root: unknown, state: MigrationState): Finding[] {
  const findings: Finding[] = [];
  const relations = relationNamesIn(root);
  walkNodes(root, ({ type, node }) => {
    if (type === "CreateFunctionStmt") {
      return false;
    }
    if (type === "ColumnRef") {
      const fields = (node.fields as Node[] | undefined) ?? [];
      if (fields.some((field) => wrapped(field)?.[0] === "A_Star")) {
        findings.push({
          rule: "select-star",
          message:
            "* expands to the columns in their physical order, which differs between a rehearsal and a long-lived target; list the columns",
        });
      } else if (fields.length === 1) {
        const name = unwrap<{ sval?: string }>(fields[0], "String")?.sval;
        if (name !== undefined && relations.has(name)) {
          findings.push({
            rule: "whole-row-reference",
            message: `${name} refers to the whole row of ${name}, which depends on column order; list the columns (write ${name}.${name} if you mean a column named ${name})`,
          });
        }
      }
    }
    if (type === "SelectStmt") {
      const select = node as SelectStmt;
      const ordinal = (items: readonly Node[] | undefined, clause: string) => {
        if ((items ?? []).some(isOrdinal)) {
          findings.push({
            rule: "ordinal-reference",
            message: `${clause} by position depends on the order of the output columns; name the expressions instead`,
          });
        }
      };
      ordinal(
        (select.sortClause ?? []).map(
          (item) => unwrap<{ node?: Node }>(item, "SortBy")?.node ?? item,
        ),
        "ORDER BY",
      );
      ordinal(groupItems(select.groupClause), "GROUP BY");
      ordinal(select.distinctClause, "DISTINCT ON");
    }
    if (type === "JoinExpr" && node.isNatural === true) {
      findings.push({
        rule: "natural-join",
        message:
          "NATURAL JOIN joins on every column with a matching name and changes silently when one is added; use JOIN ... ON or USING",
      });
    }
    if (type === "InsertStmt") {
      findings.push(...insertFindings(node as InsertStmt, state));
    }
    if (type === "UpdateStmt") {
      const update = node as UpdateStmt;
      findings.push(
        ...identityAssignments(update.relation, update.targetList, state),
      );
    }
    if (type === "MergeStmt") {
      findings.push(...mergeFindings(node as MergeStmt, state));
    }
    return undefined;
  });
  return findings;
}

function isOrdinal(item: Node): boolean {
  const constant = unwrap<{ ival?: unknown }>(item, "A_Const");
  return constant?.ival !== undefined;
}

function groupItems(items: readonly Node[] | undefined): Node[] {
  return (items ?? []).flatMap((item) => {
    const set = unwrap<{ content?: Node[] }>(item, "GroupingSet");
    return set === undefined ? [item] : groupItems(set.content);
  });
}

/** Names a bare identifier could use to refer to a whole row in this statement. */
function relationNamesIn(root: unknown): Set<string> {
  const relations = new Set<string>();
  walkNodes(root, ({ type, node, key }) => {
    if (
      type === "CreateStmt" ||
      type === "CreateFunctionStmt" ||
      key === "rel"
    ) {
      return false;
    }
    const alias = (node.alias as { aliasname?: string } | undefined)?.aliasname;
    if (type === "RangeVar") {
      relations.add(alias ?? String(node.relname ?? ""));
    } else if (alias !== undefined) {
      relations.add(alias);
    }
    if (type === "InsertStmt" && node.onConflictClause !== undefined) {
      relations.add("excluded");
    }
    if (node.returningClause !== undefined) {
      relations.add("old");
      relations.add("new");
    }
    if (type === "ReturningOption" && typeof node.value === "string") {
      relations.add(node.value);
    }
    return undefined;
  });
  relations.delete("");
  return relations;
}

function insertFindings(insert: InsertStmt, state: MigrationState): Finding[] {
  const findings: Finding[] = [];
  if (insert.selectStmt !== undefined && (insert.cols ?? []).length === 0) {
    findings.push({
      rule: "insert-without-columns",
      message:
        "INSERT without a column list fills columns in their physical order, which differs between a rehearsal and a long-lived target; list the columns",
    });
  }
  findings.push(
    ...identityInsert(insert.relation, insert.cols, insert.override, state),
  );
  return findings;
}

function mergeFindings(merge: MergeStmt, state: MigrationState): Finding[] {
  const findings: Finding[] = [];
  for (const item of merge.mergeWhenClauses ?? []) {
    const clause = unwrap<MergeWhenClause>(item, "MergeWhenClause");
    if (clause?.commandType === "CMD_INSERT") {
      if (
        (clause.values ?? []).length > 0 &&
        (clause.targetList ?? []).length === 0
      ) {
        findings.push({
          rule: "insert-without-columns",
          message:
            "MERGE ... INSERT without a column list fills columns in their physical order; list the columns",
        });
      }
      findings.push(
        ...identityInsert(
          merge.relation,
          clause.targetList,
          clause.override,
          state,
        ),
      );
    }
    if (clause?.commandType === "CMD_UPDATE") {
      findings.push(
        ...identityAssignments(merge.relation, clause.targetList, state),
      );
    }
  }
  return findings;
}

function identityInsert(
  relation: RangeVar | undefined,
  columns: readonly Node[] | undefined,
  override: string | undefined,
  state: MigrationState,
): Finding[] {
  if (override === "OVERRIDING_SYSTEM_VALUE") {
    return [
      {
        rule: "identity-value",
        message:
          "OVERRIDING SYSTEM VALUE writes explicit values into identity columns, so the sequence falls behind and later inserts collide; let the identity assign them",
      },
    ];
  }
  if (override === "OVERRIDING_USER_VALUE") {
    return [];
  }
  return identityColumnsNamed(relation, columns, state, () => true);
}

function identityAssignments(
  relation: RangeVar | undefined,
  targets: readonly Node[] | undefined,
  state: MigrationState,
): Finding[] {
  return identityColumnsNamed(
    relation,
    targets,
    state,
    (target) => unwrap(target.val, "SetToDefault") === undefined,
  );
}

function identityColumnsNamed(
  relation: RangeVar | undefined,
  targets: readonly Node[] | undefined,
  state: MigrationState,
  explicit: (target: ResTarget) => boolean,
): Finding[] {
  const table = managedTableName(relation, state);
  const identity = table === undefined ? undefined : state.identity.get(table);
  if (identity === undefined) {
    return [];
  }
  return (targets ?? []).flatMap((item) => {
    const target = unwrap<ResTarget>(item, "ResTarget");
    if (
      target?.name === undefined ||
      !identity.has(target.name) ||
      !explicit(target)
    ) {
      return [];
    }
    return [
      {
        rule: "identity-value" as const,
        message: `${table}.${target.name} is an identity column; explicit values let its sequence fall behind and later inserts collide, so leave it out`,
      },
    ];
  });
}

function managedTableName(
  relation: RangeVar | undefined,
  state: MigrationState,
): string | undefined {
  if (
    relation?.relname === undefined ||
    (relation.schemaname !== undefined &&
      relation.schemaname !== state.managedSchema)
  ) {
    return undefined;
  }
  return relation.relname;
}

// ---------------------------------------------------------------------------

function checkStatement(
  statement: ParsedStatement,
  kind: DeployTimeKind,
  state: MigrationState,
): Finding[] {
  const classification = classify(statement);
  if ("refused" in classification) {
    return [classification.refused];
  }
  if (
    !allowedClasses[kind].includes(classification.class) ||
    (kind === "seed-data" && statement.nodeType !== "InsertStmt")
  ) {
    return [wrongKind(statement, kind, classification.class)];
  }
  const executed =
    classification.class === "data" || classification.class === "temporary";
  return [
    ...detailFindings(statement, state),
    ...expressionFindings(
      statement.node,
      executed ? "executed" : "stored",
      state,
    ),
    ...(kind === "schema-change" ? [] : scriptFindings(statement.node, state)),
    ...routineBodyFindings(statement, state),
  ];
}

/**
 * The PL/pgSQL body rules (and LANGUAGE sql string bodies), shared with the
 * desired schema: a routine created by a schema change or a pre-migration
 * script can't smuggle in what scripts may not do.
 */
function routineBodyFindings(
  statement: ParsedStatement,
  state: MigrationState,
): Finding[] {
  if (statement.nodeType !== "CreateFunctionStmt") {
    return [];
  }
  const create = statementBody(statement) as CreateFunctionStmt;
  const language = functionLanguage(create);
  const body = create.options
    ?.map((option) =>
      unwrap<{ defname?: string; arg?: Node }>(option, "DefElem"),
    )
    .find((option) => option?.defname === "as")?.arg;
  const context: RuleContext = {
    managedSchema: state.managedSchema,
    externalSchemas: state.externalSchemas,
  };
  const findings =
    language === "plpgsql"
      ? plpgsqlFindings(statement, body, context)
      : language === "sql" && create.sql_body === undefined
        ? sqlBodyFindings(statement, body, context)
        : [];
  return findings as Finding[];
}

/** Updates the migration's state after a statement: temporary tables and identity columns. */
function remember(statement: ParsedStatement, state: MigrationState): void {
  const body = statementBody(statement);
  const addIdentity = (
    table: string | undefined,
    column: string | undefined,
  ) => {
    if (table === undefined || column === undefined) {
      return;
    }
    const columns = state.identity.get(table) ?? new Set<string>();
    columns.add(column);
    state.identity.set(table, columns);
  };
  if (
    statement.nodeType === "CreateStmt" ||
    statement.nodeType === "CreateTableAsStmt"
  ) {
    const relation = (
      statement.nodeType === "CreateStmt"
        ? body.relation
        : (body.into as { rel?: RangeVar } | undefined)?.rel
    ) as RangeVar | undefined;
    if (relation !== undefined && isTemporary(relation) && relation.relname) {
      state.temporary.add(relation.relname);
    }
    for (const element of (body.tableElts as Node[] | undefined) ?? []) {
      const column = unwrap<ColumnDef>(element, "ColumnDef");
      if (column !== undefined && isIdentity(column)) {
        addIdentity(relation?.relname, column.colname);
      }
    }
  }
  if (statement.nodeType === "AlterTableStmt") {
    const table = (body.relation as RangeVar | undefined)?.relname;
    for (const cmd of alterTableCommands(body)) {
      const column = unwrap<ColumnDef>(cmd.def, "ColumnDef");
      if (
        cmd.subtype === "AT_AddColumn" &&
        column !== undefined &&
        isIdentity(column)
      ) {
        addIdentity(table, column.colname);
      }
      if (cmd.subtype === "AT_AddIdentity") {
        addIdentity(table, cmd.name);
      }
    }
  }
}

function isIdentity(column: ColumnDef): boolean {
  return (column.constraints ?? []).some(
    (item) =>
      unwrap<Constraint>(item, "Constraint")?.contype === "CONSTR_IDENTITY",
  );
}

function isTemporary(relation: RangeVar): boolean {
  return relation.relpersistence === "t" || relation.schemaname === "pg_temp";
}

function hasOption(options: unknown, name: string): boolean {
  return (Array.isArray(options) ? options : []).some(
    (option) =>
      unwrap<{ defname?: string }>(option, "DefElem")?.defname === name,
  );
}

function qualifiedName(parts: readonly (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined).join(".");
}
