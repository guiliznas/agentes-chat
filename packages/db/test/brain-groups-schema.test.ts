import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { type Database, schema } from "../src";
import { createTestDatabase } from "./pglite";

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(() => close());

async function seed() {
  const [org] = await db.insert(schema.organizations).values({ name: "Acme" }).returning();
  if (!org) throw new Error("no org");
  const [machine] = await db.insert(schema.machines).values({ orgId: org.id, name: "Mac" }).returning();
  if (!machine) throw new Error("no machine");
  const account = async (kind: string, label: string) => {
    const [row] = await db
      .insert(schema.machineAccounts)
      .values({ id: Bun.randomUUIDv7(), orgId: org.id, machineId: machine.id, kind, label })
      .returning();
    if (!row) throw new Error("no account");
    return row;
  };
  const [group] = await db
    .insert(schema.brainGroups)
    .values({ orgId: org.id, machineId: machine.id, name: "Dupla" })
    .returning();
  if (!group) throw new Error("no group");
  return { org, machine, group, account };
}

describe("brain groups", () => {
  test("a group holds one account per provider, and goes with its computer", async () => {
    const { org, machine, group, account } = await seed();
    expect(group.strategy).toBe("order");
    const claude = await account("claude_code", "Claude");
    const claude2 = await account("claude_code", "Claude 2");
    const codex = await account("codex", "Codex");
    const member = (a: { id: string }, position: number, providerKey: string) => ({
      orgId: org.id,
      groupId: group.id,
      accountId: a.id,
      position,
      providerKey,
    });
    await db.insert(schema.brainGroupMembers).values(member(claude, 0, "claude_code"));
    await expect(
      (async () => await db.insert(schema.brainGroupMembers).values(member(claude2, 1, "claude_code")))(),
    ).rejects.toThrow();
    await expect(
      (async () => await db.insert(schema.brainGroupMembers).values(member(codex, 0, "codex")))(),
    ).rejects.toThrow();
    await db.insert(schema.brainGroupMembers).values(member(codex, 1, "codex"));

    // Deleting an account deletes only its membership.
    await db.delete(schema.machineAccounts).where(eq(schema.machineAccounts.id, codex.id));
    const left = await db.select().from(schema.brainGroupMembers);
    expect(left.map((m) => m.accountId)).toEqual([claude.id]);
    expect(await db.select().from(schema.brainGroups)).toHaveLength(1);

    // Deleting the computer deletes the group and its members.
    await db.delete(schema.machineAccounts).where(eq(schema.machineAccounts.id, claude2.id));
    await db.delete(schema.machines).where(eq(schema.machines.id, machine.id));
    expect(await db.select().from(schema.brainGroups)).toHaveLength(0);
    expect(await db.select().from(schema.brainGroupMembers)).toHaveLength(0);
  });

  test("a group's name and strategy are checked", async () => {
    const { org, machine } = await seed();
    const base = { orgId: org.id, machineId: machine.id };
    await expect((async () => await db.insert(schema.brainGroups).values({ ...base, name: "" }))()).rejects.toThrow();
    await expect(
      (async () => await db.insert(schema.brainGroups).values({ ...base, name: "x".repeat(41) }))(),
    ).rejects.toThrow();
    await expect(
      (async () => await db.insert(schema.brainGroups).values({ ...base, name: "ok", strategy: "mix" }))(),
    ).rejects.toThrow();
    await db.insert(schema.brainGroups).values({ ...base, name: "x".repeat(40), strategy: "room" });
  });
});
