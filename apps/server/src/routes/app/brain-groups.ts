import {
  createBrainGroup,
  deleteBrainGroup,
  listBrainGroups,
  publishAgentsChanged,
  publishMachineAgentsChanged,
  updateBrainGroup,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";
import { BrainGroup, BrainGroupStrategy } from "./schemas";

const tags = ["Brain groups"];

const GroupParams = OrgParams.extend({ groupId: z.uuid() });

const Member = z.object({
  accountId: z.uuid(),
  model: z.string().max(80).nullable().optional().openapi({ description: "Null or omitted = the agent's model." }),
  effort: z.string().max(20).nullable().optional().openapi({ description: "Null or omitted = the agent's effort." }),
});

const Members = z.array(Member).max(20).openapi({
  description:
    "The complete ordered list: the position is the index. Accounts that are shared, active, on the group's computer and serving the caller (`brain_group.not_shared`, `brain_group.not_yours`, `brain_group.other_computer`); one per provider (`brain_group.same_provider`, 409).",
});

/**
 * Brain groups (ADR 0180): at most one account per provider on one computer, which an agent can think with. Anyone
 * in the workspace sees them; who made one, or an admin, changes it. Session + CSRF like the rest of `/api/app`.
 */
export function brainGroupRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  // The computers hear a group's members with the agents that use it; the open apps read the agents again (what a
  // group's agents show and think with changes with it).
  const changed = async (orgId: string) => {
    await publishMachineAgentsChanged(deps.adapters.pubsub, orgId);
    await publishAgentsChanged(deps.adapters.pubsub, orgId);
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/brain-groups",
      tags,
      security,
      summary: "The workspace's brain groups, oldest first",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ groups: z.array(BrainGroup) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ groups: await listBrainGroups(db, c.get("user").id, orgId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/brain-groups",
      tags,
      security,
      summary: "Make a group on one computer from accounts that serve the caller (audited)",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            machineId: z.uuid(),
            name: z.string().max(80),
            strategy: BrainGroupStrategy.optional().openapi({ description: "Omitted = `order`." }),
            members: Members,
          }),
        ),
      },
      responses: { 201: json(BrainGroup, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const input = c.req.valid("json");
      const group = await createBrainGroup(db, c.get("user").id, orgId, input);
      await changed(orgId);
      return c.json(group, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/brain-groups/{groupId}",
      tags,
      security,
      summary: "Change a group's name, strategy and/or members (who made it or an admin; audited)",
      request: {
        params: GroupParams,
        body: body(
          z.object({
            name: z.string().max(80).optional(),
            strategy: BrainGroupStrategy.optional(),
            members: Members.optional().openapi({ description: "Omitted = keep; given, it replaces them all." }),
          }),
        ),
      },
      responses: { 200: json(BrainGroup), ...errors },
    }),
    async (c) => {
      const { orgId, groupId } = c.req.valid("param");
      const input = c.req.valid("json");
      const group = await updateBrainGroup(db, c.get("user").id, orgId, groupId, input);
      await changed(orgId);
      return c.json(group, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/brain-groups/{groupId}",
      tags,
      security,
      summary: "Delete a group; the agents that used it think with their own account again (who made it or an admin)",
      request: { params: GroupParams },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, groupId } = c.req.valid("param");
      await deleteBrainGroup(db, c.get("user").id, orgId, groupId);
      await changed(orgId);
      return c.body(null, 204);
    },
  );

  return app;
}
