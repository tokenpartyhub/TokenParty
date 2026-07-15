# Changelog

All notable changes to TokenParty are documented here.

## [Unreleased]

## [0.0.33] - 2026-07-15

### Fixed
- Dashboard request detail now normalises the request body across all
  three entry protocols (Chat Completions / Anthropic Messages / Codex
  Responses). Previously the **Messages** tab read `body.messages`
  only, so Codex requests (which use `body.input` + `body.instructions`)
  showed `Messages (0)` and an empty panel. The tab now reads the
  unified `getReqMessages()` output; the **System** tab also activates
  for `body.instructions` so the operator can see the Codex system
  prompt.
- Agent-adapter views (`ToolSummary`, `ConversationFlow`, diagnostics,
  and the shared "Tool Summary" / "Flow" section detection) go through
  the same normaliser, so those panels no longer render empty for
  Codex requests.
- `MessageItem` role colors include a `reasoning` variant so prior
  reasoning traces (when present in `input`) get their own slate
  chip instead of falling back to the generic gray.

## [0.0.32] - 2026-07-15

### Changed
- Forwarder fallback policy: **all** non-2xx responses now fall through to
  the next candidate provider, not just 429 / 5xx. Previously a 401 /
  403 / 400 from one provider would be returned to the client
  immediately; the gateway now gives the remaining candidates a chance
  (e.g. the same model served by a different key).
- When every candidate fails, the gateway **echoes the last upstream's
  status and body verbatim** instead of rewriting them to a generic
  `502 {"error":"All provider candidates failed"}`. Clients (codex,
  SDKs) now see the provider's real error message — quota exhausted,
  auth failure, malformed request, etc. — so they can decide what to
  do next without the operator digging through JSONL logs.
- Network-layer failures (fetch threw / upstream timeout / client
  disconnect) — i.e. cases with **no upstream body to echo** — are
  distinguished by returning **504** (instead of 502) with a synthetic
  `{error: "<reason>"}` body (`upstream_timeout` / `client_disconnect`
  / the fetch error message).

### Added
- `RouteTraceEntry.errorBody` field: every failed attempt carries the
  raw upstream error payload, surfaced in the dashboard's request
  detail view so the operator can see *why* each provider failed
  without opening the JSONL log.
- `readErrorBody()` helper: drains a streaming upstream error response
  (with gzip / deflate / br / zstd decompression) so the streaming
  path preserves the provider's error payload just like the
  non-streaming path.
- Two new integration tests: *echoes upstream status+body verbatim when
  it is the last candidate*; *returns the last upstream error
  verbatim when all candidates fail*.

### Fixed
- Non-streaming failure path no longer calls `response.body.cancel()`
  after `.text()` — on Node's undici the cancel throws
  `ReadableStream is locked`, which the outer catch previously caught
  and rewrote the upstream's real error into a synthetic
  `network_error`. Removed the redundant cancel so the provider's
  message reaches the client.
- Abort-aware error bodies: fetch / http.request AbortError now reads
  the real cause from `signal.reason` (`upstream_timeout` /
  `client_disconnect`) instead of masking it as "The operation was
  aborted" / "socket hang up".

## [0.0.25] - 2026-07-09

### Fixed
- Hung upstream requests no longer keep the proxy waiting for tens
  of minutes. The forwarder now bounds each upstream call to
  `server.upstreamTimeoutMs` (default 30s) for non-streaming and
  `server.streamingUpstreamTimeoutMs` (default 5min) for streaming;
  on expiry the upstream socket is destroyed and the request is
  recorded as a 502 with reason `upstream_timeout`.
- When the client (openclaw / claude-code / etc.) disconnects
  mid-stream, the upstream request is aborted immediately and the
  reason `client_disconnect` is recorded, so a hung downstream
  client no longer holds a live upstream connection for the full
  upstream timeout.

### Added
- `server.upstreamTimeoutMs` and `server.streamingUpstreamTimeoutMs`
  config fields.
- Integration tests: upstream timeout returns 502 within the
  timeout window; client abort closes the upstream socket.

## [0.0.24] - 2026-07-09

### Fixed
- Routes no longer pass the request body as the 4th positional
  argument to `forwardRequest` (which after the 0.0.22 signature
  reduction was bound to `_routeTrace`). Surfaced as
  `TypeError: routeTrace.push is not a function` on the first
  retryable attempt of any Anthropic / OpenAI request.
- Route handlers pick the first candidate whose provider.type
  matches the entry protocol, instead of just `providers[0]`.
  Same model served by both anthropic- and openai-type providers
  (priority 999 vs no-priority) was being rejected because the
  router-sorted top provider didn't match the entry. The picked
  provider becomes the fallback-chain head so retry semantics
  remain intact.
