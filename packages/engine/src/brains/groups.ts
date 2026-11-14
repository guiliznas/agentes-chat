import type { PlanUsage } from "@agenteschat/adapters";
import { and, asc, type Database, desc, eq, inArray, isNotNull, isNull, schema } from "@agenteschat/db";
import { AUTO_MODEL } from "@agenteschat/providers";
import { recordAudit } from "../audit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { planRoom, servesOf } from "../machine-accounts";
import { can, requirePermission } from "../organizations";
import { isRightHand, type ThinkingAgent } from "../right-hand";
import type { BrainKind } from "./types";

export type BrainGroupStrategy = "order" | "room";
export const BRAIN_GROUP_STRATEGIES: readonly BrainGroupStrategy[] = ["order", "room"];

export interface BrainGroupMemberInput {
  accountId: string;
  model?: string | null;
  effort?: string | null;
}

export interface BrainGroupView {
  id: string;
  machineId: string;
  name: string;
  strategy: BrainGroupStrategy;
  members: {
    accountId: string;
    label: string;
    kind: string;
    provider: string | null;
    model: string | null;
    effort: string | null;
    status: string;
    usage: PlanUsage | null;
  }[];
  usedBy: { id: string; name: string }[];
  canEdit: boolean;
}

type AccountRow = typeof schema.machineAccounts.$inferSelect;
type GroupRow = typeof schema.brainGroups.$inferSelect;

/** The provider a group holds only one account of (ADR 0180): the key's provider, else the CLI's kind. */
const providerKeyOf = (a: Pick<AccountRow, "provider" | "kind">) => a.provider ?? a.kind;

function validName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 1 || name.length > schema.BRAIN_GROUP_NAME_MAX) {
    throw new ValidationError(
      `A group's name is 1 to ${schema.BRAIN_GROUP_NAME_MAX} characters`,
      "brain_group.invalid_name",
    );
  }
  return name;
}

function validStrategy(value: unknown): BrainGroupStrategy {
  if (value === "order" || value === "room") return value;
  throw new ValidationError("Choose order or room", "brain_group.invalid");
}

const optionalText = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The accounts a person may put in a group on `machineId` (ADR 0180): shared, active, on that computer and serving
 * them. Only the accounts in `check` are looked at (an update keeps the members it already had).
 */
