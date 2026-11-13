import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  agentAiState,
  type Brain,
  type BrainEvent,
  type BrainTurn,
  clearPlanLimits,
  createBrainGroup,
  createJobHandlers,
  createRoutine,
  drainOutbox,
  type MachineStatus,
  machineAgents,
  postPersonMessage,
  RESUME_AFTER_MS,
  RESUME_GAP_MS,
  resolveBrain,
  runRoutineNow,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/** An agent on a brain group thinks with the member the group picks, on every turn (ADR 0180). */

let f: Fixture | undefined;
afterEach(async () => {
  clearPlanLimits();
  await f?.close();
  f = undefined;
});

const RUNNER = {
  hostname: "mac",
  os: "darwin" as const,
  arch: "arm64",
  version: "0.8.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

const statusOf = (machineId: string): MachineStatus => ({
  id: machineId,
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: MACHINE_PROTOCOL_VERSION,
  executors: {
    claude: { version: "2.1.300", loggedIn: true },
    codex: { version: "0.200.0" },
    detectedAt: new Date().toISOString(),
  },
});

const usageAt = (usedPercent: number, resetsInMs = 3_600_000) => ({
  windows: [{ kind: "five_hour" as const, usedPercent, resetsAt: new Date(Date.now() + resetsInMs).toISOString() }],
  source: "probe" as const,
  at: new Date().toISOString(),
});

/** The fixture's agent on a computer, in a group of a Claude and a Codex account there. */
async function grouped(fx: Fixture, over: Partial<typeof schema.agents.$inferInsert> = {}) {
  const paired = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "MacBook",
    ...RUNNER,
    exec: true,
  });
  const machineId = paired.machineId;
  const account = async (label: string, kind: string) => {
    const [row] = await fx.db
      .insert(schema.machineAccounts)
      .values({
        id: Bun.randomUUIDv7(),
        orgId: fx.org.id,
        machineId,
        kind,
        label,
        status: "active",
        createdBy: fx.owner.id,
        shared: true,
      })
      .returning();
    if (!row) throw new Error("no account");
    return row.id;
  };
  const claude = await account("Claude", "claude_code");
  const codex = await account("Codex", "codex");
  const group = await createBrainGroup(fx.db, fx.owner.id, fx.org.id, {
    machineId,
    name: "Time",
    members: [{ accountId: claude }, { accountId: codex, model: "gpt-5", effort: "high" }],
  });
  await fx.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainGroupId: group.id, ...over })
    .where(eq(schema.agents.id, fx.agent.id));
  const use = (id: string, usage: ReturnType<typeof usageAt>) =>
    fx.db.update(schema.machineAccounts).set({ usage }).where(eq(schema.machineAccounts.id, id));
  return { machineId, claude, codex, group, use };
}

function scripted(kind: "claude_code" | "codex", script: (n: number) => BrainEvent[]) {
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind,
    async *run(turn) {
      const n = seen.length;
      seen.push(turn);
      yield* script(n);
    },
  };
  return { brain, seen, turns: () => seen.length };
}

const handlersWith = (fx: Fixture, brains: Partial<Record<"claude_code" | "codex", Brain>>) =>
  createJobHandlers({
    ...fx.jobDeps,
    brains: Object.fromEntries(Object.entries(brains).map(([k, b]) => [k, () => b])),
    machines: { status: async (id) => statusOf(id) },
    planLimitGraceMs: 50,
  });

const runs = (fx: Fixture) => fx.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);

test("a run of an agent on a group thinks with the member's account and model", async () => {
  f = await setup();
  const g = await grouped(f);
  await g.use(g.claude, usageAt(100));
  const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  if (!agent) throw new Error("no agent");
  const root = Bun.randomUUIDv7();
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: agent.id,
      channelId: f.general.id,
      threadRootId: root,
      triggerMessageId: root,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  if (!run) throw new Error("no run");
  const plan = await resolveBrain({ db: f.db }, agent, run, root);
  expect(plan).toMatchObject({ kind: "codex", account: { id: g.codex }, model: "gpt-5", effort: "high" });
});

