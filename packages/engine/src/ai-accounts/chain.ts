import { and, eq, inArray, isNotNull, isNull, ne, or, type SQL, schema, sql } from "@agenteschat/db";
import { CROSS_PROVIDER_KINDS, NEXT_ACCOUNT_KINDS } from "@agenteschat/providers/plans";
import { accountServesSql, audienceAllowsSql } from "./serves";

const { machineAccounts } = schema;

/**
 * THE order of use (ADR 0041 §6), for every chooser of "which account next": `person`'s own accounts first (an agent's
 * owner, or whom the right hand answers), then by `use_order`, the unplaced after, oldest first. Room left and being
 * online are filters of the caller's, never a re-sort. `compareInOrder` (`@agenteschat/providers/plans`) is its JS twin.
 */
export function accountOrderSql(person: string | null): SQL[] {
  return [
    ...(person ? [sql`(${machineAccounts.createdBy} = ${person}) desc`] : []),
    sql`${machineAccounts.useOrder} asc nulls last`,
    sql`${machineAccounts.createdAt} asc`,
    sql`${machineAccounts.id} asc`,
  ];
}

/** A run may move onto it at a plan's limit: Claude Code's or Codex's own sign-in (never a key, paid by the token). */
export const movableKindSql = and(
  inArray(machineAccounts.kind, [...NEXT_ACCOUNT_KINDS]),
  isNull(machineAccounts.provider),
  sql`${machineAccounts.authMethod} is distinct from 'api_key'`,
) as SQL;

/**
 * A run may move onto it in the order across CLIs (ADR 0041 §6, amended 2026-11-26; `crossMayMoveTo` is its JS twin,
 * which also checks that an OpenCode account's model is a free one, as setting it does): a CLI's own sign-in, or an
 * OpenCode key with its model chosen.
 */
export const crossKindSql = and(
  inArray(machineAccounts.kind, [...CROSS_PROVIDER_KINDS]),
  or(
    and(
      ne(machineAccounts.kind, "opencode"),
      isNull(machineAccounts.provider),
      sql`${machineAccounts.authMethod} is distinct from 'api_key'`,
    ),
    and(
      eq(machineAccounts.kind, "opencode"),
      eq(machineAccounts.provider, "zen"),
      isNotNull(machineAccounts.orderModel),
    ),
  ),
) as SQL;

/**
 * The accounts of `kind` on `machineId` a run thinking for `person` may go on with at its plan's limit: a movable sign-in
 * (`movableKindSql`) that serves `person` (`accountServesSql`) and thinks for every agent of its owner there (`shared`; a
 * login made for one agent is that agent's only), or one of `keep` (the run's own) whatever its sharing. `ownOnly`:
 * `person`'s own accounts alone (the right hand never goes on with a plan someone else gave it). `asker`: someone
 * besides the agent's owner the run answers (`runAsker`), whom the account's "Atender todos" must take. `kinds`: the
 * accounts of these kinds instead, in the order across CLIs (`crossKindSql`).
 */
export function chainWhereSql(
  orgId: string,
  machineId: string,
  kind: string,
  person: string | null,
  keep: readonly string[],
  ownOnly = false,
  asker: string | null = null,
  kinds?: readonly string[],
): SQL {
  return and(
    asker ? audienceAllowsSql("reply", asker) : undefined,
    eq(machineAccounts.orgId, orgId),
    eq(machineAccounts.machineId, machineId),
    // `kinds`: the order across CLIs, every kind of it but `kind`'s own, already looked at.
    kinds
      ? and(inArray(machineAccounts.kind, [...kinds]), crossKindSql)
      : and(eq(machineAccounts.kind, kind), movableKindSql),
    ownOnly ? (person ? eq(machineAccounts.createdBy, person) : sql`false`) : accountServesSql(person),
    keep.length > 0
      ? sql`(${inArray(machineAccounts.id, [...keep])} or ${machineAccounts.shared})`
      : eq(machineAccounts.shared, true),
  ) as SQL;
}
