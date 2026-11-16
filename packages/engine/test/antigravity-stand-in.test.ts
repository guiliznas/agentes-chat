import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type PlanUsage } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type Brain,
  type BrainEvent,
  type BrainTurn,
  clearPlanLimits,
  createJobHandlers,
  drainOutbox,
  type MachineStatus,
  postPersonMessage,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * Antigravity's model groups each have a quota of their own and its 429 names none: the account's refusal is kept by
 * the model asked, the turn goes again at once on another model that still has quota, and the run waits only when
 * every model has been refused.
 */
let f: Fixture;
afterEach(() => {
  clearPlanLimits();
  const fx: Fixture | undefined = f;
  f = undefined as unknown as Fixture;
  return fx?.close();
});

const FLASH = "gemini-3.8-flash-medium";
const ARGON = "gemini-4-argon-medium";
const REFUSAL = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 138h.";

const statusOf = (machineId: string): MachineStatus => ({
  id: machineId,
  orgId: "org",
  name: "box",
  online: true,
  execAllowed: true,
  os: "linux",
  protocol: MACHINE_PROTOCOL_VERSION,
  executors: { antigravity: { version: "agy 1.5.9" }, detectedAt: new Date().toISOString() },
});

/** An Antigravity account on a runner, the agent on `FLASH`, the account read with room in Gemini's own windows. */
async function geminiAgent(fx: Fixture) {
  const paired = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "box",
    hostname: "box",
    os: "linux",
    arch: "x64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/home/w/agentes",
    exec: true,
  });
  const accountId = crypto.randomUUID();
  const usage: PlanUsage = {
    source: "probe",
    at: new Date().toISOString(),
    windows: [
      { kind: "seven_day", usedPercent: 3, resetsAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
      { kind: "five_hour", usedPercent: 2, resetsAt: new Date(Date.now() + 4 * 3600_000).toISOString() },
    ],
  };
  await fx.db.insert(schema.machineAccounts).values({
    id: accountId,
    orgId: fx.org.id,
    machineId: paired.machineId,
    kind: "antigravity",
    label: "Gemini",
    status: "active",
    createdBy: fx.owner.id,
    usage,
  });
  await fx.db
    .update(schema.agents)
    .set({
      machineId: paired.machineId,
      brain: "antigravity",
      brainModel: FLASH,
      brainFallback: false,
      brainAccountId: accountId,
    })
    .where(eq(schema.agents.id, fx.agent.id));
  return { accountId };
}

function scripted(script: (n: number, turn: BrainTurn) => BrainEvent[]) {
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind: "antigravity",
    async *run(turn) {
      const n = seen.length;
      seen.push({ ...turn, system: "", messages: [] });
      yield* script(n, turn);
    },
  };
  return { brain, seen };
}

const handlers = (fx: Fixture, brain: Brain) =>
  createJobHandlers({
    ...fx.jobDeps,
    brains: { antigravity: () => brain },
    machines: { status: async (id) => statusOf(id) },
    planLimitGraceMs: 50,
  });

const post = (fx: Fixture, body: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });

const runs = (fx: Fixture) => fx.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);

const accountUsage = async (fx: Fixture, id: string) =>
  (await fx.db.select().from(schema.machineAccounts).where(eq(schema.machineAccounts.id, id)))[0]?.usage;

const refused = (resetsAt: string): BrainEvent[] => [
  { type: "limit", resetsAt },
  { type: "error", code: "plan_limit", message: REFUSAL, worked: false },
];

test("a refused model: the turn goes again at once on another model with quota, and later runs start there", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  const { accountId } = await geminiAgent(f);
  const week = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const { brain, seen } = scripted((n) => (n === 0 ? refused(week) : [{ type: "done", text: "feito" }]));
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers(f, brain));
  expect(seen.map((t) => t.model)).toEqual([FLASH, ARGON]);
  expect((await runs(f))[0]?.status).toBe("done");
  // The refusal is the model's, kept by its base model; the account is not at its limit.
  const usage = await accountUsage(f, accountId);
  expect(usage?.models?.["gemini-3.8-flash"]).toMatchObject({ until: week });
  expect(usage?.limited).toBeUndefined();
  // While Flash is held, the next run starts on the model that has quota.
  await post(f, "@dev e agora?");
  await drainOutbox(f.db, handlers(f, brain));
  expect(seen.at(-1)?.model).toBe(ARGON);
});

test("every model refused: the run waits for that model's reset instead of asking again and again", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await geminiAgent(f);
  const week = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const { brain, seen } = scripted(() => refused(week));
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers(f, brain));
  expect(seen.map((t) => t.model)).toEqual([FLASH, ARGON]);
  const [run] = await runs(f);
  expect(run?.status).toBe("waiting_input");
  expect((run?.transcript as { waitingForBrain?: Record<string, unknown> } | undefined)?.waitingForBrain).toMatchObject(
    {
      code: "plan_limit",
      scope: "model",
    },
  );
});
