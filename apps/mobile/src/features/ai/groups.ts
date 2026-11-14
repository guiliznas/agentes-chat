import type { AiAccounts, BrainGroup, BrainGroupMemberInput } from "@agenteschat/client";
import { groupCandidates, groupProviderKey } from "@agenteschat/client/lib/brain-groups";

/*
 * A brain group being made or changed on the phone (ADR 0180), as the web's dialog (`BrainGroups.tsx`): one slot per
 * provider, the account standing for it, and its own model and effort. Pure, so it is unit-tested.
 */

type Account = AiAccounts["accounts"][number];

/** A name the server takes: 1 to 40 characters once trimmed. */
export const GROUP_NAME_MAX = 40;

/** One slot of the group being edited: its provider and the account standing for it (null model/effort: the agent's). */
export interface Slot {
  provider: string;
  accountId: string;
  model: string | null;
  effort: string | null;
}

/** A new group starts with every provider on that computer, each by its first account: taking one out is one press. */
export const startSlots = (accounts: readonly Account[], machineId: string, userId: string): Slot[] =>
  groupCandidates(accounts, machineId, userId).flatMap((c) =>
    c.accounts[0] ? [{ provider: c.provider, accountId: c.accounts[0].id, model: null, effort: null }] : [],
  );

/** A saved group's members as slots, in its order. */
export const slotsOf = (group: Pick<BrainGroup, "members">): Slot[] =>
  group.members.map((m) => ({
    provider: groupProviderKey(m),
    accountId: m.accountId,
    model: m.model,
    effort: m.effort,
  }));

/** One slot a step up or down the order; at an end, the order as it was. */
export function moveSlot(slots: readonly Slot[], index: number, step: -1 | 1): Slot[] {
  const to = index + step;
  if (to < 0 || to >= slots.length) return [...slots];
  const next = [...slots];
  const [s] = next.splice(index, 1);
  if (s) next.splice(to, 0, s);
  return next;
}

/** What the server takes for the members: their order is the position. */
export const membersInput = (slots: readonly Slot[]): BrainGroupMemberInput[] =>
  slots.map((s) => ({ accountId: s.accountId, model: s.model, effort: s.effort }));

/** A name the server takes. */
export const groupNameOk = (name: string) => {
  const n = name.trim().length;
  return n > 0 && n <= GROUP_NAME_MAX;
};
