import { type Executor, eq, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { ValidationError } from "../errors";
import { requirePermission } from "../organizations";

const { organizationSettings } = schema;

/**
 * "Continuar com a chave de API quando todos os planos estiverem no limite": with every plan account of a run's order
 * at its limit, the run goes on with the workspace's API key instead of waiting for the first reset. Off by default,
 * since it turns flat-rate plans into spend by the token.
 */
export async function planKeyFallbackOn(db: Executor, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ on: organizationSettings.planKeyFallback })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, orgId));
  return row?.on === true;
}

/** `PUT …/ai-accounts/key-fallback` (admins, `configure`). Audited as `ai.key_fallback`. */
export async function setPlanKeyFallback(db: Executor, userId: string, orgId: string, on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") throw new ValidationError("on is true or false", "ai.invalid_key_fallback");
  await requirePermission(db, userId, orgId, "configure");
  if ((await planKeyFallbackOn(db, orgId)) === on) return on;
  await db
    .insert(organizationSettings)
    .values({ orgId, planKeyFallback: on })
    .onConflictDoUpdate({ target: organizationSettings.orgId, set: { planKeyFallback: on } });
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "ai.key_fallback",
    target: { type: "organization", id: orgId },
    details: { on },
  });
  return on;
}

/**
 * The order across CLIs (ADR 0041 §6, amended 2026-11-26): at a plan's limit with no next account of its CLI, a run
 * goes on with the next account of another CLI on the same computer, in one order per computer, each account on the
 * model chosen for it there. Off by default: the other CLIs think differently and some plans' terms are stricter.
 */
export async function planCrossProviderOn(db: Executor, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ on: organizationSettings.planCrossProvider })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, orgId));
  return row?.on === true;
}

/** `PUT …/ai-accounts/cross-provider` (admins, `configure`). Audited as `ai.cross_provider`. */
export async function setPlanCrossProvider(db: Executor, userId: string, orgId: string, on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") throw new ValidationError("on is true or false", "ai.invalid_cross_provider");
  await requirePermission(db, userId, orgId, "configure");
  if ((await planCrossProviderOn(db, orgId)) === on) return on;
  await db
    .insert(organizationSettings)
    .values({ orgId, planCrossProvider: on })
    .onConflictDoUpdate({ target: organizationSettings.orgId, set: { planCrossProvider: on } });
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "ai.cross_provider",
    target: { type: "organization", id: orgId },
    details: { on },
  });
  return on;
}
