// The side-effect denylist: built-in functions whose effects escape the
// deploy transaction (not undone by a rollback, or outliving it), from
// research/transactional-hazards.md §2. Shared by the desired-schema rules
// (including PL/pgSQL bodies) and the deploy-time rules (ticket 06).
// Volatile built-ins such as now() and gen_random_uuid() stay allowed.
import type { RuleFinding } from "./rule-types.ts";
import { type Json, list, stringList, unwrap, walk } from "./syntax-tree.ts";

const sequences = "changes a sequence outside the transaction";
const advisory = "takes or releases a session-level advisory lock";
const notify = "sends a notification other sessions act on";
const remote = "runs work in another session that a rollback cannot undo";
const files = "reads or writes server files or large objects";
const admin = "signals or administers the server";
const replication = "changes replication state outside the transaction";
const settings = "changes a setting for the rest of the session";
const sleep = "holds every lock of the deployment while it sleeps";
const snapshot = "exports a snapshot other sessions can use";
const statistics =
  "overwrites planner statistics in place, outside the transaction";

const byName: ReadonlyMap<string, string> = new Map([
  ["setval", sequences],
  ["pg_advisory_lock", advisory],
  ["pg_advisory_lock_shared", advisory],
  ["pg_try_advisory_lock", advisory],
  ["pg_try_advisory_lock_shared", advisory],
  ["pg_advisory_unlock", advisory],
  ["pg_advisory_unlock_shared", advisory],
  ["pg_advisory_unlock_all", advisory],
  ["pg_notify", notify],
  ["lo_import", files],
  ["lo_export", files],
  ["lo_create", files],
  ["lo_creat", files],
  ["lo_unlink", files],
  ["lo_put", files],
  ["lo_from_bytea", files],
  ["lo_truncate", files],
  ["lo_truncate64", files],
  ["lowrite", files],
  ["pg_read_file", files],
  ["pg_read_binary_file", files],
  ["pg_stat_file", files],
  ["pg_terminate_backend", admin],
  ["pg_cancel_backend", admin],
  ["pg_reload_conf", admin],
  ["pg_rotate_logfile", admin],
  ["pg_switch_wal", admin],
  ["pg_create_restore_point", admin],
  ["pg_log_backend_memory_contexts", admin],
  ["pg_promote", admin],
  ["pg_wal_replay_pause", admin],
  ["pg_wal_replay_resume", admin],
  ["pg_backup_start", admin],
  ["pg_backup_stop", admin],
  ["pg_log_standby_snapshot", admin],
  ["pg_import_system_collations", admin],
  ["pg_sleep", sleep],
  ["pg_sleep_for", sleep],
  ["pg_sleep_until", sleep],
  ["pg_export_snapshot", snapshot],
  ["pg_restore_relation_stats", statistics],
  ["pg_restore_attribute_stats", statistics],
  ["pg_clear_relation_stats", statistics],
  ["pg_clear_attribute_stats", statistics],
  ["pg_create_physical_replication_slot", replication],
  ["pg_create_logical_replication_slot", replication],
  ["pg_drop_replication_slot", replication],
  ["pg_copy_physical_replication_slot", replication],
  ["pg_copy_logical_replication_slot", replication],
  ["pg_replication_slot_advance", replication],
  ["pg_logical_emit_message", replication],
  ["pg_sync_replication_slots", replication],
]);

const byPrefix: readonly (readonly [string, string])[] = [
  ["dblink", remote],
  ["pg_ls_", files],
  ["pg_stat_reset", admin],
  ["pg_replication_origin_", replication],
  ["pg_logical_slot_", replication],
];

/**
 * Why a call to the built-in `name` escapes the transaction, or undefined if
 * it doesn't. `isLocal` is set_config's third argument when it is a literal.
 */
export function denylistReason(
  name: string,
  isLocal?: boolean,
): string | undefined {
  if (name === "set_config") {
    return isLocal === true ? undefined : settings;
  }
  return (
    byName.get(name) ??
    byPrefix.find(([prefix]) => name.startsWith(prefix))?.[1]
  );
}

/**
 * `denylisted-call` findings for every call in a syntax tree to a
 * denylisted built-in (unqualified or `pg_catalog.`-qualified).
 */
export function denylistFindings(node: unknown, line?: number): RuleFinding[] {
  const findings: RuleFinding[] = [];
  walk(node, (object) => {
    const call = unwrap(object, "FuncCall");
    const finding = call === undefined ? undefined : denylistedCall(call, line);
    if (finding !== undefined) {
      findings.push(finding);
    }
  });
  return findings;
}

/**
 * A `denylisted-call` finding if the FuncCall node `call` (its unwrapped
 * body) calls a denylisted built-in, unqualified or `pg_catalog.`-qualified.
 */
export function denylistedCall(
  call: Json,
  line?: number,
): RuleFinding | undefined {
  const names = stringList(call.funcname);
  const name = names.at(-1);
  if (
    name === undefined ||
    names.length > 2 ||
    (names.length === 2 && names[0] !== "pg_catalog")
  ) {
    return undefined;
  }
  const third = unwrap(list(call.args)[2], "A_Const");
  const isLocal =
    third === undefined
      ? undefined
      : unwrap(third, "boolval")?.boolval === true;
  const reason = denylistReason(name, isLocal);
  return reason === undefined
    ? undefined
    : {
        rule: "denylisted-call",
        message: `${name}() is not allowed: it ${reason}, which a failed deployment's rollback cannot undo`,
        ...(line === undefined ? {} : { line }),
      };
}
