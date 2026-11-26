import type { PlanUsage } from "@agenteschat/adapters";
import { and, type Executor, eq, inArray, isNull, ne, schema, sql } from "@agenteschat/db";
import { isAutoModel } from "@agenteschat/providers";
import {
  autoPlanModel,
  CROSS_PROVIDER_KINDS,
  claudeCodeModel,
  crossMayMoveTo,
  NEXT_ACCOUNT_KINDS,
  planOf,
} from "@agenteschat/providers/plans";
import type { Agent } from "./agents";
import { accountOrderSql, chainWhereSql } from "./ai-accounts/chain";
import {
  type BrainPlan,
  computerBrainUnavailable,
  NO_AI_CODES,
  planIsOwners,
  sessionUsed,
  storedPlanUsage,
} from "./brains/select";
import type { BrainAccount, BrainKind, BrainSession } from "./brains/types";
import { machineRule, mayUseDevice } from "./devices";
import type { MachineStatus } from "./machine-hub";
import { isRightHand } from "./right-hand";

const { agentRuns, machineAccounts, machines } = schema;

/**
 * Where a spilled run thinks (`Transcript.spill`): `from` is the agent's own computer, full (`cause` "full") or away
 * (offline or paused: "away"), and the names the reply's line says them by (`meta.spilled`).
 */
export interface SpillRecord {
  from: string;
  to: string;
  cause?: SpillCause;
  fromName?: string;
  toName?: string;
}

/** "chosen": its owner chose a computer of theirs for their agents' work (`spill_first`), and it was free. */
export type SpillCause = "full" | "away" | "chosen";

/**
 * How long an agent's ask, a routine or long work waits in its computer's line before it looks for another computer
 * (a person's reply looks at once): most waits end sooner, and a run on its own computer keeps its warm session.
 */
export const SPILL_AFTER_MS = 60_000;

type SpillDeps = { db: Executor; machines?: { status(machineId: string): Promise<MachineStatus | null> } };

/**
 * The run's computer plan moved to `machineId`, on a sign-in there the agent's owner has (an account of theirs, else
 * the computer's own sign-in when they connected it): null when that plan can't think there now.
 */
