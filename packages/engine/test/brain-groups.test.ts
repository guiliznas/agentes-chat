import { afterEach, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  createBrainGroup,
  deleteBrainGroup,
  listBrainGroups,
  pickGroupMember,
  updateBrainGroup,
  withGroupBrain,
} from "../src";
import { addMember, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const codeOf = (p: Promise<unknown>) => p.then(() => null).catch((e: { code?: string }) => e.code);

async function world() {
  const fx = await setup();
  f = fx;
  const pair = (name: string) =>
    pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
      name,
      protocol: ACCOUNTS_PROTOCOL,
      exec: true,
    }).then((p) => p.machineId);
  const machineId = await pair("Mac");
  const otherMachineId = await pair("Linux");
  const bia = await addMember(fx.db, fx.org.id, "member", "bia");
  const caio = await addMember(fx.db, fx.org.id, "admin", "caio");
  const account = async (
    label: string,
    over: Partial<typeof schema.machineAccounts.$inferInsert> & { createdBy?: string } = {},
  ) => {
    const [row] = await fx.db
      .insert(schema.machineAccounts)
      .values({
        id: Bun.randomUUIDv7(),
        orgId: fx.org.id,
        machineId,
        kind: "claude_code",
        label,
        status: "active",
        createdBy: fx.owner.id,
        shared: true,
        ...over,
      })
      .returning();
    if (!row) throw new Error("no account");
    return row.id;
  };
  const claude = await account("Claude");
  const codex = await account("Codex", { kind: "codex" });
  return { fx, db: fx.db, org: fx.org.id, machineId, otherMachineId, bia, caio, account, claude, codex };
}

test("a group takes one account of each provider on its computer", async () => {
  const w = await world();
  const view = await createBrainGroup(w.db, w.fx.owner.id, w.org, {
    machineId: w.machineId,
    name: " Time ",
    members: [{ accountId: w.claude }, { accountId: w.codex, model: "gpt-5", effort: "high" }],
  });
  expect(view).toMatchObject({ name: "Time", strategy: "order", canEdit: true, usedBy: [] });
  expect(view.members.map((m) => [m.accountId, m.kind, m.model, m.effort])).toEqual([
    [w.claude, "claude_code", null, null],
    [w.codex, "codex", "gpt-5", "high"],
  ]);
  const second = await w.account("Claude 2");
  expect(
    await codeOf(
      createBrainGroup(w.db, w.fx.owner.id, w.org, {
        machineId: w.machineId,
        name: "Dois",
        members: [{ accountId: w.claude }, { accountId: second }],
      }),
    ),
  ).toBe("brain_group.same_provider");
  expect(
    await codeOf(createBrainGroup(w.db, w.fx.owner.id, w.org, { machineId: w.machineId, name: "x", members: [] })),
  ).toBe("brain_group.empty");
  expect(
    await codeOf(
      createBrainGroup(w.db, w.fx.owner.id, w.org, {
        machineId: w.machineId,
        name: "  ",
        members: [{ accountId: w.claude }],
      }),
    ),
  ).toBe("brain_group.invalid_name");
  expect(
    await codeOf(
      createBrainGroup(w.db, w.fx.owner.id, w.org, {
        machineId: w.machineId,
        name: "ok",
        strategy: "x" as never,
        members: [{ accountId: w.claude }],
      }),
    ),
  ).toBe("brain_group.invalid");
  expect((await listBrainGroups(w.db, w.bia.id, w.org)).map((g) => g.name)).toEqual(["Time"]);
});

test("only shared accounts that serve the person join a group", async () => {
  const w = await world();
  const login = await w.account("Login", { shared: false, kind: "codex" });
  const private_ = await w.account("Dela", { createdBy: w.bia.id, serves: "owner", kind: "codex" });
  const elsewhere = await w.account("Fora", { machineId: w.otherMachineId });
  const create = (accountId: string, userId = w.fx.owner.id) =>
    codeOf(createBrainGroup(w.db, userId, w.org, { machineId: w.machineId, name: "G", members: [{ accountId }] }));
  expect(await create(login)).toBe("brain_group.not_shared");
  expect(await create(private_)).toBe("brain_group.not_yours");
  expect(await create(elsewhere)).toBe("brain_group.other_computer");
  expect(await create(private_, w.bia.id)).toBeNull();
});

