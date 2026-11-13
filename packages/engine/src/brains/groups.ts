import type { PlanUsage } from "@agenteschat/adapters";
import { and, asc, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { servesOf } from "../machine-accounts";
import { can, requirePermission } from "../organizations";

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

/** The org's brain groups (ADR 0180), oldest first. Anyone in the org sees them. */
export async function listBrainGroups(db: Database, userId: string, orgId: string): Promise<BrainGroupView[]> {
  await requirePermission(db, userId, orgId, "read");
  const groups = await db
    .select()
    .from(schema.brainGroups)
    .where(eq(schema.brainGroups.orgId, orgId))
    .orderBy(asc(schema.brainGroups.createdAt), asc(schema.brainGroups.id));
  return viewsOf(db, orgId, userId, groups);
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
    .where(and(eq(schema.machines.orgId, orgId), eq(schema.machines.id, input.machineId)));
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