test("a turn records the member it thought with, and the conversation keeps it", async () => {
  f = await setup();
  const g = await grouped(f, { brainFallback: false });
  const { brain } = scripted("codex", () => [{ type: "done", text: "pelo Codex" }]);
  const claude = scripted("claude_code", () => [{ type: "done", text: "pelo Claude" }]);
  await g.use(g.claude, usageAt(100));
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  await drainOutbox(f.db, handlersWith(f, { codex: brain, claude_code: claude.brain }));
  const [run] = await runs(f);
  expect([run?.status, run?.brain, run?.brainAccountId]).toEqual(["done", "codex", g.codex]);
  expect(claude.turns()).toBe(0);
});

test("the computer's frame lends every member of the agent's group", async () => {
  f = await setup();
  const g = await grouped(f);
  const listed = (await machineAgents(f.db, f.org.id, g.machineId)).find((a) => a.id === f?.agent.id);
  expect(listed).toBeDefined();
  expect([listed?.account, ...(listed?.accounts ?? [])].sort()).toEqual([g.claude, g.codex].sort());
});

test("with every member at its limit, a person's run falls back to the workspace key", async () => {
  f = await setup({ reply: () => ({ chunks: ["Respondi pela API."] }) });
  const g = await grouped(f, { brainFallback: true });
  await g.use(g.claude, usageAt(100, 3 * 3_600_000));
  await g.use(g.codex, usageAt(100, 3_600_000));
  const codex = scripted("codex", () => [{ type: "done", text: "não" }]);
  const claude = scripted("claude_code", () => [{ type: "done", text: "não" }]);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  await drainOutbox(f.db, handlersWith(f, { codex: codex.brain, claude_code: claude.brain }));
  const [run] = await runs(f);
  expect([run?.status, run?.brain]).toEqual(["done", "model"]);
  expect(codex.turns() + claude.turns()).toBe(0);
  const steps = await f.db
    .select()
    .from(schema.agentRunSteps)
    .where(and(eq(schema.agentRunSteps.runId, run?.id ?? ""), eq(schema.agentRunSteps.kind, "context")));
  const fell = steps.map((s) => s.data.brainFallback).find(Boolean);
  // The member back first is the one tried: its limit is what the run fell back from.
  expect(fell).toMatchObject({ from: "codex", code: "plan_limit" });
});

test("with every member at its limit, a routine's run waits for the first reset", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  const g = await grouped(f, { brainFallback: true });
  const first = new Date(Date.now() + 3_600_000);
  await g.use(g.claude, usageAt(100, 3 * 3_600_000));
  await g.use(g.codex, {
    ...usageAt(100),
    windows: [{ kind: "five_hour", usedPercent: 100, resetsAt: first.toISOString() }],
  });
  const codex = scripted("codex", () => [{ type: "done", text: "não" }]);
  const claude = scripted("claude_code", () => [{ type: "done", text: "não" }]);
  const deps = { db: f.db, pubsub: f.pubsub, context: f.context };
  const routine = await createRoutine(deps, f.owner.id, f.org.id, {
    name: "Deploys",
    agentId: f.agent.id,
    prompt: "Check the deploys.",
    target: { type: "channel", channelId: f.general.id },
    trigger: { type: "schedule", phrase: "todo dia às 8h" },
  });
  await runRoutineNow(deps, f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, handlersWith(f, { codex: codex.brain, claude_code: claude.brain }));
  const [run] = await runs(f);
  expect(run?.status).toBe("waiting_input");
  expect(f.provider.calls).toHaveLength(0);
  const jobs = await f.db
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.kind, "agent_run.execute"), eq(schema.outbox.status, "pending")));
  const job = jobs.find((j) => j.payload.runId === run?.id && typeof j.payload.wait === "string");
  expect(job?.nextAttemptAt.getTime()).toBe(first.getTime() + RESUME_AFTER_MS);
});

test("an agent whose own sign-in is gone has an AI while a member of its group can think", async () => {
  f = await setup();
  const g = await grouped(f, { brainFallback: false });
  const [gone] = await f.db
    .insert(schema.machineAccounts)
    .values({
      id: Bun.randomUUIDv7(),
      orgId: f.org.id,
      machineId: g.machineId,
      kind: "claude_code",
      label: "Saiu",
      status: "signed_out",
      createdBy: f.owner.id,
      shared: true,
    })
    .returning();
  await f.db.update(schema.agents).set({ brainAccountId: gone?.id }).where(eq(schema.agents.id, f.agent.id));
  const deps = {
    db: f.db,
    gateway: { hasModelCredential: async () => false },
    machines: { status: async (id: string) => statusOf(id) },
  };
  const row = async () => {
    const [agent] = (await f?.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id))) ?? [];
    if (!agent) throw new Error("no agent");
    return agent;
  };
  expect((await agentAiState(deps, { ...(await row()), brainGroupId: null })).state).toBe("no_ai");
  expect((await agentAiState(deps, await row())).state).toBe("ready");
  // Every member signed out: no AI again.
  await f.db
    .update(schema.machineAccounts)
    .set({ status: "signed_out" })
    .where(eq(schema.machineAccounts.orgId, f.org.id));
  expect((await agentAiState(deps, await row())).state).toBe("no_ai");
});