- Cross-protocol rejection message direction: when only an
  anthropic-type candidate exists and the user hits `/v1`, the
  error now recommends `/anthropic` (the matching entry), not the
  entry the user is currently on.

### Added
- `packages/proxy/src/proxy/route-picker.ts`: shared
  `pickProviderForEntry` helper used by both routes.
- `packages/proxy/src/config.ts`: `_setConfigForTest` test hook.
- `packages/proxy/test/`: integration test suite using `node:test`.
  Three files, 24 tests total:
    - `route-picker.test.ts` (8) — pick-by-entry semantics
    - `router.test.ts` (4) — resolveProvider priority + model listing
    - `integration.test.ts` (12) — real Hono `app.request()` against
      a mock upstream HTTP server covering auth, success, retryable
      fallback, all-failed 502, cross-protocol rejection, models list
  Run with `pnpm --filter @tokenparty/tokenparty test`.

## [0.0.23] - 2026-07-08

### Fixed
- Dashboard Model Routing view no longer suggests cross-protocol
  fallback that cannot actually happen. After 0.0.22, same model
  across different provider types has independent fallback chains
  (one per entry protocol), so the view now groups by
  `(modelId, protocol)`. Each row shows the protocol, model id,
  and matching entry endpoint path. Models with both
  type=anthropic and type=openai providers render as two
  distinct rows instead of one misleading chain.
- The "model routing" page header note now explains the protocol
  scoping instead of implying protocol-agnostic fallback.

## [0.0.22] - 2026-07-08

### ⚠️ BREAKING CHANGES

- Cross-protocol routing is **no longer supported**. The proxy no
  longer converts between Anthropic and OpenAI wire formats. Each
  entry endpoint only forwards to upstream providers that match its
  protocol:
    `/v1/chat/completions`, `/v1/responses`, `/v1/models`  → type=openai providers only
    `/anthropic/v1/messages`, `/anthropic/v1/models`        → type=anthropic providers only

### Removed
- `POST /v1/messages` route (was the OpenAI-format sibling of
  `/anthropic/v1/messages`; cross-protocol auto-detect).
- `POST /anthropic/messages` and `POST /anthropic/chat/completions`
  routes (cross-protocol aliases).
- `packages/proxy/src/adapters/` directory
  (`anthropic-to-openai.ts`, `openai-to-anthropic.ts`) and the
  in-line `OpenaiToAnthropicStreamConverter` + `convertAnthropicChunkToOpenai`
  helpers in `forwarder.ts`. Path-conversion bugs (e.g. fallback
  producing `/v1/v1/messages`) are no longer possible because
  cross-protocol itself is gone.
- Model-name auto-detection in route handlers: `claude-*` / `gpt-*`
  sniffing that inferred protocol from the body shape. Use the
  matching-protocol entry endpoint instead.
- `forwardRequest`'s `entryProtocol` parameter and the
  `needsStreamConversion` parameter on `attemptProvider`.

### Preserved
- Same-protocol multi-provider fallback chain (priority order,
  retry on 429/5xx/network error). `forwardRequest` still iterates
  candidate providers per call.
- Per-attempt request/response logs, TTFT/duration tracking,
  time-range row display, all per-hop "Copy cURL" buttons.

## [0.0.21] - 2026-07-08

### Added
- TTFT (Time To First Token) tracking. Each upstream hop now records
  `request_index.ttft_ms` — wall-clock from request entry to first
  byte received from upstream. For streaming responses, the actual
  perceived latency is reported (not the stream-drain duration).
  Schema is auto-migrated on first startup; old rows default to 0
  and render as "—" in the dashboard.

### Changed
- Requests list shows a time RANGE (start → end) per row instead of
  a single timestamp. Format collapses redundant parts when the row
  stays inside the same day / month / year:
    same day       → "16:36:04-16:36:20"
    same month     → "Jul 8, 16:36:04 - Jul 9, 16:36:20"
    cross year     → "Dec 31 2025, 16:36:04 - Jan 1 2026, 16:36:20"
- Requests table column order: Time, **Duration**, **TTFT**, User,
  Model, Tokens, Cost, Status, Agent, Tags. The "Latency" column is
  renamed and split into Duration (total wall-clock, includes
  streaming) and TTFT (true first-byte latency).
- All numeric durations are formatted in seconds (e.g. "0.3s",
  "33.9s", "2m15s") with the raw ms available on hover.
- Table font sizes normalized to a single `text-sm` baseline; removed
  the previous `text-xs` overrides on User / Cost / Tags cells that
  fought with the table size.
- `request_index.timestamp` now stores the wall-clock time the
  request entered `forwardRequest` (start time), not the time
  `recordRequest` was called (which could be much later for long
  streams). Long streams that previously appeared out of order
  relative to child-agent calls now sort by their true start time.

