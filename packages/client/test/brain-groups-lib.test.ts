import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { BrainGroup, MachineAccount } from "../src/api/types";
import { groupCandidates, groupLine, groupProviderKey } from "../src/lib/brain-groups";

const i18n = i18next.createInstance();
void i18n.init({ lng: "pt-BR", resources, initAsync: false });
const t = i18n.t.bind(i18n) as TFunction;

const MAC = "m1";
const ME = "u_ana";

/** One of Ana's shared Claude sign-ins on the Mac, unless said otherwise. */
const account = (
  id: string,
  over: Partial<MachineAccount & { machineId: string }> = {},
): MachineAccount & { machineId: string } => ({
  id,
  kind: "claude_code",
  label: id,
  email: null,
  plan: null,
  status: "active",
  ownerId: ME,
  ownerName: "Ana",
  mine: true,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  shared: true,
  serves: "everyone",
  machineId: MAC,
  ...over,
});

const ids = (list: { id: string }[]) => list.map((a) => a.id);

describe("groupCandidates: what a brain group may hold on a computer", () => {
  test("per-agent logins are left out: only the shared ones are members", () => {
    const [claude] = groupCandidates([account("own", { shared: false }), account("ok")], MAC, ME);
    expect(claude?.provider).toBe("claude_code");
    expect(ids(claude?.accounts ?? [])).toEqual(["ok"]);
    expect(groupCandidates([account("own", { shared: false })], MAC, ME)).toEqual([]);
  });

  test("another person's «Só eu» account is left out; mine, and anyone's «todos», stay", () => {
    const theirsOnly = account("theirs", { mine: false, ownerId: "u_bia", serves: "owner" });
    const theirsAll = account("theirs-all", { mine: false, ownerId: "u_bia", serves: "everyone" });
    const mineOnly = account("mine-only", { serves: "owner" });
    const [group] = groupCandidates([theirsOnly, theirsAll, mineOnly], MAC, ME);
    expect(ids(group?.accounts ?? [])).toEqual(["theirs-all", "mine-only"]);
  });

  test("signed-out accounts and other computers' are left out", () => {
    const list = [account("out", { status: "signed_out" }), account("far", { machineId: "m2" }), account("ok")];
    expect(groupCandidates(list, MAC, ME).flatMap((g) => ids(g.accounts))).toEqual(["ok"]);
  });

  test("two Claude accounts are alternatives of one provider, not two members", () => {
    const groups = groupCandidates([account("c1"), account("c2"), account("x", { kind: "codex" })], MAC, ME);
    expect(groups.map((g) => g.provider)).toEqual(["claude_code", "codex"]);
    expect(ids(groups[0]?.accounts ?? [])).toEqual(["c1", "c2"]);
  });

  test("a coding plan's key is its own provider, apart from the CLI's sign-in of that kind", () => {
    const groups = groupCandidates([account("cli"), account("glm", { provider: "zai" })], MAC, ME);
    expect(groups.map((g) => g.provider)).toEqual(["claude_code", "zai"]);
    expect(groupProviderKey(account("glm", { provider: "zai" }))).toBe("zai");
    expect(groupProviderKey(account("cli"))).toBe("claude_code");
  });
});

const member = (kind: string, provider: string | null = null) => ({
  accountId: `${kind}-${provider}`,
  label: kind,
  kind,
  provider,
  model: null,
  effort: null,
  status: "active",
  usage: null,
});

const group = (strategy: BrainGroup["strategy"]): Pick<BrainGroup, "strategy" | "members"> => ({
  strategy,
  members: [member("claude_code"), member("codex"), member("antigravity")],
});

describe("groupLine: the group in one line", () => {
  test("in order: the providers as the product names them, then how they are taken", () => {
    expect(groupLine(t, group("order"))).toBe("Claude → ChatGPT → Gemini · em ordem");
  });

  test("by room: says it picks the one with the most left", () => {
    expect(groupLine(t, group("room"))).toBe("Claude → ChatGPT → Gemini · a que tem mais folga");
  });
});
