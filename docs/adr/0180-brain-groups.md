# 0180. Brain groups: an agent moves between the accounts its owner grouped, one per provider

- Status: Proposed
- Date: 2026-11-13
- Amends: ADR 0041 (an agent may move between the accounts of a group its owner made, one per provider), ADR 0059
  (several seats: still never two accounts of one provider in a group)

## Context

An agent thinks with one account of a computer (`agents.brain_account_id`, ADR 0041). When that account reaches its
plan limit the turn stops, and the agent waits for the window to reset or falls back to the workspace's key
(`brainFallback`). People who connected a Claude plan and a ChatGPT plan to the same computer still have to move each
agent by hand when one runs out, even though the other has room.

ADR 0041 says an agent "never moves to another account by itself" and ADR 0059 calls several seats of one person a gray
area. Both rule out one thing: rotating subscriptions to get around a provider's limits. They don't rule out an owner
saying "this agent may think with my Claude plan or my ChatGPT plan, whichever has room". The right hand already does
a version of this: `withPersonalBrain` in `packages/engine/src/right-hand.ts` and `servingPlanFor` pick among the
signed-in plans that serve a person.

## Decision

### 1. A group belongs to one computer

`brain_groups` has `org_id`, `machine_id`, a name and its members. A member is an account of that computer. The
account of a turn must be on the agent's computer (`brainAccountFor` checks it) and the runner's frame is per
computer, so a group of the workspace filtered later would only hide the same constraint. An agent with a group must
be on the group's computer; moving it to another computer turns the group off, as `brainAccountId` is already cleared.

### 2. One account per provider

A group holds at most one account per provider. The key is `coalesce(provider, kind)` with a unique index, and a
second Claude subscription is refused with a message saying so. This is the line ADR 0041 §6 and ADR 0059 ("Several
seats") draw: rotating several subscriptions of one provider is the way to get around that provider's limits, and it
can break its terms. A group is a choice between providers (Claude or ChatGPT), each with its own plan and its own
limits. It never makes one provider's limit larger.

### 3. Who may be a member

An account that is `shared` (its sign-in thinks for all the owner's agents), `active`, and usable by this agent
(`planIsOwners`: it serves everyone, or it is the agent's owner's). `SHARED_SIGN_INS` is true for Claude Code, Codex,
Antigravity and keys, so in system mode this covers the real case, and the rules of one login per agent
(`account.in_use`, `moveAccount`) never come into it. Who creates and edits a group is who manages the computer's
accounts, as for an agent's account (ADR 0041 §4).

### 4. Strategy

`order` (the default): the first member that isn't at its limit. `room`: the member with the most room left in its
tightest window (`planRoom` in `machine-accounts.ts`, the measure `servingPlanFor` already uses).

### 5. A conversation sticks to its member

The member of the conversation's last run is preferred while it isn't at its limit. Without this, `room` would change
provider every turn when two members use about the same, and each change loses the CLI's session.

### 6. The group sits over the agent's brain

`agents.brain_group_id` overrides the agent's `brain*` fields without erasing them. `resolveBrain` reads the group
first and takes the member's account, brain and model; with no group, or a group with nothing usable, the fields are
read as before. Removing the group puts the old settings back.

### 7. A group that is used up behaves as today

When every member is at its limit, a run someone is waiting for falls back as it does now (`brainFallback`, guarded by
`mayFallBack`), and a background run waits for the nearest `resetsAt` among the members, not the first one's. An
account removed or signed out is skipped, and the next member answers; the agent only gets "no AI" when no member is
left. Fallback for unattended work stays refused (ADR 0053): a background run doesn't fall back to another brain.

### 8. A turn cut by the limit is not moved

A turn that hits `plan_limit` midway parks as today. The next turn picks another member. Moving the same turn would
redo tools that already ran, which the executor avoids on purpose.

### 9. The right hand is out for now

The right hand keeps `servingPlanFor` and its own rules (ADR 0137). Groups are for agents.

### 10. Model and effort belong to the member

Each member has its own `model` (null means `auto`) and effort. Models don't carry between providers, so a group
can't have one.

## Consequences

- An owner who connected Claude and ChatGPT gets an agent that goes on when one is at its limit, without any
  account being used by more than its owner allowed and without two plans of one provider ever working together.
- A migration (`brain_groups`, its members, `agents.brain_group_id`), an engine resolver, an agents page to make a group
  and set it on an agent. All text goes through `packages/i18n`.
- The resolver adds one more thing to read per turn; a conversation's last member comes from its previous run.
- Not now:
  - Switching the member in the middle of a turn.
  - Fallback for unattended work: it needs ADR 0053's rule changed.
  - The right hand.
