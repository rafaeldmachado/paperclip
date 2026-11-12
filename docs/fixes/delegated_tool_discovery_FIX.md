# Delegated connection tool discovery

- Status: Done (scoped fix; existing baseline CI failure recorded below)
- Last Update: 2026-11-12T02:09:57Z
- Related: [upstream #20304](https://github.com/paperclipai/paperclip/issues/20304), [#17340](https://github.com/paperclipai/paperclip/pull/17340), [#17827](https://github.com/paperclipai/paperclip/pull/17827); `server/src/services/chat-github-tools.ts`, `server/src/services/chat-github-tools.test.ts`, `Dockerfile.delegated-tools`.
- Delivery: [fork PR #1](https://github.com/rafaeldmachado/paperclip/pull/1), [complete CI partitions](https://github.com/rafaeldmachado/paperclip/actions/runs/43135689195), [controlled follow-ups](https://github.com/rafaeldmachado/paperclip/actions/runs/43137646546).

## User Problem

A parent agent can use a healthy company-installed connection. An agent assigned a child task sees that same connection as ready through `connections_search`, but receives no assigned connection tools. Delegation cannot proceed.

## Evidence

- The installed official release is `2026.1106.0`, revision `d69631b01b9c658f80bf8bed389863dce82643e1`.
- Read-only inspection found a healthy company-installed GitHub connection, an active user grant, 46 active catalog tools, and no GitHub chat endpoints.
- GBrain is also healthy and installed company-wide as `mcp_remote`, with an active organization grant and 85 active catalog tools. The affected child's gateway profile already includes all 85 GBrain tools and all 46 GitHub tools. It uses the same assigned-tool discovery path; the fix is not limited to GitHub provider tools. Live provider calls from a fresh delegated run remain a post-deployment check.
- The affected child log records assigned MCP server startup failure with HTTP 403. The parent's run does not have that startup failure.
- Calling the unmodified `githubGuestBotConnectionForSession` against the saved production run context reproduces `403: Chat tools cannot be inherited by another task`; the corresponding parent context returns `null`. No agent was woken and no provider operation was requested.
- The regression suite fails on the unchanged release: six failures, including a real HTTP `tools/list` request returning 403. Four security/ordinary sponsor cases already pass.

## Scope

Ordinary delegated or reassigned tasks on the pinned release. The failure precedes provider access and can hide every assigned connector, including GitHub and remote MCP memory providers. This patch does not change actual GitHub guest task authority.

## Technical Problem

The gateway asks the GitHub chat service whether a run is guest-sponsored before it lists connections. That service walks cross-task/cross-agent identity ancestry even when no guest source exists on the task. The strict provenance helper rejects the unrelated ancestry. A plain HTTP error escapes before the tool discovery audit is written, explaining the missing denial audit and absent tools.

## Options and problems

1. **Catch all provenance errors and return null:** rejected. A real guest could be treated as an ordinary owner-sponsored run and gain access to personal connections.
2. **Community catch only when the company has no GitHub chat endpoint:** narrowly safe for this installation, but leaves ordinary delegation broken as soon as any unrelated GitHub chat endpoint exists. It also hides the original error instead of avoiding an inapplicable lookup.
3. **Broader #17827:** not selected. It changes the shared ancestry traversal, introduces cross-task re-entry and legacy wake-comment handling, and affects a security-sensitive helper with several consumers. Early reviews identified cross-agent and legacy-guest fail-open defects; later commits addressed them. Even corrected, this is unnecessary scope for the observed ordinary delegation failure.
4. **Backport merged #17340:** selected. Determine whether this task and assigned agent have a guest delivery before walking provenance. The final lookup uses the same bounded query. No guest source means no applicable guest restriction. A possible guest source still requires the existing strict provenance checks.

## Solution

Backport the service change from upstream commit `ee29e2850d0edc6cf11be9a8166a7829bce9c311` onto the exact deployed revision. The only additional runtime difference is an explicit `commentId !== undefined` condition: an empty legacy identifier must still constrain the final lookup rather than selecting any guest source. A real PostgreSQL test first reproduced the unsafe guest selection in the upstream patch, then verifies denial. Only one existing runtime source file changes. The shared `chat-channels/run-origin.ts`, tool gateway, adapters, credentials, grants, database and UI remain intact.

The new regression suite includes upstream sponsor tests plus:

- Unrelated task/agent guest deliveries and ordinary member deliveries do not block delegation.
- Real guest tasks still reject cross-agent and cross-task ancestry.
- A run-scoped HTTP gateway lists and calls a fixture tool after another agent delegates from another task.
- Revoking the tool policy still hides it and rejects execution without dispatching a provider call.
- An empty legacy source cannot borrow an unrelated guest sponsor.

The optional derived Docker image starts from the exact official digest, compiles just this service with the existing esbuild dependency, then rebuilds the existing runtime bundle. No package installation, migration, UI build or CLI upgrade occurs in that image. Updating only the loose `dist` file would leave the actual production bundle unchanged.

## Validation and rollback

Verified:

- Targeted delegation, strict provenance, HTTP discovery and grant resolution: 32/32 tests pass, no skips.
- Final GitHub, gateway and grant security checks, including the legacy hardening: 488/488 tests across 15 suites pass without skips. The malformed-legacy check also passes against the original stable source, confirming that the hardening preserves its denial behavior.
- Server typecheck and build pass. Full workspace `pnpm -r typecheck` and `pnpm build` pass.
- The runtime change is merged upstream #17340 plus one explicit optional-argument condition that preserves strict source matching for malformed legacy input.
- The derived image builds. Its saved-production-context probe runs in a read-only transaction: the formerly failing child returns null and the parent still returns null. Production is not restarted.
- `bash scripts/verify-delegated-tools-image.sh IMAGE` boots the actual production bundle against a disposable PostgreSQL container. The official image fails HTTP discovery with the exact cross-task 403. The patched image returns 200 with the assigned tool, hides it after policy revocation and rejects a revoked call with 403. No provider operation is sent; no production volume or database is used by this image smoke test. Probe containers, volumes and network are removed on exit.
- The serial `pnpm test:run` attempt was stopped without a complete result after roughly 45 minutes. The checked-in timing manifest records 93.7 serial minutes for 873 older server suites alone. The manual fork-only workflow then exercised the existing complete server/chat/workspace/serialized partitions against production-code commit `2c93948cb198ae24096e284b14ad5c07c77e19dd`.
- Full CI recorded 42,034 passing tests and one failed assertion; raw skip counts also include intentional line/shard filters and platform/provider exclusions. Twenty-two jobs succeeded, including the matrix generator. Two jobs failed: the assertion below and a cold Cargo build exceeding the Dot Runner test hook's five-minute deadline.
- The controlled Rust follow-up prebuilt the same binary outside the hook. All 54 Dot Runner integration tests then passed. The follow-up workflow succeeded; this resolves the build-deadline failure without changing product code or test assertions.
- The remaining assertion in unchanged `server/src/services/native-runtime/runner-bridge-tools.test.ts:159` expects shell permission-denial exit code 1; Ubuntu's shell returns 2. The same unmodified assertion fails identically with the original stable runtime service and the patched one. Comparison logs are attached to the follow-up run. It is an existing baseline issue, deliberately left outside this one-service hotfix. **The complete repository suite is not claimed fully green.**

Initial verification failures, retained separately from the product fix:

- Native database tests initially skipped because dependency install scripts were disabled. The bundled macOS Postgres symlink hydration is an environment prerequisite, not a product code change. Subsequent tests ran without skips.
- The initial image recipe used a legacy TypeScript API absent in this release. The final recipe uses the image's existing esbuild transformer; the resulting runtime bundle was then exercised over HTTP.
- The first isolated server probe used local-trusted mode with a non-loopback bind. The probe now binds loopback explicitly. A later probe assumed the exposed tool name ended with the provider name; gateway names can be truncated and hashed. The final probe resolves the expected catalog entry by ID and checks that its exposed name appears in the HTTP response. Neither correction changed runtime source; the final unchanged-image comparison still fails with the original 403.

The branch is based on the deployed stable commit, not current upstream master. Before replacing the derived image with a future official release, run the delegation and malformed-legacy regressions plus the image verifier against it. Retire the backport once that release passes them; retain the one-condition legacy hardening if upstream still omits it. Roll back by restoring the original immutable image digest; there are no data changes to reverse. Keep actual guest chains fail-closed; broader guest-task delegation remains outside this hotfix.

Build with `docker build -f Dockerfile.delegated-tools --build-arg KELP_HOTFIX_COMMIT=$(git rev-parse HEAD) -t kelp/paperclip:delegated-tools .`; run the isolated image verifier before choosing a production image. The fork's inherited workflows stay disabled; only the new manual read-only verifier is enabled, with no release or deployment permissions.

After deployment, retry the blocked child in a fresh runtime session and confirm that GitHub repository reads and GBrain search are actually present and callable. Do not create another connection or repeat existing approvals. A saved failed session may retain its failed MCP initialization.

Production has not been changed or restarted. The server has a tested local image `kelp/paperclip:2026.1106.0-kelp.2`, image ID `sha256:dd8f15596e20361c3a9a0212d5393d2ef36c4f689f18121c01fe42df4c866e10`, labelled with the tested production-code commit. Deployment still requires a persistent pi-server configuration change so its normal deploy workflow cannot restore the original image on the next deployment.

## Quality checklist

- [x] Minimal runtime source change and upstream attribution.
- [x] No schema, dependency or permission expansion.
- [x] Reproduced failure before changing source.
- [x] Targeted tests pass without skipped database tests.
- [x] Typecheck and build pass.
- [x] Full repository verification recorded, including original failures and controlled comparisons.
- [ ] All repository tests pass: one unchanged Linux sandbox assertion remains a confirmed baseline failure.
- [x] Derived image and saved-run read-only probe checked.
- [x] User retry guidance provided.
