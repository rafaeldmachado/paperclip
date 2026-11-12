#!/usr/bin/env bash
# Verify the production bundle over HTTP with disposable data and no provider calls.
set -euo pipefail
task_image=${1:?Usage: bash scripts/verify-delegated-tools-image.sh IMAGE}
task_name="paperclip-delegation-probe-$$"
task_db="$task_name-db"
task_app="$task_name-app"
cleanup() {
  docker rm -fv "$task_app" "$task_db" >/dev/null 2>&1 || true
  docker network rm "$task_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create "$task_name" >/dev/null
docker run -d --name "$task_db" --network "$task_name" --network-alias db \
  -e POSTGRES_USER=paperclip -e POSTGRES_DB=paperclip -e POSTGRES_PASSWORD=probe-only \
  postgres:17-alpine >/dev/null
for task_attempt in {1..60}; do
  if docker exec "$task_db" pg_isready -U paperclip -d paperclip >/dev/null 2>&1; then break; fi
  sleep 1
done
docker run -d --name "$task_app" --network "$task_name" \
  --tmpfs /paperclip:rw,uid=1000,gid=1000 --tmpfs /tmp \
  -e DATABASE_URL=postgres://paperclip:probe-only@db:5432/paperclip \
  -e HOST=127.0.0.1 \
  -e PAPERCLIP_DEPLOYMENT_MODE=local_trusted -e PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  -e PAPERCLIP_MIGRATION_AUTO_APPLY=true -e PAPERCLIP_TELEMETRY_DISABLED=1 \
  -e PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=disposable-image-verification-only \
  -e SERVE_UI=false "$task_image" >/dev/null
task_ready=false
for task_attempt in {1..90}; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$task_app")" != true ]; then break; fi
  if docker exec "$task_app" node -e 'fetch("http://127.0.0.1:3100/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
    task_ready=true
    break
  fi
  sleep 1
done
if [ "$task_ready" != true ]; then
  docker logs --tail 30 "$task_app" >&2
  exit 1
fi
docker exec -i -w /app/server "$task_app" node --import ./node_modules/tsx/dist/loader.mjs --input-type=module <<'JS'
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { agents, connectionGrants, createDb, heartbeatRuns, issues, runIdentityContexts, toolPolicies } from "@paperclipai/db";
import { createListingFixture } from "./src/__tests__/helpers/tool-gateway-listing-fixture.ts";
import { createToolGatewayService } from "./src/services/tool-gateway.ts";

const db = createDb(process.env.DATABASE_URL);
const f = await createListingFixture(db, 6);
await db.insert(connectionGrants).values({ companyId: f.company.id, connectionId: f.connection.id,
  kind: "organization", status: "active", isDefault: true });
const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: "Parent", role: "cto", adapterType: "codex_local" }).returning();
const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Parent task", assigneeAgentId: agent.id }).returning();
const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id, issueId: issue.id, status: "succeeded" }).returning();
const [parent] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: run.id, revision: 1, cause: "issue_assigned", correlationId: "probe" }).returning();
const [child] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: f.run.id, revision: 1, parentContextId: parent.id, cause: "issue_assigned", correlationId: "probe" }).returning();
await db.update(heartbeatRuns).set({ activeIdentityContextId: child.id }).where(eq(heartbeatRuns.id, f.run.id));
const post = (method, params) => fetch(`http://127.0.0.1:3100/mcp/gateways/${f.namedGateway.gatewayPublicId}`, {
  method: "POST", headers: { authorization: `Bearer ${f.token.token}`, "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
});
const response = await post("tools/list");
const body = await response.json();
assert.equal(response.status, 200, JSON.stringify(body));
const descriptors = await createToolGatewayService(db).listToolsForNamedGateway({ gatewayId: f.namedGateway.id, bearerToken: f.token.token });
const expected = descriptors.find(t => t.catalogEntryId === f.entries[4].id);
assert.ok(expected, "The delegated run must receive its assigned read tool");
const tool = body.result.tools.find(t => t.name === expected.name);
assert.ok(tool, "The production bundle must expose the same assigned tool");
await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Revoke probe read", policyType: "block", priority: 0,
  selectors: { catalogEntryId: f.entries[4].id } });
const denied = await post("tools/call", { name: tool.name, arguments: {} });
assert.equal(denied.status, 403, "Policy must reject execution before provider dispatch");
const refreshed = await post("tools/list");
assert.equal(refreshed.status, 200);
assert.equal((await refreshed.json()).result.tools.some(t => t.name === tool.name), false);
console.log(JSON.stringify({ discovery: 200, assignedToolPresent: true, revokedCall: 403, revokedToolHidden: true }));
process.exit(0);
JS
