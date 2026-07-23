# TokenParty — User Self-Service API

This document covers the HTTP endpoints TokenParty exposes under `/api/user/*` for **end users to query their own usage and request history**. Every endpoint is authenticated with the user's own `tp-...` token; users can only see their own data.

For admin-side endpoints (`/api/*`, requires admin token) — list providers, list keys, edit aliases, restart the daemon, etc. — see the corresponding sections of `README.md` and the inline JSDoc on `apiRoutes` in `packages/proxy/src/routes/api.ts`. (A separate `admin-api.md` reference is planned but not yet published.)

---

## Base URL & auth

```
http://<host>:<port>/api/user
```

Default port is `3456` (configurable via `server.port` in `~/.tokenparty/config.yaml`).

Every request must carry the user's token in the `Authorization` header:

```http
Authorization: Bearer tp-xxxxxxxxxxxxxxxx
```

If the token is missing, disabled, or unknown, the gateway returns:

```json
{ "error": "Unauthorized" }
```
```http
HTTP/1.1 401 Unauthorized
```

---

## Endpoints at a glance

| Endpoint | Purpose | Granularity |
|---|---|---|
| `GET /profile` | "I spent how much today / this month?" | Single object |
| `GET /stats?days=N` | Per-day breakdown for charts | One row per `(date, provider, model, agent)` |
| `GET /requests?...` | Recent requests log | One row per request, paginated |
| `GET /requests/:id` | Full detail of one request, including all upstream attempts | One request + JSONL log entries |

---

## `GET /api/user/profile`

Returns a single snapshot of the calling user's spend in the current day and current month. Designed for dashboard top-bar widgets ("$12.34 / $50 spent this month") and quick CLI checks.

### Request

```http
GET /api/user/profile HTTP/1.1
Authorization: Bearer tp-alice
```

### Response — `200 OK`

| Field | Type | Meaning |
|---|---|---|
| `name` | string | User's display name (from `config.yaml`) |
| `monthlyBudget` | number \| null | Configured monthly cap in USD. `null` = unlimited. |
| `monthlySpent` | number | Sum of `cost` across `usage_daily` rows from the 1st of the current month up to today, in USD. |
| `monthlyRequests` | number | Sum of `request_count` over the same range. |
| `monthlyInputTokens` | number | Sum of `input_tokens` over the same range. |
| `monthlyOutputTokens` | number | Sum of `output_tokens` over the same range. |
| `monthlyCacheReadTokens` | number | Sum of `cache_read_tokens` over the same range. Cache **hits** (billed at a discount). |
| `dailySpent` | number | Sum of `cost` for today (UTC date), in USD. |
| `dailyRequests` | number | Sum of `request_count` for today. |

### Example

```bash
curl http://localhost:3456/api/user/profile \
  -H "Authorization: Bearer tp-alice"
```

```json
{
  "name": "Alice",
  "monthlyBudget": 50,
  "monthlySpent": 12.34,
  "monthlyRequests": 842,
  "monthlyInputTokens": 1234567,
  "monthlyOutputTokens": 384921,
  "monthlyCacheReadTokens": 250000,
  "dailySpent": 0.82,
  "dailyRequests": 41
}
```

### Notes

- "Today" and "this month" are computed in **UTC**, matching how `usage_daily` buckets are written.
- `monthlySpent` is a snapshot of the running month only — to look at a past month, use `/stats?days=N` and filter by date client-side, or read directly from `~/.tokenparty/tokenparty.db` (the `usage_daily` table is **never** pruned).
- The endpoint does not enforce any rate limit; if you poll it, do so at a sane cadence (≤ once / minute).

---

## `GET /api/user/stats?days=N`

Returns the calling user's daily rollup rows, ordered by date descending. Each row is keyed by `(date, provider, model, agent)` — so a single day may return 5–20 rows if the user pinged several providers or models. Clients typically `GROUP BY date` and sum the metrics before plotting.

### Request

```http
GET /api/user/stats?days=30 HTTP/1.1
Authorization: Bearer tp-alice
```

| Query param | Type | Default | Notes |
|---|---|---|---|
| `days` | integer | `7` | Number of trailing days to return, inclusive of today. Larger values scan more of `usage_daily`; keep ≤ 90 for snappy responses. |

### Response — `200 OK`

Array of `UsageDailyRow` objects:

