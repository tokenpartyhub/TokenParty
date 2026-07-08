# Changelog

All notable changes to TokenParty are documented here.

## [Unreleased]

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