async function loadMembers(
  db: Database,
  userId: string,
  orgId: string,
  machineId: string,
  inputs: BrainGroupMemberInput[],
  check: ReadonlySet<string> | null,
): Promise<{ account: AccountRow; input: BrainGroupMemberInput }[]> {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new ValidationError("A group needs at least one account", "brain_group.empty");
  }
  const ids = inputs.map((i) => i?.accountId);
  if (ids.some((id) => typeof id !== "string" || !id)) {
    throw new ValidationError("Each member is an account", "brain_group.invalid");
  }
  const rows = await db
    .select()
    .from(schema.machineAccounts)
    .where(and(eq(schema.machineAccounts.orgId, orgId), inArray(schema.machineAccounts.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const members = inputs.map((input) => {
    const account = byId.get(input.accountId);
    if (!account) throw new NotFoundError("Account not found", "brain_group.invalid", { accountId: input.accountId });
    return { account, input };
  });
  for (const { account } of members) {
    if (check && !check.has(account.id)) continue;
    const params = { accountId: account.id };
    if (account.machineId !== machineId) {
      throw new ValidationError("That account is on another computer", "brain_group.other_computer", params);
    }
    if (!account.shared) {
      throw new ForbiddenError("That login is not shared with the team", "brain_group.not_shared", params);
    }
    if (account.status !== "active" || (servesOf(account.serves) === "owner" && account.createdBy !== userId)) {
      throw new ForbiddenError("That account does not serve you", "brain_group.not_yours", params);
    }
  }
  const seen = new Map<string, string>();
  for (const { account } of members) {
    const key = providerKeyOf(account);
    if (seen.has(key)) {
      throw new ConflictError("A group takes one account of each provider", "brain_group.same_provider", {
        provider: key,
      });
    }
    seen.set(key, account.id);
  }
  return members;
}

function writeMembers(
  tx: Database,
  orgId: string,
  groupId: string,
  members: { account: AccountRow; input: BrainGroupMemberInput }[],
) {
  return tx.insert(schema.brainGroupMembers).values(
    members.map(({ account, input }, position) => ({
      orgId,
      groupId,
      accountId: account.id,
      position,
      providerKey: providerKeyOf(account),
      model: optionalText(input.model),
      effort: optionalText(input.effort),
    })),
  );
}

async function viewsOf(db: Database, orgId: string, userId: string, groups: GroupRow[]): Promise<BrainGroupView[]> {
  if (groups.length === 0) return [];
  const membership = await requirePermission(db, userId, orgId, "read");
  const admin = can(membership, "manage_agents");
  const ids = groups.map((g) => g.id);
  const members = await db
    .select({ m: schema.brainGroupMembers, a: schema.machineAccounts })
    .from(schema.brainGroupMembers)
    .innerJoin(
      schema.machineAccounts,
      and(
        eq(schema.machineAccounts.orgId, schema.brainGroupMembers.orgId),
        eq(schema.machineAccounts.id, schema.brainGroupMembers.accountId),
      ),
    )
    .where(and(eq(schema.brainGroupMembers.orgId, orgId), inArray(schema.brainGroupMembers.groupId, ids)))
    .orderBy(asc(schema.brainGroupMembers.position));
  const agents = await db
    .select({ id: schema.agents.id, name: schema.agents.name, groupId: schema.agents.brainGroupId })
    .from(schema.agents)
    .where(
      and(eq(schema.agents.orgId, orgId), inArray(schema.agents.brainGroupId, ids), isNull(schema.agents.archivedAt)),
    );
  return groups.map((g) => ({
    id: g.id,
    machineId: g.machineId,
    name: g.name,
    strategy: validStrategy(g.strategy),
    members: members
      .filter((r) => r.m.groupId === g.id)
      .map(({ m, a }) => ({
        accountId: a.id,
        label: a.label,
        kind: a.kind,
        provider: a.provider,
        model: m.model,
        effort: m.effort,
        status: a.status,
        usage: a.usage ?? null,
      })),
    usedBy: agents.filter((a) => a.groupId === g.id).map((a) => ({ id: a.id, name: a.name })),
    canEdit: admin || g.createdBy === userId,
  }));
}

async function loadGroup(db: Database, orgId: string, groupId: string): Promise<GroupRow> {
  const [row] = await db
    .select()
    .from(schema.brainGroups)
    .where(and(eq(schema.brainGroups.orgId, orgId), eq(schema.brainGroups.id, groupId)));
  if (!row) throw new NotFoundError("Group not found", "brain_group.not_found");
  return row;
}

async function editableGroup(db: Database, userId: string, orgId: string, groupId: string): Promise<GroupRow> {
  const membership = await requirePermission(db, userId, orgId, "read");
  const group = await loadGroup(db, orgId, groupId);
  if (group.createdBy !== userId && !can(membership, "manage_agents")) {
    throw new ForbiddenError("Only who made this group or an admin changes it", "brain_group.not_editor");
  }
  return group;
}

/** The org's brain groups (ADR 0180), oldest first, but a removed computer's. Anyone in the org sees them. */
export async function listBrainGroups(db: Database, userId: string, orgId: string): Promise<BrainGroupView[]> {
  await requirePermission(db, userId, orgId, "read");
  const rows = await db
    .select({ g: schema.brainGroups })
    .from(schema.brainGroups)
    .innerJoin(
      schema.machines,
      and(eq(schema.machines.orgId, schema.brainGroups.orgId), eq(schema.machines.id, schema.brainGroups.machineId)),
    )
    .where(and(eq(schema.brainGroups.orgId, orgId), isNull(schema.machines.deletedAt)))
    .orderBy(asc(schema.brainGroups.createdAt), asc(schema.brainGroups.id));
  return viewsOf(
    db,
    orgId,
    userId,
    rows.map((r) => r.g),
  );
}

/** Creates a group on one computer from accounts that serve the person (ADR 0180). Audited (`brain_group.create`). */
export async function createBrainGroup(
  db: Database,
  userId: string,
  orgId: string,
  input: { machineId: string; name: string; strategy?: BrainGroupStrategy; members: BrainGroupMemberInput[] },
): Promise<BrainGroupView> {
  await requirePermission(db, userId, orgId, "read");
  const name = validName(input.name);
  const strategy = validStrategy(input.strategy ?? "order");
  const [machine] = await db
    .select({ id: schema.machines.id })
    .from(schema.machines)
    .where(
      and(eq(schema.machines.orgId, orgId), eq(schema.machines.id, input.machineId), isNull(schema.machines.deletedAt)),
    );
  // A removed computer takes no group (its own stay out of the list).
  if (!machine) throw new NotFoundError("Computer not found", "brain_group.other_computer");
  const members = await loadMembers(db, userId, orgId, machine.id, input.members, null);
  const group = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.brainGroups)
      .values({ orgId, machineId: machine.id, name, strategy, createdBy: userId })
      .returning();
    if (!row) throw new Error("brain group insert returned no row");
    await writeMembers(tx, orgId, row.id, members);
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "brain_group.create",
      target: { type: "brain_group", id: row.id },
      details: { name, strategy, accounts: members.map((m) => m.account.id) },
    });
    return row;
  });
  const [view] = await viewsOf(db, orgId, userId, [group]);
  if (!view) throw new Error("brain group view is missing");
  return view;
}