| Field | Type | Meaning |
|---|---|---|
| `date` | string (`YYYY-MM-DD`) | UTC date bucket. |
| `token_id` | string | The caller's token id (always equals the auth'd user). |
| `provider_id` | string | Provider that served the request (e.g. `anthropic-main`). |
| `model` | string | Model id (or alias, if the request was routed via an alias pool). |
| `agent` | string | Detected client agent (`claude-code`, `codex`, `openclaw`, …). Empty string if none. |
| `request_count` | integer | Successful + failed requests that landed on this `(provider, model, agent)` combo. |
| `input_tokens` | integer | Sum of input / prompt tokens. |
| `output_tokens` | integer | Sum of output / completion tokens. |
| `cache_read_tokens` | integer | Sum of cache-hit tokens. |
| `cache_write_tokens` | integer | Sum of cache-write tokens (where supported by the upstream). |
| `cost` | number | Spend in `currency`, computed from the model's pricing config. |
| `currency` | string | ISO 4217 currency code (default `"USD"`). |

### Example

```bash
curl "http://localhost:3456/api/user/stats?days=7" \
  -H "Authorization: Bearer tp-alice"
```

```json
[
  {
    "date": "2026-07-23",
    "token_id": "tp-alice",
    "provider_id": "anthropic-main",
    "model": "minimax-latest",
    "agent": "claude-code",
    "request_count": 12,
    "input_tokens": 84000,
    "output_tokens": 12000,
    "cache_read_tokens": 15000,
    "cache_write_tokens": 0,
    "cost": 0.62,
    "currency": "USD"
  },
  {
    "date": "2026-07-23",
    "token_id": "tp-alice",
    "provider_id": "openai-backup",
    "model": "gpt-5",
    "agent": "codex",
    "request_count": 3,
    "input_tokens": 22000,
    "output_tokens": 4100,
    "cache_read_tokens": 0,
    "cache_write_tokens": 0,
    "cost": 0.18,
    "currency": "USD"
  }
]
```

### Notes

- Rows are ordered `date DESC` — most recent day first.
- The endpoint reads `usage_daily` directly. That table is **never** pruned by log retention, so historical months remain queryable as long as the SQLite file is intact.
- If a row shows `request_count > 0` but `cost == 0`, the upstream call was probably rejected before token usage was reported (no `usage` block came back). Don't treat `cost == 0` as "free" — check `status` on the request itself via `/requests`.

---

## `GET /api/user/requests`

Returns the calling user's request log, newest first. Supports pagination and filtering by provider / model / agent / status / date / tag.

### Request

```http
GET /api/user/requests?limit=50&offset=0&status=error&date_from=2026-07-20 HTTP/1.1
Authorization: Bearer tp-alice
```

### Query parameters

| Param | Type | Default | Meaning |
|---|---|---|---|
| `limit` | integer | `50` | Page size, **capped at 200**. |
| `offset` | integer | `0` | Skip this many rows (use with `limit` for pagination). |
| `provider_id` | string | — | Exact match on provider id. |
| `model` | string | — | Exact match on model id (or alias name, if routed via an alias pool). |
| `status` | `"ok"` \| `"error"` | — | `ok` → `status = 200`; `error` → `status != 200`. Other values are ignored. |
| `agent` | string | — | Exact match on detected agent (`claude-code`, `codex`, …). |
| `date_from` | `YYYY-MM-DD` | — | Inclusive lower bound on `timestamp`. Interpreted as `00:00:00` local-time. |
| `date_to` | `YYYY-MM-DD` | — | Inclusive upper bound on `timestamp`. Interpreted as `23:59:59.999` local-time. |
| `tags` | comma-separated | — | Substring match on `custom_tags` (one `LIKE` per tag, AND-combined). |

### Response — `200 OK`

```ts
{
  data: RequestRow[],
  total: number   // Total rows matching the filter (without limit/offset).
}
```