### Fixed
- Dashboard request detail page Response panel went blank after 0.0.20.
  The forwarder renamed its single outbound log entry from `response`
  to per-attempt `attempt_response` entries, but the detail panel
  derived `resLog` from `type === "response"` only — so for
  successful requests the lookup returned undefined and the whole
  Response tab (headers/content/SSE events/raw, error banner, agent
  adapter sections) disappeared. Derive `resLog` as: prefer the
  last `type: "response"` entry (old logs / "all candidates failed"
  502) or fall back to the last `attempt_response` entry (per-hop
  upstream response in 0.0.20+).

## [0.0.20] - 2026-07-03

### Added
- Per-attempt request/response logging and replayable cURL in the
  request detail page. Each upstream hop is now persisted as
  `attempt_request` / `attempt_response` entries in the request JSONL
  with the exact `targetUrl`, headers (including the real api key), and
  body sent, plus the upstream status and body received. The dashboard
  request detail page renders one card per attempt — green for the
  hop that ultimately answered, gray for retryable failures — each
  with a "Copy cURL" button that replays that exact attempt.
- The previous "Client → TokenParty → upstream" one-line route trace
  is preserved at the top; the new `Attempts` section sits below it.

## [0.0.19] - 2026-07-02

### Fixed
- `recordRequest` for `request_index` used `INSERT` instead of `INSERT OR
  REPLACE`, so the second attempt in a fallback chain (sharing the
  same requestId as the first) raised a UNIQUE constraint error. That
  error was caught by `attemptProvider`'s outer try/catch and converted
  into a retryable 502, masking the successful fallback attempt.
  Symptom: dashboard shows a single 429 entry for a request where the
  proxy log clearly shows a fallback to another provider succeeded.

## [0.0.18] - 2026-07-02

### Fixed
- `tokenparty restart` command entered an infinite respawn loop because
  `daemonStart` filtered the literal `"start"` from child argv but not
  `"restart"`, so the spawned child re-entered the restart branch.
- `POST /api/restart` left the PID file stale (parent's old PID) so
  subsequent `tokenparty stop`/`status` targeted a dead process; the
  endpoint now refreshes the PID file with the new child's PID and
  detaches stdio so the parent's exit doesn't strand the child's
  output.
- Dashboard favicon (`/favicon.png`, `/favicon-64.png`) was served as
  `index.html` because only `/assets/*` had a static route and the
  catch-all swallowed every other path; added explicit serveStatic
  routes for the favicons ahead of the SPA catch-all.

## [0.0.17] - 2026-06-29

### Added
- T favicon with transparent background and warm amber gradient
- GitHub organization migration to `tokenpartyhub`

### Changed
- Updated all GitHub references from `Jasonbroker/TokenParty` to `tokenpartyhub/TokenParty`

## [0.0.16] - 2026-06-29

### Changed
- Renamed npm package from `@zhouzhengchang/token-party` to `@tokenparty/tokenparty`
- Updated all documentation references to new package name

## [0.0.15] - 2026-06-29

### Fixed
- Dashboard request filters, date filter bug, validation, and URL state
- Copy buttons on the route trace requester side

## [0.0.14] - 2026-06-28

### Added
- Keep-alive connection pooling to prevent TIME_WAIT port exhaustion
- Upstream model auto-discovery — fetches available models from provider APIs

### Fixed
- Record real upstream status and faithful body in stream logs
- Return 404 for unknown GET routes to match upstream behavior

## [0.0.13] - 2026-06-28

### Added
- Model-level priority with ordered fallback chain across providers
- Model routing flow diagram visualization on Providers page
- Route trace tracking with cURL copy support
- 429 fallback support

### Fixed
- Deduplicate provider node in route trace display

## [0.0.12] - 2026-06-27

### Added
- OpenClaw agent detection and dashboard adapter
- AI agent detection for Claude Code

## [0.0.11] - 2026-06-27

### Added
- Unified USD cost storage with display currency conversion
- Per-request cost and cache token breakdown
- Multi-currency pricing with cache read/write tracking
- Cached input token tracking and pricing

## [0.0.10] - 2026-06-26

### Added
- Drag-and-drop provider grouping UI
- Custom provider groups for key access control
- Usage quota per token with daily/monthly limits
- Provider fallback on 5xx or connection failure
- Dockerfile and docker-compose for container deployment
- Cost estimation with per-model pricing config

## [0.0.9] - 2026-06-25

### Added
- npm publish support with `~/.tokenparty` config
- Load balancing across multiple API keys
- Token `allowedProviders` grouping with `*` and `group:<type>`

## [0.0.8] - 2026-06-25

### Added
- Initial dashboard with overview, requests, providers, users, settings pages
- Cost analytics and request inspector
- Scoped API keys with provider-level access control
- OpenAI ↔ Anthropic bidirectional protocol translation
- Full SSE streaming with protocol conversion

## [0.0.1] - 2026-06-24

### Added
- Initial project scaffold