export async function spillPlan(
  deps: SpillDeps,
  agent: Agent,
  plan: BrainPlan,
  machineId: string,
  session: { id: string; resume: boolean },
): Promise<BrainPlan | null> {
  if (plan.kind === "model" || !deps.machines) return null;
  const [status, row] = await Promise.all([
    deps.machines.status(machineId).catch(() => null),
    deps.db
      .select({
        id: machineAccounts.id,
        label: machineAccounts.label,
        status: machineAccounts.status,
        provider: machineAccounts.provider,
      })
      .from(machineAccounts)
      .where(
        and(
          eq(machineAccounts.orgId, agent.orgId),
          eq(machineAccounts.machineId, machineId),
          eq(machineAccounts.kind, plan.kind),
          eq(machineAccounts.status, "active"),
          eq(machineAccounts.createdBy, agent.ownerUserId ?? ""),
        ),
      )
      .limit(1)
      .then(([r]) => r),
  ]);
  const account: BrainAccount | undefined = row
    ? { id: row.id, label: row.label, status: "active", ...(row.provider ? { provider: row.provider } : {}) }
    : undefined;
  const usage = await storedPlanUsage(deps.db, agent.orgId, machineId, plan.kind, account?.id).catch(() => null);
  const model =
    plan.kind === "claude_code" && plan.model && !isAutoModel(plan.model)
      ? claudeCodeModel(planOf(account?.provider), plan.model)
      : plan.model;
  const ownersPlan = await planIsOwners(
    deps.db,
    { orgId: agent.orgId, ownerUserId: agent.ownerUserId },
    machineId,
    account,
  );
  if (computerBrainUnavailable(plan.kind, machineId, status, Date.now(), account, ownersPlan, usage, model))
    return null;
  // What kept its own computer from thinking (offline, paused) isn't this one's.
  const { account: _home, usage: _homeUsage, unavailable: _away, ...rest } = plan;
  return {
    ...rest,
    ...(model ? { model } : {}),
    session: { ...session, machineId, cwd: "" },
    ...(account ? { account } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * A run that went on with another account at its plan's limit (`Transcript.accountMove`, ADR 0041 §6). The agent's own
 * account never changes: the next run starts on it again.
 */
export interface AccountMove {
  /** The account the run started on: its agent's own. */
  from: string;
  to: string;
  /** Whose plan `to` is when that isn't the agent's owner: lent to the run, so it never spends paid extra usage. */
  lentBy?: string;
  /** Every account the run thought with or was refused on, `from` and `to` included: each at most once per run. */
  tried: string[];
  /**
   * The order across CLIs brought it to another CLI than its agent's own (ADR 0041 §6, amended 2026-11-26): `from`'s and
   * `to`'s, and the model chosen for `to` there (none: its CLI's default).
   */
  kinds?: { from: BrainKind; to: BrainKind };
  model?: string;
}

/** `Transcript.accountSwitch`: each account by id and the name the run's details show it by. */
export interface AccountSwitch {
  from: { id: string; name: string };
  to: { id: string; name: string };
  /**
   * What moved it: its plan's limit, the pause line (99%) of long work, the paid extra usage it would go into, or its
   * sign-in thinking for all the runs it takes at once (`busy`).
   */
  cause: "limit" | "line" | "extra" | "busy";
}

/**
 * Where `nextAccountPlan` landed: the plan on the next account (of another CLI only through the order across CLIs),
 * else how many accounts are all limited and the first reset.
 */
export type NextAccount =
  | { plan: BrainPlan; lentBy: string | null; lenderName?: string }
  | { plan: null; chain: number; resetsAt?: string };

type SeatRow = { id: string; kind: string; email: string | null; providerOrgId: string | null };

/** The kinds a run on `kind` may go on with in the order across CLIs, its own already looked at (`nextAccountPlan`). */
const otherKinds = (kind: string, triedKinds: readonly string[]) =>
  CROSS_PROVIDER_KINDS.filter(
    // Never from one Gemini account to another: Google forbids automating account rotation (ADR 0143).
    (k) => k !== kind && !(k === "antigravity" && (kind === "antigravity" || triedKinds.includes("antigravity"))),
  );
/**
 * Two logins of one seat share its limits (`sameAccountWhere`): one CLI and one email, in the same Claude organization
 * when both know it.
 */
const sameSeat = (a: SeatRow, b: SeatRow) =>
  a.id === b.id ||
  // One email signs in to several providers: a seat is of one CLI.
  (a.kind === b.kind &&
    !!a.email &&
    a.email.toLowerCase() === b.email?.toLowerCase() &&
    (!a.providerOrgId || !b.providerOrgId || a.providerOrgId === b.providerOrgId));

type ChainAgent = Pick<Agent, "id" | "orgId" | "ownerUserId" | "brainAccountPinned" | "builtin">;

/**
 * The accounts on `machineId` of `kind` a run of `agent` may go on with at its plan's limit (ADR 0041 §6,
 * `chainWhereSql`): those that serve its owner. The right hand goes on only with the accounts of the person it answers
 * (`forPerson`), so never on a plan someone else gave it. `keep`: the run's own accounts, whatever their sharing.
 * `asker`: someone besides its owner the run answers, whom the account's "Atender todos" must take.
 */
function chainWhere(
  agent: ChainAgent,
  kind: string,
  machineId: string,
  forPerson: string | null,
  keep: string[],
  asker: string | null = null,
  kinds?: readonly string[],
) {
  const owner = agent.ownerUserId ?? null;
  if (isRightHand(agent))
    return chainWhereSql(agent.orgId, machineId, kind, forPerson === owner ? owner : null, keep, true);
  return chainWhereSql(agent.orgId, machineId, kind, owner, keep, false, asker, kinds);
}

/** Its owner still in the workspace (`planIsOwners`). */
const ownerIsMember = and(
  eq(schema.organizationMembers.orgId, machineAccounts.orgId),
  eq(schema.organizationMembers.userId, machineAccounts.createdBy),
);

/**
 * The next account a run at its plan's limit goes on with (ADR 0041 §6), on the same computer and of the same kind
 * (`chainWhere`): its owner's own first and then the others that serve everyone, each by `use_order`. Never an account
 * `tried` or one of their seats, nor one limited by what is stored: unknown usage is worth a try (a setup token can't
 * read its usage without a turn). `own`: the agent's own account, which takes the run back when it has room. `room`:
 * what long work also needs of an account's stored usage. Null plan: no such account, with how many accounts are limited (the
 * tried ones counted) and the earliest reset. `cross`: the workspace's order across CLIs is on (ADR 0041 §6, amended
 * 2026-11-26): with none of its own CLI left, the next account of another CLI there by the same rules, each on the model
 * chosen for it in the order; never the right hand's, which thinks only on its person's plans.
 */
export async function nextAccountPlan(
  deps: SpillDeps,
  agent: ChainAgent,
  plan: BrainPlan,
  tried: readonly string[],
  options: {
    room?: (usage: PlanUsage | null, accountId: string) => boolean;
    forPerson?: string | null;
    /** Someone besides the agent's owner the run answers (`runAsker`). */
    asker?: string | null;
    own?: string;
    cross?: boolean;
  } = {},
): Promise<NextAccount> {
  const machineId = plan.session?.machineId;
  const owner = agent.ownerUserId;
  const none = { plan: null, chain: 0 } as const;
  if (!machineId || !owner || !plan.account || plan.missionId || agent.brainAccountPinned) return none;
  const sameKind = NEXT_ACCOUNT_KINDS.includes(plan.kind) && !plan.account.provider;
  const cross = options.cross === true && !isRightHand(agent) && CROSS_PROVIDER_KINDS.includes(plan.kind);
  if (!sameKind && !cross) return none;
  const keep = [plan.account.id, ...(options.own ? [options.own] : [])];
  const accounts = (kinds?: readonly string[]) =>
    deps.db
      .select({
        id: machineAccounts.id,
        kind: machineAccounts.kind,
        label: machineAccounts.label,
        email: machineAccounts.email,
        providerOrgId: machineAccounts.providerOrgId,
        createdBy: machineAccounts.createdBy,
        ownerName: schema.users.name,
        usage: machineAccounts.usage,
        provider: machineAccounts.provider,
        authMethod: machineAccounts.authMethod,
        orderModel: machineAccounts.orderModel,
        shared: machineAccounts.shared,
        status: machineAccounts.status,
      })
      .from(machineAccounts)
      .innerJoin(schema.organizationMembers, ownerIsMember)
      .leftJoin(schema.users, eq(schema.users.id, machineAccounts.createdBy))
      .where(
        and(
          chainWhere(agent, plan.kind, machineId, options.forPerson ?? null, keep, options.asker ?? null, kinds),
          eq(machineAccounts.status, "active"),
        ),
      )
      .orderBy(...accountOrderSql(owner));
  const [status, own] = await Promise.all([
    deps.machines ? deps.machines.status(machineId).catch(() => null) : null,
    sameKind ? accounts() : [],
  ]);
  // Across CLIs, after its own CLI's: the kinds of the accounts it tried tell whether a Gemini account was one.
  const triedKinds = cross
    ? (
        await deps.db
          .select({ kind: machineAccounts.kind })
          .from(machineAccounts)
          .where(and(eq(machineAccounts.orgId, agent.orgId), inArray(machineAccounts.id, [...tried, plan.account.id])))
      ).map((r) => r.kind)
    : [];
  const kinds = cross ? otherKinds(plan.kind, triedKinds) : [];
  const others = kinds.length > 0 ? (await accounts(kinds)).filter((r) => crossMayMoveTo(r)) : [];
  const rows = [...own, ...others];
  const triedRows = rows.filter((r) => tried.includes(r.id));
  const now = Date.now();
  const chain: SeatRow[] = [];
  let earliest: number | null = null;
  for (const r of rows) {
    const kind = r.kind as BrainKind;
    const crossed = kind !== plan.kind;
    const account: BrainAccount = {
      id: r.id,
      label: r.label,
      status: "active",
      ...(crossed && r.provider ? { provider: r.provider } : {}),
    };
    const usage = (r.usage as PlanUsage | null) ?? null;
    // Across CLIs the model chosen for the account there, else its CLI's own; within its CLI the run's, unless the
    // order across CLIs chose one for that account.
    const chosen = cross ? (r.orderModel ?? undefined) : undefined;
    const model = crossed
      ? chosen
      : (chosen ?? (isAutoModel(plan.model) ? autoPlanModel(undefined, plan.model, usage) : plan.model));
    const why = computerBrainUnavailable(kind, machineId, status, now, account, true, usage, model);
    const limited = why?.code === "plan_limit";
    if (limited || tried.includes(r.id)) {
      if (!chain.some((c) => sameSeat(c, r))) chain.push(r);
      const at = Date.parse(why?.resetsAt ?? "");
      if (limited && at > now && (earliest === null || at < earliest)) earliest = at;
    }
    if (why || tried.includes(r.id) || triedRows.some((t) => sameSeat(t, r))) continue;
    if (options.room && !options.room(usage, r.id)) continue;
    // Another CLI thinks with its own effort levels: the agent's is its own CLI's.
    const { unavailable: _, usage: _usage, model: _model, effort, ...rest } = plan;
    const next = crossed ? chosen : (chosen ?? plan.model);
    return {
      plan: {
        ...rest,
        kind,
        account,
        ...(next ? { model: next } : {}),
        ...(effort && !crossed ? { effort } : {}),
        ...(usage ? { usage } : {}),
        session: { ...(plan.session as BrainSession), id: Bun.randomUUIDv7(), resume: false },
      },
      lentBy: r.createdBy === owner ? null : r.createdBy,
      ...(r.createdBy !== owner && r.ownerName ? { lenderName: r.ownerName } : {}),
    };
  }
  return {
    plan: null,
    chain: chain.length,
    ...(earliest !== null ? { resetsAt: new Date(earliest).toISOString() } : {}),
  };
}

/**
 * A resumed run's plan on the account it moved to (`AccountMove.to`), in the session it has there, with what keeps
 * that account from thinking now: null when it may no longer take the run (`chainWhere`: gone from the agent's
 * computer, no longer serving it or its person, or no longer shared).
 */
export async function movedAccountPlan(
  deps: SpillDeps,
  agent: ChainAgent,
  plan: BrainPlan,
  accountId: string,
  forPerson: string | null = null,
  asker: string | null = null,
  /** The move took it to another CLI (`AccountMove.kinds`), on this model there. */
  crossed?: { kind: BrainKind; model?: string },
): Promise<BrainPlan | null> {
  const machineId = plan.session?.machineId;
  if (!machineId || plan.kind === "model") return null;
  const kind = crossed?.kind ?? plan.kind;
  const [row] = await deps.db
    .select({
      id: machineAccounts.id,
      label: machineAccounts.label,
      status: machineAccounts.status,
      provider: machineAccounts.provider,
    })
    .from(machineAccounts)
    .innerJoin(schema.organizationMembers, ownerIsMember)
    .where(
      and(
        eq(machineAccounts.id, accountId),
        chainWhere(agent, plan.kind, machineId, forPerson, [], asker, crossed ? [crossed.kind] : undefined),
      ),
    );
  if (!row) return null;
  const account: BrainAccount = {
    id: row.id,
    label: row.label,
    status: row.status === "active" ? "active" : "signed_out",
    ...(crossed && row.provider ? { provider: row.provider } : {}),
  };
  const [status, usage] = await Promise.all([
    deps.machines ? deps.machines.status(machineId).catch(() => null) : null,
    storedPlanUsage(deps.db, agent.orgId, machineId, kind, row.id).catch(() => null),
  ]);
  const model = crossed
    ? crossed.model
    : isAutoModel(plan.model)
      ? autoPlanModel(undefined, plan.model, usage)
      : plan.model;
  // Of its own account's refusal only what holds for the run on any account (the right hand's, say): its limit,
  // its sign-in or its owner's sharing belong to that account.
  const own = plan.unavailable;
  const carried =
    own && own.code !== "plan_limit" && own.code !== "plan_not_owner" && !NO_AI_CODES.has(own.code) ? own : null;
  const why = computerBrainUnavailable(kind, machineId, status, Date.now(), account, true, usage, model) ?? carried;
  const { unavailable: _, usage: _usage, ...rest } = plan;
  if (crossed) {
    const { model: _model, effort: _effort, ...other } = rest;
    // Its session there ran as that CLI: resumed when that CLI's turn used it.
    const session = other.session
      ? {
          ...other.session,
          resume: await sessionUsed(deps.db, { orgId: agent.orgId, agentId: agent.id }, kind, other.session.id),
        }
      : undefined;
    return {
      ...other,
      ...(session ? { session } : {}),
      kind,
      account,
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      ...(why ? { unavailable: why } : {}),
    };
  }
  return { ...rest, account, ...(usage ? { usage } : {}), ...(why ? { unavailable: why } : {}) };
}

/** The workspace lets devices help (`organization_settings.devices_help`): on unless an admin turned it off. */
const workspaceLetsDevicesHelp = sql`coalesce((select s.devices_help from ${schema.organizationSettings} s
  where s.org_id = ${machines.orgId}), true)`;

/**
 * Online computers of the workspace other than `home` whose owner lets them help ("Help when the team's computer is
 * full or away", `spill_own`), in a workspace that lets devices help, with nothing in their line. Never a server
 * install (an OS user per agent): the agent has no user of its own there.
 */
const spillable = (orgId: string, home: string) =>
  and(
    eq(machines.orgId, orgId),
    ne(machines.id, home),
    isNull(machines.deletedAt),
    eq(machines.online, true),
    eq(machines.paused, false),
    eq(machines.execAllowed, true),
    eq(machines.spillOwn, true),
    workspaceLetsDevicesHelp,
    sql`${machines.executors}->>'mode' is distinct from 'system'`,
    sql`not exists (select 1 from ${agentRuns} w where w.org_id = ${machines.orgId}
      and w.waiting_machine_id = ${machines.id} and w.status = 'waiting_input'
      and coalesce(w.state, w.transcript)->'waitingForBrain'->>'code' = 'busy')`,
  );

/** The computers `owner` chose for their agents' work (`spill_first`), free to take a turn now. */
const chosenBy = (owner: string) => and(eq(machines.spillFirst, true), eq(machines.pairedByUserId, owner));

/** Whether `owner` has a computer for their agents' work free now (`spillTarget` with `chosen`): worth a look. */
export async function chosenComputerFree(db: Executor, orgId: string, owner: string, home: string): Promise<boolean> {
  const [row] = await db
    .select({ id: machines.id })
    .from(machines)
    .where(and(spillable(orgId, home), chosenBy(owner)))
    .limit(1);
  return row !== undefined;
}

/** Whether a turn waiting behind others on `home` may find another computer (`spillTarget`): worth a look now. */
export async function spillMayHelp(db: Executor, orgId: string, home: string): Promise<boolean> {
  const [row] = await db.select({ id: machines.id }).from(machines).where(spillable(orgId, home)).limit(1);
  return row !== undefined;
}

/**
 * Spill-over ("Devices as extra capacity", ADR 0233): another online computer of the workspace that may take the run's
 * fresh turn now, while the agent's own (`plan.session.machineId`) is full or away. Its owner lets it help, nothing
 * waits in its line, and the agent's owner has a sign-in there (`spillPlan`). A person's own computer takes only its
 * owner's agents (until agents' commands are isolated from its owner's files there); a computer marked the
 * workspace's takes anyone's. `personId`: whom the run works for, who may use the computer unless it's theirs.
 */
export async function spillTarget(
  deps: SpillDeps,
  agent: Agent,
  plan: BrainPlan,
  personId: string | null,
  session: { id: string },
  /** Only a computer its owner chose for their agents' work (`chosenBy`). */
  chosen = false,
): Promise<{ machineId: string; name: string; homeName: string | null; plan: BrainPlan } | null> {
  const home = plan.session?.machineId;
  const owner = agent.ownerUserId;
  if (!home || (chosen && !owner)) return null;
  const candidates = await deps.db
    .select()
    .from(machines)
    .where(
      and(
        spillable(agent.orgId, home),
        chosen && owner ? chosenBy(owner) : undefined,
        owner
          ? sql`(${machines.belongsToWorkspace} or ${machines.pairedByUserId} = ${owner})`
          : eq(machines.belongsToWorkspace, true),
      ),
    )
    .orderBy(
      sql`${machines.pairedByUserId} = ${owner ?? ""} desc nulls last`,
      sql`${machines.size}->>'memoryGb' desc nulls last`,
    );
  const person = personId ?? owner;
  for (const m of candidates) {
    if (m.pairedByUserId !== person && !(person && (await mayUseDevice(deps.db, agent.orgId, person, machineRule(m)))))
      continue;
    const moved = await spillPlan(deps, agent, plan, m.id, { id: session.id, resume: false });
    if (!moved) continue;
    const [from] = await deps.db.select({ name: machines.name }).from(machines).where(eq(machines.id, home));
    return { machineId: m.id, name: m.name, homeName: from?.name ?? null, plan: moved };
  }
  return null;
}