#### `RequestRow` fields

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Unique request id (nanoid). Pass to `/requests/:id` for full detail. |
| `timestamp` | integer (ms since epoch) | Wall-clock time the request entered `forwardRequest` (i.e. **start**, not finish). Use this for ordering. |
| `token_id` | string | Calling user (always equals the auth'd user). |
| `provider_id` | string \| null | Provider that ultimately answered. `null` if every candidate failed. |
| `model` | string \| null | Model name from the request body. `null` if absent. |
| `resolved_model` | string | **Real** model id when the request used an alias pool (e.g. `minimax-latest` → `MiniMax-M4`). Empty string for direct (non-alias) requests. |
| `input_tokens` | integer | Prompt tokens consumed. |
| `output_tokens` | integer | Completion tokens consumed. |
| `cache_read_tokens` | integer | Cache-hit tokens. |
| `cache_write_tokens` | integer | Cache-write tokens. |
| `latency_ms` | integer | Total wall-clock duration from entry to last byte (includes streaming for SSE responses). |
| `ttft_ms` | integer | Time to first byte **from upstream** (0 if not measurable / pre-stream). |
| `status` | integer | Final HTTP status code returned to the client. `0` for network-layer failures that never produced a status. |
| `error` | string \| null | One-line error message if the request failed (`"upstream_timeout"`, `"client_disconnect"`, or the upstream's own message). |
| `cost` | number | Spend in `currency` for this request. |
| `currency` | string | ISO 4217 currency code (default `"USD"`). |
| `agent` | string | Detected client agent (`claude-code`, `codex`, …). Empty if none. |
| `custom_tags` | string | Comma-separated tags the user attached (forwarded from client headers if supported). Empty if none. |
| `route_trace` | string | JSON-encoded array of `RouteTraceEntry` (see below). Stored as a string in SQLite — parse it before reading. |
| `api_key_index` | integer | Index of the API key within the provider's key list (0-based). For multi-key providers this shows which key served the request. |
| `log_file` | string | Path to the JSONL log file (relative to `logDir`, e.g. `"2026-07-23/abc123.jsonl"`). Pass `id` to `/requests/:id` to fetch the parsed entries. |

#### `RouteTraceEntry` (inside `route_trace`)

```ts
{
  provider: string;             // provider id attempted
  status: number | null;        // upstream HTTP status, null on network error
  latencyMs: number;            // wall-clock for this attempt
  reason?: string;              // human label, e.g. "upstream_timeout", "model_not_offered", "client_disconnect"
  errorBody?: unknown;          // raw upstream error payload (JSON, string, etc.)
}
```

The `provider` field can repeat — multiple attempts against the same provider are normal (alias pools with multiple keys, fallback chains). The **last** entry whose `status` is a 2xx is the one that answered; the others are pre-failures.

### Example

```bash
# last 5 error requests in the past 3 days
curl "http://localhost:3456/api/user/requests?status=error&date_from=2026-07-21&limit=5" \
  -H "Authorization: Bearer tp-alice"
```

```json
{
  "data": [
    {
      "id": "Kx7qL3aBcDeFgHiJkLmN",
      "timestamp": 1753267200000,
      "token_id": "tp-alice",
      "provider_id": null,
      "model": "minimax-latest",
      "resolved_model": "MiniMax-M4",
      "input_tokens": 0,
      "output_tokens": 0,
      "cache_read_tokens": 0,
      "cache_write_tokens": 0,
      "latency_ms": 30012,
      "ttft_ms": 0,
      "status": 502,
      "error": "All provider candidates failed",
      "cost": 0,
      "currency": "USD",
      "agent": "claude-code",
      "custom_tags": "",
      "route_trace": "[{\"provider\":\"anthropic-main\",\"status\":429,\"latencyMs\":412,\"reason\":\"rate_limited\",\"errorBody\":{...}},{\"provider\":\"openai-backup\",\"status\":null,\"latencyMs\":30012,\"reason\":\"upstream_timeout\"}]",
      "api_key_index": 0,
      "log_file": "2026-07-23/Kx7qL3aBcDeFgHiJkLmN.jsonl"
    }
  ],
  "total": 1
}
```

### Notes

- The endpoint reads from `request_index` directly. That table **is pruned** by retention (`server.retentionPeriod`: `1week` / `1month` / `2month`) — old rows disappear once their day's log dir is deleted.
- For pagination, use the `total` field to compute page count: `pages = Math.ceil(total / limit)`.
- `route_trace` is stored as a stringified JSON array; parse it client-side with `JSON.parse(row.route_trace)`.

---

## `GET /api/user/requests/:id`

Returns one full request row (same shape as `RequestRow` above) **plus** the parsed JSONL log entries written during that request. Use this when you need to see the actual upstream request/response bodies, headers, and any per-attempt retry trail.

### Request

```http
GET /api/user/requests/Kx7qL3aBcDeFgHiJkLmN HTTP/1.1
Authorization: Bearer tp-alice
```

| Path param | Type | Meaning |
|---|---|---|
| `id` | string | The request id from `/requests` (or from any other surface — e.g. logs). |

### Response — `200 OK`

Same fields as `RequestRow`, plus a `logs` array.

### Response — `404 Not Found`

```json
{ "error": "Not found" }
```
(returned when the id doesn't exist **or** belongs to a different user — the two cases are intentionally indistinguishable.)

### `logs` field

Array of `LogEntry` objects, written in chronological order. There are four kinds:

| `type` | When it's written | Notable fields |
|---|---|---|
| `"request"` | Once, when the request enters the gateway. | `headers`, `body`, `streaming`, `client_ip`, `user_agent` |
| `"response"` | Once, when the final upstream response (or final-fail body) is ready to send to the client. | `headers`, `body`, `status`, `usage`, `error` |
| `"attempt_request"` | Per upstream attempt. | `attemptIndex`, `attemptProvider`, `attemptTargetUrl`, `headers`, `body` |
| `"attempt_response"` | Per upstream attempt. | `attemptIndex`, `attemptProvider`, `status`, `headers`, `body`, `usage`, `error`, `streamContent` (for SSE) |

All four fields appear for successful requests since 0.0.20; pre-0.0.20 logs only have `request` / `response`.

### Example

```bash
curl http://localhost:3456/api/user/requests/Kx7qL3aBcDeFgHiJkLmN \
  -H "Authorization: Bearer tp-alice"
```

```json
{
  "id": "Kx7qL3aBcDeFgHiJkLmN",
  "timestamp": 1753267200000,
  "token_id": "tp-alice",
  "provider_id": "anthropic-main",
  "model": "minimax-latest",
  "resolved_model": "MiniMax-M4",
  "status": 200,
  "input_tokens": 412,
  "output_tokens": 88,
  "cache_read_tokens": 0,
  "cache_write_tokens": 0,
  "cost": 0.0042,
  "currency": "USD",
  "latency_ms": 2341,
  "ttft_ms": 612,
  "agent": "claude-code",
  "custom_tags": "",
  "route_trace": "[{\"provider\":\"anthropic-main\",\"status\":200,\"latencyMs\":2334}]",
  "api_key_index": 0,
  "log_file": "2026-07-23/Kx7qL3aBcDeFgHiJkLmN.jsonl",
  "logs": [
    {
      "type": "request",
      "timestamp": 1753267200000,
      "headers": { "content-type": "application/json", "x-api-key": "sk-ant-…", "anthropic-version": "2023-06-01" },
      "body": { "model": "minimax-latest", "messages": [{"role":"user","content":"Hello"}], "max_tokens": 256 },
      "streaming": false
    },
    {
      "type": "attempt_request",
      "timestamp": 1753267200050,
      "attemptIndex": 0,
      "attemptProvider": "anthropic-main",
      "attemptTargetUrl": "https://api.anthropic.com/v1/messages",
      "headers": { "x-api-key": "sk-ant-…", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      "body": { "model": "MiniMax-M4", "messages": [{"role":"user","content":"Hello"}], "max_tokens": 256 }
    },
    {
      "type": "attempt_response",
      "timestamp": 1753267202400,
      "attemptIndex": 0,
      "attemptProvider": "anthropic-main",
      "status": 200,
      "headers": { "content-type": "application/json", "request-id": "req_…" },
      "body": { "id": "msg_…", "type": "message", "role": "assistant", "content": [{"type":"text","text":"Hi!"}], "usage": {"input_tokens": 412, "output_tokens": 88} }
    },
    {
      "type": "response",
      "timestamp": 1753267202410,
      "status": 200,
      "headers": { "content-type": "application/json" },
      "body": { "id": "msg_…", "type": "message", "role": "assistant", "content": [{"type":"text","text":"Hi!"}], "usage": {"input_tokens": 412, "output_tokens": 88} }
    }
  ]
}
```

### Notes

- The `body` and `headers` in `attempt_request` / `attempt_response` include the **real upstream credentials** (e.g. `x-api-key`). This endpoint is admin-only-equivalent in sensitivity — never expose it to a less-trusted boundary.
- For streaming (`streaming: true`) requests, the final `attempt_response` carries a `streamContent` field with the concatenated SSE chunks (text), and `body` is usually `null`. The `usage` block is still parsed off the final `[DONE]` chunk.
- `404` is intentionally indistinguishable from "wrong owner" so callers can't probe token ownership.

---

## Field & behavior reference

### Time semantics

| Surface | Time zone | Format |
|---|---|---|
| `usage_daily.date` | UTC | `YYYY-MM-DD` |
| `request_index.timestamp` | UTC (stored as ms since epoch) | integer |
| `date_from` / `date_to` query params | Local time of the host running TokenParty | `YYYY-MM-DD` |

The mismatch is intentional — `request_index.timestamp` and `usage_daily.date` are recorded in UTC so multi-host deployments behave identically; the date-range filters accept local-time `YYYY-MM-DD` because that's what users type. If your host is in `Asia/Shanghai` (UTC+8), `date_from=2026-07-23` is `2026-07-23 00:00 +08:00`, i.e. `2026-07-22 16:00 UTC`.

### Currency

All `cost` fields are denominated in `currency` (default `"USD"`). TokenParty stores a single currency per row; multi-currency support is read-side conversion only — the underlying `cost` is recorded in the model's configured pricing currency.

### Cache tokens

| Provider family | `cache_read_tokens` | `cache_write_tokens` |
|---|---|---|
| Anthropic | cache hit (`cache_read_input_tokens`) | cache write (`cache_creation_input_tokens`) |
| OpenAI | prompt-cache hit tokens | n/a (most OpenAI models don't bill cache writes separately) |

Other providers may leave both fields at `0`.

### Retention

| Table | Pruned by retention? | Implication |
|---|---|---|
| `usage_daily` | **No** | Historical aggregates live forever (rows are tiny). |
| `request_index` | **Yes** | When a day's log dir is deleted by `server.retentionPeriod` / `server.retentionMaxSizeMB`, all `request_index` rows whose `log_file LIKE '<day>/%'` are removed in the same transaction. |

If you need long-term request history, export `/requests` periodically before retention kicks in.

---

## Common error responses

All endpoints share the same error envelope:

```json
{ "error": "<message>" }
```

| Status | When |
|---|---|
| `400` | Malformed query param (e.g. `date_from=not-a-date` is silently ignored — no error, the filter is just skipped). |
| `401 Unauthorized` | Missing / unknown / disabled token. |
| `404 Not Found` | Request id doesn't exist or isn't owned by the caller. |

There is no `429` (rate limit) on these endpoints — TokenParty assumes the network boundary (reverse proxy / VPN / tailnet) protects them. If you expose them publicly, add rate limiting upstream.

---

## Worked examples

### "What's my daily burn for the last 30 days?"

```bash
curl "http://localhost:3456/api/user/stats?days=30" \
  -H "Authorization: Bearer tp-alice" \
  | jq '[.[] | {date, cost}] | group_by(.date) | map({date: .[0].date, cost: (map(.cost) | add)}) | sort_by(.date)'
```

### "Did I get rate-limited yesterday?"

```bash
curl "http://localhost:3456/api/user/requests?date_from=2026-07-22&date_to=2026-07-22&limit=200" \
  -H "Authorization: Bearer tp-alice" \
  | jq '.data[] | select(.route_trace | test("429|rate_limited")) | {id, model, error, route_trace}'
```

### "Why did request Kx7q fail?"

```bash
curl http://localhost:3456/api/user/requests/Kx7qL3aBcDeFgHiJkLmN \
  -H "Authorization: Bearer tp-alice" \
  | jq '.logs[] | select(.type | startswith("attempt")) | {type, provider: .attemptProvider, status, error}'
```

### "Am I close to my budget?"

```bash
curl http://localhost:3456/api/user/profile -H "Authorization: Bearer tp-alice" \
  | jq '{spent: .monthlySpent, budget: .monthlyBudget, pct: ((.monthlySpent / .monthlyBudget) * 100 | round)}'
```

---

## Versioning

These endpoints are part of the 0.0.x series and may grow fields over time. New optional fields are additive; existing fields are not renamed or repurposed within a minor version. Breaking changes (if any) will ship with a `BREAKING` note in `CHANGELOG.md` and a new URL prefix.