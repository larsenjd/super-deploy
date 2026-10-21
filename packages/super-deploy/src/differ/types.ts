// The Differ interface (ADR-0003): two live databases in, the ordered
// statements that turn the first into the second out. V1 wraps pg-delta;
// the fallback is our own pg_catalog/pg_depend differ behind this interface.

import type { Session } from "../adapters/types.ts";
import { SuperDeployError } from "../errors.ts";

export interface PlannedStatement {
  /** One statement, terminated with a semicolon. */
  readonly sql: string;
  /** Drops or loses data (needs acknowledgement at finalize). */
  readonly destructive: boolean;
  /** May rewrite or fully scan an existing table (a finalize warning). */
  readonly rewritesTable: boolean;
}

export interface Differ {
  /** Engine name and version, recorded in migration metadata. */
  readonly name: string;
  readonly version: string;
  /**
   * The statements that turn `source`'s structure into `desired`'s. Column
   * order is never a difference; ownership, grants, default privileges,
   * policies and row-level security are not diffed (ADR-0006). Every
   * statement can run inside one transaction (a differ that would emit
   * anything else must throw instead).
   */
  diff(source: Session, desired: Session): Promise<readonly PlannedStatement[]>;
}

export class DifferError extends SuperDeployError {
  readonly code = "differ-failed";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
