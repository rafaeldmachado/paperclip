# Learnings

## Codebase Patterns

- `server/src/services/chat-github-tools.ts`: test whether a guest source applies before invoking strict chat provenance; a provider-specific discovery probe runs for unrelated connections too.

## Testing Notes

- `server/src/__tests__/helpers/tool-gateway-listing-fixture.ts`: use a run-scoped gateway with real PostgreSQL for delegation regressions; catalog presence alone does not prove HTTP discovery or execution works.

## Configuration & Environments

- `Dockerfile` and `server/scripts/bundle-runtime.mjs`: production starts the bundled runtime; replacing a loose compiled service requires rebuilding that bundle to affect the server.

## Gotchas

- `server/src/services/chat-channels/run-origin.ts`: returning null after a provenance failure can remove guest restrictions; retain fail-closed behavior for actual guest-sponsored tasks.

## Dependency Map

- `tool-gateway.ts` → `chat-github-tools.ts` → `chat-channels/run-origin.ts`: the guest probe precedes connection catalog construction, so its exception can suppress every provider.