/**
 * Changes a group's name, strategy and/or members (ADR 0180). The members come as the complete ordered list: the
 * position is the index. The position's unique key is not deferrable, so the list is replaced (delete + insert) in
 * one transaction. Only its creator or an admin. Audited (`brain_group.update`).
 */
export async function updateBrainGroup(
  db: Database,
  userId: string,
  orgId: string,
  groupId: string,
  input: { name?: string; strategy?: BrainGroupStrategy; members?: BrainGroupMemberInput[] },
): Promise<BrainGroupView> {
  const group = await editableGroup(db, userId, orgId, groupId);
  const name = input.name === undefined ? group.name : validName(input.name);
  const strategy = input.strategy === undefined ? validStrategy(group.strategy) : validStrategy(input.strategy);
  let members: Awaited<ReturnType<typeof loadMembers>> | null = null;
  if (input.members !== undefined) {
    const current = await db
      .select({ id: schema.brainGroupMembers.accountId })
      .from(schema.brainGroupMembers)
      .where(and(eq(schema.brainGroupMembers.orgId, orgId), eq(schema.brainGroupMembers.groupId, groupId)));
    const kept = new Set(current.map((c) => c.id));
    const fresh = new Set(input.members.map((m) => m?.accountId).filter((id) => !kept.has(id)));
    members = await loadMembers(db, userId, orgId, group.machineId, input.members, fresh);
  }
  await db.transaction(async (tx) => {
    await tx
      .update(schema.brainGroups)
      .set({ name, strategy, updatedAt: new Date() })
      .where(and(eq(schema.brainGroups.orgId, orgId), eq(schema.brainGroups.id, groupId)));
    if (members) {
      await tx
        .delete(schema.brainGroupMembers)
        .where(and(eq(schema.brainGroupMembers.orgId, orgId), eq(schema.brainGroupMembers.groupId, groupId)));
      await writeMembers(tx, orgId, groupId, members);
    }
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "brain_group.update",
      target: { type: "brain_group", id: groupId },
      details: { name, strategy, ...(members ? { accounts: members.map((m) => m.account.id) } : {}) },
    });
  });
  const [view] = await viewsOf(db, orgId, userId, [await loadGroup(db, orgId, groupId)]);
  if (!view) throw new Error("brain group view is missing");
  return view;
}

/**
 * Deletes a group (ADR 0180). The agents that pointed at it are freed first (their FK is NO ACTION), in the same
 * transaction. Only its creator or an admin. Audited (`brain_group.delete`).
 */
export async function deleteBrainGroup(db: Database, userId: string, orgId: string, groupId: string): Promise<void> {
  const group = await editableGroup(db, userId, orgId, groupId);
  await db.transaction(async (tx) => {
    const freed = await tx
      .update(schema.agents)
      .set({ brainGroupId: null })
      .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.brainGroupId, groupId)))
      .returning({ id: schema.agents.id });
    await tx
      .delete(schema.brainGroups)
      .where(and(eq(schema.brainGroups.orgId, orgId), eq(schema.brainGroups.id, groupId)));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "brain_group.delete",
      target: { type: "brain_group", id: groupId },
      details: { name: group.name, freedAgents: freed.map((a) => a.id) },
    });
  });
}

export interface GroupPickOptions {
  /** The conversation: it keeps the member of its last run while that one has room. */
  threadRootId?: string;
  /** This member while it is still eligible, even at its limit (a turn cut by the plan's limit). */
  pinAccountId?: string;
  now?: number;
}

/**
 * How a run picks its group's member (ADR 0180): in its conversation, and on its own member when its turn was cut
 * by the plan's limit, so the cut turn is sent again in that member's session (as the model fallback refuses to).
 */