test("only its creator or an admin changes a group", async () => {
  const w = await world();
  const g = await createBrainGroup(w.db, w.bia.id, w.org, {
    machineId: w.machineId,
    name: "Bia",
    members: [{ accountId: w.claude }],
  });
  const other = await addMember(w.db, w.org, "member", "dani");
  expect(await codeOf(updateBrainGroup(w.db, other.id, w.org, g.id, { name: "X" }))).toBe("brain_group.not_editor");
  expect(await codeOf(deleteBrainGroup(w.db, other.id, w.org, g.id))).toBe("brain_group.not_editor");
  const seen = (await listBrainGroups(w.db, other.id, w.org))[0];
  expect(seen?.canEdit).toBe(false);
  expect(await codeOf(updateBrainGroup(w.db, w.caio.id, w.org, g.id, { name: "Do admin" }))).toBeNull();
  expect(await codeOf(updateBrainGroup(w.db, w.bia.id, w.org, g.id, { strategy: "room" }))).toBeNull();
  expect((await listBrainGroups(w.db, w.bia.id, w.org))[0]).toMatchObject({ name: "Do admin", strategy: "room" });
});

test("one update reorders the members", async () => {
  const w = await world();
  const g = await createBrainGroup(w.db, w.fx.owner.id, w.org, {
    machineId: w.machineId,
    name: "Ordem",
    members: [{ accountId: w.claude }, { accountId: w.codex }],
  });
  const next = await updateBrainGroup(w.db, w.fx.owner.id, w.org, g.id, {
    members: [{ accountId: w.codex }, { accountId: w.claude }],
  });
  expect(next.members.map((m) => m.accountId)).toEqual([w.codex, w.claude]);
  expect(await codeOf(updateBrainGroup(w.db, w.fx.owner.id, w.org, g.id, { members: [] }))).toBe("brain_group.empty");
});

test("deleting a group frees the agents that used it", async () => {
  const w = await world();
  const g = await createBrainGroup(w.db, w.fx.owner.id, w.org, {
    machineId: w.machineId,
    name: "Apagar",
    members: [{ accountId: w.claude }],
  });
  const [agent] = await w.db.select().from(schema.agents).where(eq(schema.agents.orgId, w.org)).limit(1);
  if (!agent) throw new Error("no agent in fixture");
  await w.db.update(schema.agents).set({ brainGroupId: g.id }).where(eq(schema.agents.id, agent.id));
  expect((await listBrainGroups(w.db, w.fx.owner.id, w.org))[0]?.usedBy).toEqual([{ id: agent.id, name: agent.name }]);
  await deleteBrainGroup(w.db, w.fx.owner.id, w.org, g.id);
  expect(await listBrainGroups(w.db, w.fx.owner.id, w.org)).toEqual([]);
  const [after] = await w.db.select().from(schema.agents).where(eq(schema.agents.id, agent.id));
  expect(after?.brainGroupId).toBeNull();
  const audits = await w.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, w.org));
  expect(audits.map((a) => a.action)).toContain("brain_group.delete");
});

// --- Which member thinks (ADR 0180) ---

const usageAt = (usedPercent: number, resetsInMs = 3_600_000) => ({
  windows: [{ kind: "five_hour" as const, usedPercent, resetsAt: new Date(Date.now() + resetsInMs).toISOString() }],
  source: "probe" as const,
  at: new Date().toISOString(),
});

async function pickWorld(strategy: "order" | "room" = "order") {
  const w = await world();
  const gemini = await w.account("Gemini", { kind: "antigravity" });
  const group = await createBrainGroup(w.db, w.fx.owner.id, w.org, {
    machineId: w.machineId,
    name: "Time",
    strategy,
    members: [{ accountId: w.claude, model: "opus", effort: "high" }, { accountId: w.codex }, { accountId: gemini }],
  });
  const agent = {
    id: w.fx.agent.id,
    orgId: w.org,
    ownerUserId: w.fx.owner.id,
    machineId: w.machineId,
    brainGroupId: group.id,
  };
  const use = (id: string, usage: ReturnType<typeof usageAt> | null) =>
    w.db.update(schema.machineAccounts).set({ usage }).where(eq(schema.machineAccounts.id, id));
  return { ...w, gemini, group, agent, use };
}