test("back on a member of another CLI, a conversation starts that CLI's session afresh with the whole conversation", async () => {
  f = await setup();
  const g = await grouped(f, { brainFallback: false });
  const claude = scripted("claude_code", (n) => [
    { type: "done", text: n === 0 ? "Resposta do Claude." : "De volta." },
  ]);
  const codex = scripted("codex", () => [{ type: "done", text: "Resposta do Codex." }]);
  const handlers = handlersWith(f, { claude_code: claude.brain, codex: codex.brain });
  const fx = f;
  const question = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "@dev oi",
  });
  const reply = (body: string) =>
    postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body,
      threadId: question.id,
    });
  await drainOutbox(fx.db, handlers);
  expect(claude.turns()).toBe(1);
  // Claude at its limit: Codex takes the conversation.
  await g.use(g.claude, usageAt(100));
  await reply("@dev e agora?");
  await drainOutbox(fx.db, handlers);
  expect(codex.turns()).toBe(1);
  expect(codex.seen[0]?.session?.resume).toBe(false);
  // Codex at its limit, Claude back: Claude again, but never its old session (it missed Codex's turn).
  await g.use(g.claude, usageAt(0));
  await g.use(g.codex, usageAt(100));
  await reply("@dev e então?");
  await drainOutbox(fx.db, handlers);
  expect(claude.turns()).toBe(2);
  const third = claude.seen[1];
  expect(third?.session?.resume).toBe(false);
  expect(third?.session?.id).not.toBe(claude.seen[0]?.session?.id);
  expect(JSON.stringify(third)).toContain("Resposta do Codex.");
});

test("a turn cut by its member's limit waits for that member, never redone on another with room", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  const g = await grouped(f);
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  const claude = scripted("claude_code", () => [
    { type: "usage", input: 1200, output: 80, source: "plan" },
    {
      type: "tool_call",
      id: "t1",
      name: "Bash",
      input: { command: "git push origin main" },
      executed: { content: "ok" },
    },
    { type: "limit", resetsAt },
    { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: true },
  ]);
  const codex = scripted("codex", () => [{ type: "done", text: "Refiz tudo." }]);
  const handlers = handlersWith(f, { claude_code: claude.brain, codex: codex.brain });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev faz o deploy",
  });
  await drainOutbox(f.db, handlers);
  const [cut] = await runs(f);
  expect(cut?.status).toBe("waiting_input");
  expect(cut?.brainAccountId).toBe(g.claude);
  const cutTranscript = cut?.transcript as { interruptedTurn?: { cause?: string } } | undefined;
  expect(cutTranscript?.interruptedTurn?.cause).toBe("plan_limit");
  // Claude still at its limit when the resume comes; Codex has room.
  await g.use(g.claude, { ...usageAt(100), windows: [{ kind: "five_hour", usedPercent: 100, resetsAt }] });
  await drainOutbox(f.db, handlers, { now: new Date(Date.parse(resetsAt) + RESUME_AFTER_MS + RESUME_GAP_MS) });
  expect(codex.turns()).toBe(0);
  expect(f.provider.calls).toHaveLength(0);
  const [after] = await runs(f);
  expect([after?.status, after?.brain, after?.brainAccountId]).toEqual(["waiting_input", "claude_code", g.claude]);
});

test("a member of a sandboxed CLI keeps the containers service off the agent's frame", async () => {
  f = await setup();
  const g = await grouped(f);
  const frame = async () =>
    (await machineAgents(f?.db as Fixture["db"], f?.org.id ?? "", g.machineId)).find((a) => a.id === f?.agent.id);
  // Its own brain alone (Claude Code) would have it.
  expect((await frame())?.containers).toBeUndefined();
  await f.db.update(schema.agents).set({ brainGroupId: null }).where(eq(schema.agents.id, f.agent.id));
  expect((await frame())?.containers).toBe(true);
});