export function groupPickFor(run: {
  threadRootId?: string | null;
  brainAccountId?: string | null;
  transcript?: unknown;
}): GroupPickOptions {
  const cut =
    (run.transcript as { interruptedTurn?: { cause?: string } } | null | undefined)?.interruptedTurn?.cause ===
    "plan_limit";
  return {
    ...(run.threadRootId ? { threadRootId: run.threadRootId } : {}),
    ...(cut && run.brainAccountId ? { pinAccountId: run.brainAccountId } : {}),
  };
}

export interface GroupMemberPick {
  accountId: string;
  kind: BrainKind;
  model: string | null;
  effort: string | null;
  /** Every eligible member is at its limit: this is the one whose limit ends first. */
  exhausted: boolean;
}

/**
 * The member of the agent's group that thinks now (ADR 0180), null when it has no group or no member can serve it.
 * Eligible: account active, shared, on the agent's computer (as is the group) and usable by the agent's owner. A
 * conversation keeps the member of its last run while that one has room; else `order` takes the first with room and
 * `room` the one with the most left. All at their limit: the one back first, `exhausted`, for the plan-limit path.
 */
export async function pickGroupMember(
  db: Database,
  agent: Pick<typeof schema.agents.$inferSelect, "id" | "orgId" | "ownerUserId" | "machineId" | "brainGroupId">,
  opts: GroupPickOptions = {},
): Promise<GroupMemberPick | null> {
  const { machineId, brainGroupId } = agent;
  if (!machineId || !brainGroupId) return null;
  const now = opts.now ?? Date.now();
  const rows = await db
    .select({ strategy: schema.brainGroups.strategy, m: schema.brainGroupMembers, a: schema.machineAccounts })
    .from(schema.brainGroups)
    .innerJoin(
      schema.brainGroupMembers,
      and(
        eq(schema.brainGroupMembers.orgId, schema.brainGroups.orgId),
        eq(schema.brainGroupMembers.groupId, schema.brainGroups.id),
      ),
    )
    .innerJoin(
      schema.machineAccounts,
      and(
        eq(schema.machineAccounts.orgId, schema.brainGroupMembers.orgId),
        eq(schema.machineAccounts.id, schema.brainGroupMembers.accountId),
      ),
    )
    .where(
      and(
        eq(schema.brainGroups.orgId, agent.orgId),
        eq(schema.brainGroups.id, brainGroupId),
        eq(schema.brainGroups.machineId, machineId),
      ),
    )
    .orderBy(asc(schema.brainGroupMembers.position));
  const [first] = rows;
  if (!first) return null;
  const live = rows.filter(({ a }) => a.status === "active" && a.shared && a.machineId === machineId);
  // select.ts imports this file (ADR 0180) and imports machine-accounts back, so `select` is loaded when called, not
  // when this module is evaluated. `machine-accounts` is static: every use here is inside a function (live binding).
  const { planLimitOf, plansAreOwners } = await import("./select");
  const owned = await plansAreOwners(
    db,
    agent,
    live.map(({ a }) => a.id),
  );
  const eligible: { pick: GroupMemberPick; limit: { until: number | null } | null; room: number }[] = [];
  for (const { m, a } of live) {
    if (!owned.has(a.id)) continue;
    const kind = a.kind as BrainKind;
    eligible.push({
      pick: { accountId: a.id, kind, model: m.model, effort: m.effort, exhausted: false },
      limit: planLimitOf(machineId, kind, a.id, a.usage, now),
      room: planRoom(a.usage, now),
    });
  }
  if (eligible.length === 0) return null;
  // A turn cut by its plan's limit parks on that member and is sent again there, never redone elsewhere.
  const pinned = opts.pinAccountId ? eligible.find((e) => e.pick.accountId === opts.pinAccountId) : undefined;
  if (pinned) return { ...pinned.pick, exhausted: pinned.limit !== null };
  const withRoom = eligible.filter((e) => e.limit === null);
  if (withRoom.length > 0) {
    const lastId = opts.threadRootId ? await lastThreadAccount(db, agent.orgId, agent.id, opts.threadRootId) : null;
    const kept = lastId ? withRoom.find((e) => e.pick.accountId === lastId) : undefined;
    if (kept) return kept.pick;
    if (first.strategy === "room") return withRoom.reduce((best, e) => (e.room > best.room ? e : best)).pick;
    const [head] = withRoom;
    return head ? head.pick : null;
  }
  // Unknown reset: last. Ties keep the position order (reduce is stable on strict `<`).
  const untilOf = (e: (typeof eligible)[number]) => e.limit?.until ?? Number.POSITIVE_INFINITY;
  const soonest = eligible.reduce((best, e) => (untilOf(e) < untilOf(best) ? e : best));
  return { ...soonest.pick, exhausted: true };
}

