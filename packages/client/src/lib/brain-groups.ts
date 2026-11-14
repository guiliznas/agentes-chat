import type { TFunction } from "i18next";
import type { BrainGroup, MachineAccount } from "../api/types";
import { planLabel, planOfAccount } from "./no-ai";

/*
 * Brain groups (ADR 0180): at most one account per provider on one computer, which an agent can think with. The same
 * rules the engine checks when a group is saved (`packages/engine/src/brains/groups.ts`), so the pickers offer only
 * what the server accepts.
 */

/** The provider a group holds one account of: a coding plan's key, else the CLI's kind (the engine's `provider ?? kind`). */
export const groupProviderKey = (a: Pick<MachineAccount, "provider" | "kind">): string => a.provider ?? a.kind;

/** A provider with the accounts that could stand for it in a group: the person picks one of them. */
export interface GroupCandidates<A> {
  provider: string;
  accounts: A[];
}

/**
 * The accounts `userId` may put in a group on `machineId`: shared (not a login of one agent), active, on that computer
 * and serving them (everyone's, or made by them), by provider in the order each first shows. Two accounts of one
 * provider are alternatives for one slot, never two members.
 */
export function groupCandidates<A extends MachineAccount & { machineId: string }>(
  accounts: readonly A[],
  machineId: string,
  userId: string,
): GroupCandidates<A>[] {
  const byProvider = new Map<string, A[]>();
  for (const a of accounts) {
    if (a.machineId !== machineId || a.shared !== true || a.status !== "active") continue;
    if (a.serves === "owner" && a.ownerId !== userId) continue;
    const key = groupProviderKey(a);
    byProvider.set(key, [...(byProvider.get(key) ?? []), a]);
  }
  return [...byProvider].map(([provider, list]) => ({ provider, accounts: list }));
}

/** "Claude → ChatGPT → Gemini · em ordem": its members in the order they are tried, then how one is picked. */
export function groupLine(t: TFunction, group: Pick<BrainGroup, "strategy" | "members">): string {
  const names = group.members.map((m) => planLabel(t, planOfAccount(m as Pick<MachineAccount, "kind" | "provider">)));
  return t(`brain.group.line.${group.strategy}`, { names: names.join(" → ") });
}
