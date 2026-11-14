import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

// Brain group routes (ADR 0180).
let t: TestServer;
afterEach(() => t.close());

const RUNNER = {
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.5.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

interface Group {
  id: string;
  name: string;
  strategy: string;
  machineId: string;
  members: { accountId: string; provider: string | null; kind: string }[];
  canEdit: boolean;
}

async function workspace() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${seeded.orgId}${path}`, init);
  const member = browser(t);
  await signUp(member, "bia@example.com");
  const { url } = (await (
    await api("/invitations", { json: { email: "bia@example.com", role: "member" } })
  ).json()) as { url: string };
  await member(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
  const asBia = (path: string, init?: Parameters<typeof member>[1]) =>
    member(`/api/app/organizations/${seeded.orgId}${path}`, init);
  const mac = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "mac" });
  await t.db
    .update(schema.machines)
    .set({ executors: { claude: { version: "2.1.0" }, codex: { version: "codex-cli 0.170.0" } } })
    .where(eq(schema.machines.id, mac.machineId));
  const [ownerRow] = await t.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "owner@example.com"));
  const account = async (kind: "claude_code" | "codex", label: string) => {
    const id = crypto.randomUUID();
    await t.db.insert(schema.machineAccounts).values({
      id,
      orgId: seeded.orgId,
      machineId: mac.machineId,
      kind,
      label,
      shared: true,
      createdBy: ownerRow?.id ?? null,
    });
    return id;
  };
  return { ...seeded, api, asBia, machineId: mac.machineId, account };
}

test("a member creates a group of their plans and gives it to their agent", async () => {
  const { api, agentId, machineId, account } = await workspace();
  const claude = await account("claude_code", "Claude A");
  const claude2 = await account("claude_code", "Claude B");
  const codex = await account("codex", "Codex A");
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId } });
  await api(`/agents/${agentId}/brain`, { method: "PUT", json: { brain: "claude_code" } });

  const created = await api("/brain-groups", {
    json: { machineId, name: "Planos", members: [{ accountId: claude }, { accountId: codex }] },
  });
  expect(created.status).toBe(201);
  const group = (await created.json()) as Group;
  expect(group).toMatchObject({ name: "Planos", strategy: "order", machineId, canEdit: true });
  expect(group.members.map((m) => m.accountId)).toEqual([claude, codex]);

  // Two accounts of one provider: refused.
  const twice = await api("/brain-groups", {
    json: { machineId, name: "Dois", members: [{ accountId: claude }, { accountId: claude2 }] },
  });
  expect(twice.status).toBe(409);
  expect(await twice.json()).toMatchObject({ error: { code: "brain_group.same_provider" } });

  // The list and the agent's brain show it.
  const listed = (await (await api("/brain-groups")).json()) as { groups: Group[] };
  expect(listed.groups.map((g) => g.id)).toEqual([group.id]);
  const put = await api(`/agents/${agentId}/brain`, { method: "PUT", json: { group: group.id } });
  expect(put.status).toBe(200);
  expect(await put.json()).toMatchObject({ group: { id: group.id, name: "Planos" } });
  const got = (await (await api(`/agents/${agentId}/brain`)).json()) as {
    group: { id: string; current: { accountId: string } | null };
  };
  expect(got.group.id).toBe(group.id);
  expect(got.group.current?.accountId).toBe(claude);

  // The group's members are replaced as one ordered list.
  const updated = await api(`/brain-groups/${group.id}`, {
    method: "PUT",
    json: { name: "Planos 2", strategy: "room", members: [{ accountId: codex }, { accountId: claude2 }] },
  });
  expect(updated.status).toBe(200);
  const after = (await updated.json()) as Group;
  expect(after).toMatchObject({ name: "Planos 2", strategy: "room" });
  expect(after.members.map((m) => m.accountId)).toEqual([codex, claude2]);

  // Deleting it frees the agent.
  const gone = await api(`/brain-groups/${group.id}`, { method: "DELETE" });
  expect(gone.status).toBe(204);
  expect(((await (await api(`/agents/${agentId}/brain`)).json()) as { group: unknown }).group).toBeNull();
  expect(((await (await api("/brain-groups")).json()) as { groups: Group[] }).groups).toEqual([]);
});

test("an agent that moves to another computer leaves its group", async () => {
  const { api, agentId, machineId, account } = await workspace();
  const claude = await account("claude_code", "Claude A");
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId } });
  await api(`/agents/${agentId}/brain`, { method: "PUT", json: { brain: "claude_code" } });
  const group = (await (
    await api("/brain-groups", { json: { machineId, name: "Um", members: [{ accountId: claude }] } })
  ).json()) as Group;
  await api(`/agents/${agentId}/brain`, { method: "PUT", json: { group: group.id } });
  const [before] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  expect(before?.brainGroupId).toBe(group.id);
  const moved = await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: null } });
  expect(moved.status).toBe(200);
  const [row] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  expect(row?.brainGroupId).toBeNull();
});

test("only who made a group, or an admin, changes it", async () => {
  const { api, asBia, machineId, account } = await workspace();
  const claude = await account("claude_code", "Claude A");
  const group = (await (
    await api("/brain-groups", { json: { machineId, name: "Do dono", members: [{ accountId: claude }] } })
  ).json()) as Group;

  const seen = (await (await asBia("/brain-groups")).json()) as { groups: Group[] };
  expect(seen.groups[0]).toMatchObject({ id: group.id, canEdit: false });
  const edit = await asBia(`/brain-groups/${group.id}`, { method: "PUT", json: { name: "Meu" } });
  expect(edit.status).toBe(403);
  expect(await edit.json()).toMatchObject({ error: { code: "brain_group.not_editor" } });
  const del = await asBia(`/brain-groups/${group.id}`, { method: "DELETE" });
  expect(del.status).toBe(403);
});