test("in order, the first member with room thinks; at its limit the next one does", async () => {
  const w = await pickWorld();
  expect(await pickGroupMember(w.db, w.agent, {})).toMatchObject({
    accountId: w.claude,
    kind: "claude_code",
    model: "opus",
    effort: "high",
    exhausted: false,
  });
  await w.use(w.claude, usageAt(100));
  expect(await pickGroupMember(w.db, w.agent, {})).toMatchObject({
    accountId: w.codex,
    kind: "codex",
    model: null,
    exhausted: false,
  });
});

test("by room, the roomiest member thinks", async () => {
  const w = await pickWorld("room");
  await w.use(w.claude, usageAt(90));
  await w.use(w.codex, usageAt(10));
  await w.use(w.gemini, usageAt(50));
  expect((await pickGroupMember(w.db, w.agent, {}))?.accountId).toBe(w.codex);
});

test("a conversation keeps its member while it has room", async () => {
  const w = await pickWorld("room");
  await w.use(w.claude, usageAt(90));
  await w.use(w.codex, usageAt(60));
  await w.use(w.gemini, usageAt(5));
  const root = Bun.randomUUIDv7();
  await w.db.insert(schema.agentRuns).values({
    orgId: w.org,
    agentId: w.agent.id,
    channelId: Bun.randomUUIDv7(),
    threadRootId: root,
    triggerMessageId: root,
    trigger: "mention",
    hop: 1,
    status: "done",
    brainAccountId: w.codex,
  });
  expect((await pickGroupMember(w.db, w.agent, {}))?.accountId).toBe(w.gemini);
  expect((await pickGroupMember(w.db, w.agent, { threadRootId: root }))?.accountId).toBe(w.codex);
  await w.use(w.codex, usageAt(100));
  expect((await pickGroupMember(w.db, w.agent, { threadRootId: root }))?.accountId).toBe(w.gemini);
});

test("a member signed out, removed or kept to its owner is skipped", async () => {
  const w = await pickWorld();
  const set = (id: string, v: Partial<typeof schema.machineAccounts.$inferInsert>) =>
    w.db.update(schema.machineAccounts).set(v).where(eq(schema.machineAccounts.id, id));
  await set(w.claude, { status: "signed_out" });
  expect((await pickGroupMember(w.db, w.agent, {}))?.accountId).toBe(w.codex);
  // Kept to its owner (someone else's agent can't use it).
  await set(w.codex, { serves: "owner", createdBy: w.bia.id });
  expect((await pickGroupMember(w.db, w.agent, {}))?.accountId).toBe(w.gemini);
  // Removed.
  await w.db.delete(schema.machineAccounts).where(eq(schema.machineAccounts.id, w.gemini));
  expect(await pickGroupMember(w.db, w.agent, {})).toBeNull();
  const agent = await withGroupBrain(
    w.db,
    { ...w.agent, brain: "model", brainModel: "m", brainEffort: null, brainAccountId: null, brainAccountLentBy: null },
    {},
  );
  expect(agent.brain).toBe("model");
});

test("every member at its limit: the one back first, marked exhausted", async () => {
  const w = await pickWorld();
  await w.use(w.claude, usageAt(100, 3 * 3_600_000));
  await w.use(w.codex, usageAt(100, 1 * 3_600_000));
  await w.use(w.gemini, usageAt(100, 2 * 3_600_000));
  expect(await pickGroupMember(w.db, w.agent, {})).toMatchObject({ accountId: w.codex, exhausted: true });
});

test("the right hand and an agent with no group are themselves", async () => {
  const w = await pickWorld();
  const base = {
    ...w.agent,
    brain: "model",
    brainModel: "m",
    brainEffort: null,
    brainAccountId: null,
    brainAccountLentBy: null,
  };
  const other = await withGroupBrain(w.db, { ...base, brainGroupId: null }, {});
  expect(other.brain).toBe("model");
  const hand = await withGroupBrain(w.db, { ...base, builtin: "right_hand" }, {});
  expect(hand.brain).toBe("model");
  const grouped = await withGroupBrain(w.db, base, {});
  expect(grouped).toMatchObject({
    brain: "claude_code",
    brainModel: "opus",
    brainEffort: "high",
    brainAccountId: w.claude,
    brainAccountLentBy: null,
  });
  expect(await withGroupBrain(w.db, { ...base, machineId: null }, {})).toMatchObject({ brain: "model" });
});
