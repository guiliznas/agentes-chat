import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { machineAccounts, machines } from "./machines";
import { organizations } from "./tenancy";

/** The longest a brain group's name may be (ADR 0180). */
export const BRAIN_GROUP_NAME_MAX = 40;

/**
 * A named set of one computer's accounts that think together (ADR 0180): an agent points at one instead of at a
 * single account, and the group's `strategy` says how its members take turns (`order`: the first that can answer;
 * `room`: the member with the most room left). It lives on one computer, so it goes with it.
 */
export const brainGroups = pgTable(
  "brain_groups",
  {
    id: uuid()
      .notNull()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: uuid().notNull(),
    /** What people call it, 1 to 40 characters (the engine validates it too). */
    name: text().notNull(),
    /** `order` or `room` (ADR 0180). */
    strategy: text().notNull().default("order"),
    createdBy: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.id] }),
    foreignKey({ columns: [t.orgId, t.machineId], foreignColumns: [machines.orgId, machines.id] }).onDelete("cascade"),
    index().on(t.orgId, t.machineId),
    check("brain_groups_strategy", sql`${t.strategy} in ('order', 'room')`),
    check(
      "brain_groups_name_length",
      sql`char_length(${t.name}) between 1 and ${sql.raw(String(BRAIN_GROUP_NAME_MAX))}`,
    ),
  ],
);

/**
 * One account in a brain group (ADR 0180), at `position` in its order. A group holds one account per provider:
 * `providerKey` is `coalesce(provider, kind)` of the account, written by the engine when it adds the member.
 * `model` and `effort` are the member's own choice: a null model is Automático, a null effort the CLI's default (never
 * the agent's own, which stays saved under the group).
 */
export const brainGroupMembers = pgTable(
  "brain_group_members",
  {
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    groupId: uuid().notNull(),
    accountId: uuid().notNull(),
    position: integer().notNull(),
    providerKey: text().notNull(),
    model: text(),
    effort: text(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.groupId, t.accountId] }),
    foreignKey({ columns: [t.orgId, t.groupId], foreignColumns: [brainGroups.orgId, brainGroups.id] }).onDelete(
      "cascade",
    ),
    foreignKey({
      columns: [t.orgId, t.accountId],
      foreignColumns: [machineAccounts.orgId, machineAccounts.id],
    }).onDelete("cascade"),
    unique("brain_group_members_position").on(t.orgId, t.groupId, t.position),
    unique("brain_group_members_provider").on(t.orgId, t.groupId, t.providerKey),
    index().on(t.orgId, t.accountId),
  ],
);
