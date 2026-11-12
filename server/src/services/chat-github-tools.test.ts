import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatMessageLinks,
  companies,
  connectionGrants,
  toolPolicies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  runIdentityContexts,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { githubGuestBotConnectionForSession } from "./chat-github-tools.js";
import { createToolGatewayService } from "./tool-gateway.js";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";
import { createListingFixture } from "../__tests__/helpers/tool-gateway-listing-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("GitHub guest bot connection discovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-github-guest-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Guest discovery", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [first, second] = await db.insert(agents).values([
      { companyId: company.id, name: "First agent", role: "general", adapterType: "codex_local" },
      { companyId: company.id, name: "Second agent", role: "general", adapterType: "codex_local" },
    ]).returning();
    const [issue, other] = await db.insert(issues).values([
      { companyId: company.id, title: "Reassigned task", assigneeAgentId: second.id },
      { companyId: company.id, title: "Other task", assigneeAgentId: second.id },
    ]).returning();
    return { company, first, second, issue, other };
  }

  async function continuation(f: Awaited<ReturnType<typeof fixture>>, parent: { agentId: string; issueId: string }) {
    const [source, continued] = await db.insert(heartbeatRuns).values([
      { companyId: f.company.id, agentId: parent.agentId, status: "succeeded", nativeIssueId: parent.issueId, contextSnapshot: {}, responsibleUserId: "requester" },
      { companyId: f.company.id, agentId: f.second.id, status: "running", nativeIssueId: f.issue.id, contextSnapshot: {}, responsibleUserId: "requester" },
    ]).returning();
    const [origin] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: source.id, revision: 1, responsibleUserId: "requester", cause: "dispatch", correlationId: "dispatch" }).returning();
    const [context] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: continued.id, revision: 1, responsibleUserId: "requester", parentContextId: origin.id, cause: "dispatch", correlationId: "dispatch" }).returning();
    await db.update(heartbeatRuns).set({ activeIdentityContextId: context.id }).where(eq(heartbeatRuns.id, continued.id));
    return { companyId: f.company.id, agentId: f.second.id, runId: continued.id, issueId: f.issue.id };
  }

  async function guestSource(f: Awaited<ReturnType<typeof fixture>>, guest: boolean) {
    const endpointId = randomUUID();
    const [application] = await db.insert(toolApplications).values({ companyId: f.company.id, applicationKey: `chat:github:${endpointId}`, name: `GitHub ${endpointId}`, type: "chat", status: "active" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.company.id, applicationId: application.id, name: "GitHub", uid: `chat-github-${endpointId}`, connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true }).returning();
    await db.insert(chatEndpoints).values({ id: endpointId, companyId: f.company.id, connectionId: connection.id, provider: "github", publicId: randomUUID(), assignedAgentId: f.second.id, status: "active" });
    const [conversation] = await db.insert(chatConversations).values({ companyId: f.company.id, endpointId, issueId: f.issue.id, externalConversationId: `github:owner/repo:${endpointId}`, externalLabel: "Guest thread" }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorType: "user", authorUserId: "requester", body: "Please review" }).returning();
    const [delivery] = await db.insert(chatDeliveries).values({ companyId: f.company.id, endpointId, conversationId: conversation.id, providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "message", normalizedEvent: { githubAuthority: { guest } }, state: "processed" }).returning();
    await db.insert(chatMessageLinks).values({ companyId: f.company.id, endpointId, conversationId: conversation.id, deliveryId: delivery.id, commentId: comment.id, providerMessageId: randomUUID(), direction: "inbound" });
    return { connectionId: connection.id, commentId: comment.id };
  }

  async function sponsoredRun(f: Awaited<ReturnType<typeof fixture>>, commentId: string) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.second.id, status: "running", nativeIssueId: f.issue.id, contextSnapshot: {}, responsibleUserId: "requester" }).returning();
    const [context] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: run.id, revision: 1, responsibleUserId: "requester", messageId: commentId, cause: "instruction", correlationId: "message" }).returning();
    await db.update(heartbeatRuns).set({ activeIdentityContextId: context.id }).where(eq(heartbeatRuns.id, run.id));
    return { companyId: f.company.id, agentId: f.second.id, runId: run.id, issueId: f.issue.id };
  }

  it.each(["agent", "task"])("finds no guest sponsor when the run chain continues another %s", async (fault) => {
    const f = await fixture();
    const session = await continuation(f, fault === "agent"
      ? { agentId: f.first.id, issueId: f.issue.id }
      : { agentId: f.second.id, issueId: f.other.id });
    expect(await githubGuestBotConnectionForSession(db, session)).toBeNull();
  });

  it.each(["agent", "task"])("still refuses a guest-sponsored task whose run chain continues another %s", async fault => {
    const f = await fixture();
    await guestSource(f, true);
    const session = await continuation(f, fault === "agent"
      ? { agentId: f.first.id, issueId: f.issue.id }
      : { agentId: f.second.id, issueId: f.other.id });
    await expect(githubGuestBotConnectionForSession(db, session)).rejects.toMatchObject({ status: 403 });
  });

  it.each([true, false])("resolves the bot connection only for a run sponsored by a GitHub guest (guest=%s)", async (guest) => {
    const f = await fixture();
    const source = await guestSource(f, guest);
    const session = await sponsoredRun(f, source.commentId);
    expect(await githubGuestBotConnectionForSession(db, session)).toBe(guest ? source.connectionId : null);
  });

  it.each(["other-task", "other-agent", "member"])("ignores an unrelated %s GitHub chat source", async kind => {
    const f = await fixture();
    await guestSource(kind === "other-task" ? { ...f, issue: f.other }
      : kind === "other-agent" ? { ...f, second: f.first } : f, kind !== "member");
    const session = await continuation(f, { agentId: f.first.id, issueId: f.other.id });
    expect(await githubGuestBotConnectionForSession(db, session)).toBeNull();
  });

  it("lists and calls assigned tools over HTTP after delegation while retaining policy enforcement", async () => {
    const f = await createListingFixture(db, 6);
    await db.insert(connectionGrants).values({ companyId: f.company.id, connectionId: f.connection.id,
      kind: "organization", status: "active", isDefault: true });
    const [parentAgent] = await db.insert(agents).values({ companyId: f.company.id, name: "Orchestrator", role: "cto", adapterType: "codex_local" }).returning();
    const [parentIssue] = await db.insert(issues).values({ companyId: f.company.id, title: "Parent task", assigneeAgentId: parentAgent.id }).returning();
    const [parentRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: parentAgent.id, issueId: parentIssue.id, status: "succeeded" }).returning();
    const [parentContext] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: parentRun.id, revision: 1, cause: "issue_assigned", correlationId: "dispatch" }).returning();
    const [childContext] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: f.run.id, revision: 1, parentContextId: parentContext.id, cause: "issue_assigned", correlationId: "dispatch" }).returning();
    await db.update(heartbeatRuns).set({ activeIdentityContextId: childContext.id }).where(eq(heartbeatRuns.id, f.run.id));
    const calls: string[] = [];
    const gateway = createToolGatewayService(db, { remoteHttpRequest: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "tools/call") calls.push(body.params.name);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
        : { content: [{ type: "text", text: "fixture result" }] } }), { headers: { "content-type": "application/json" } });
    } });
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(gateway));
    const post = (method: string, params?: unknown) => request(app)
      .post(`/mcp/gateways/${f.namedGateway.gatewayPublicId}`)
      .set("Authorization", `Bearer ${f.token.token}`)
      .send({ jsonrpc: "2.0", id: 1, method, params });
    const listed = await post("tools/list");
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const descriptors = await gateway.listToolsForNamedGateway({ gatewayId: f.namedGateway.id, bearerToken: f.token.token });
    const read = descriptors.find(tool => tool.catalogEntryId === f.entries[4]!.id)!;
    expect(read).toBeDefined();
    expect(listed.body.result.tools.some((tool: { name: string }) => tool.name === read.name)).toBe(true);
    await post("tools/call", { name: read.name, arguments: {} }).expect(200);
    expect(calls).toEqual(["tool_0004"]);
    await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Revoke delegated read", policyType: "block", priority: 0,
      selectors: { catalogEntryId: f.entries[4]!.id } });
    await post("tools/call", { name: read.name, arguments: {} }).expect(403);
    expect(calls).toHaveLength(1);
    const after = await post("tools/list").expect(200);
    expect(after.body.result.tools.some((tool: { name: string }) => tool.name === read.name)).toBe(false);
  });

});