/** The account the conversation's latest run thought with (ADR 0180), null before any. */
async function lastThreadAccount(db: Database, orgId: string, agentId: string, threadRootId: string) {
  const [row] = await db
    .select({ id: schema.agentRuns.brainAccountId })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.orgId, orgId),
        eq(schema.agentRuns.agentId, agentId),
        eq(schema.agentRuns.threadRootId, threadRootId),
        isNotNull(schema.agentRuns.brainAccountId),
      ),
    )
    .orderBy(desc(schema.agentRuns.createdAt), desc(schema.agentRuns.id))
    .limit(1);
  return row?.id ?? null;
}

/** Agents `withGroupBrain` already gave their member: the run's second look (`resolveBrain`) keeps that one. */
const picked = new WeakSet<object>();
/** Agents `withGroupBrain` found no usable member for: they think as at a plan's limit (`groupHasNoMember`). */
const memberless = new WeakSet<object>();

/**
 * The agent's group has no member that can think for it now (ADR 0180 §7): every one signed out, unshared or no longer
 * serving its owner. It follows the rule of a group whose members are all at their limit, never its saved brain: its
 * fallback answers a conversation, other work waits (`plan_limit`, its reset unknown).
 */
export const groupHasNoMember = (agent: object) => memberless.has(agent);

/** A group member's own settings (ADR 0180): Fast and extra usage are the agent's saved brain's, never a member's. */
const MEMBER_SETTINGS = { brainSpeed: "standard", brainExtraUsage: false } as const;

/** The CLI a memberless group thinks as for its wait: its first member's, else the agent's saved computer brain. */
async function memberlessKind(db: Database, orgId: string, groupId: string, saved: unknown): Promise<BrainKind> {
  const [first] = await db
    .select({ kind: schema.machineAccounts.kind })
    .from(schema.brainGroupMembers)
    .innerJoin(
      schema.machineAccounts,
      and(
        eq(schema.machineAccounts.orgId, schema.brainGroupMembers.orgId),
        eq(schema.machineAccounts.id, schema.brainGroupMembers.accountId),
      ),
    )
    .where(and(eq(schema.brainGroupMembers.orgId, orgId), eq(schema.brainGroupMembers.groupId, groupId)))
    .orderBy(asc(schema.brainGroupMembers.position))
    .limit(1);
  if (first) return first.kind as BrainKind;
  return typeof saved === "string" && saved !== "model" ? (saved as BrainKind) : "claude_code";
}

/**
 * The agent with its group's member in place of its own `brain*` fields (ADR 0180), the way `withPersonalBrain` does
 * for the right hand, at standard speed and with no extra usage. The stored fields stay untouched, so leaving the group
 * gives them back. No group, the right hand or no computer: the agent as it is. No usable member: no account, marked
 * `groupHasNoMember`, so it thinks as a group at its limit does.
 */
export async function withGroupBrain<
  T extends ThinkingAgent & Pick<typeof schema.agents.$inferSelect, "id"> & { brainGroupId?: string | null },
>(db: Database, agent: T, opts: GroupPickOptions = {}): Promise<T> {
  if (picked.has(agent) || !agent.brainGroupId || !agent.machineId || isRightHand(agent)) return agent;
  const pick = await pickGroupMember(
    db,
    {
      id: agent.id,
      orgId: agent.orgId,
      ownerUserId: agent.ownerUserId ?? null,
      machineId: agent.machineId,
      brainGroupId: agent.brainGroupId,
    },
    opts,
  );
  if (!pick) {
    const none: T = {
      ...agent,
      ...MEMBER_SETTINGS,
      brain: await memberlessKind(db, agent.orgId, agent.brainGroupId, agent.brain),
      brainModel: AUTO_MODEL,
      brainEffort: null,
      brainAccountId: null,
      brainAccountLentBy: null,
    };
    picked.add(none);
    memberless.add(none);
    return none;
  }
  const substituted: T = {
    ...agent,
    ...MEMBER_SETTINGS,
    brain: pick.kind,
    brainModel: pick.model ?? AUTO_MODEL,
    brainEffort: pick.effort,
    brainAccountId: pick.accountId,
    brainAccountLentBy: null,
  };
  picked.add(substituted);
  return substituted;
}
