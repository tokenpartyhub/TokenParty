<p align="center">
  <img src="https://em-content.zobj.net/source/apple/391/party-popper_1f389.png" width="80" />
</p>

<h1 align="center">TokenParty</h1>

<p align="center">
  <strong>Self-hosted AI gateway — route, observe, and control your LLM API traffic.</strong><br/>
  One binary. Zero dependencies. Full dashboard. No vendor lock-in.
</p>

<p align="center">
  <a href="#why-tokenparty">Why</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#dashboard">Dashboard</a> •
  <a href="#features">Features</a> •
  <a href="#configuration">Configuration</a> •
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tokenparty/tokenparty"><img src="https://img.shields.io/npm/v/@tokenparty/tokenparty?color=cb3837&logo=npm" alt="npm" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Hono-4.6-E36002?logo=hono&logoColor=white" alt="Hono" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
  <img src="https://img.shields.io/github/stars/tokenpartyhub/TokenParty?style=social" alt="Stars" />
</p>

<p align="center">
  <sub>One endpoint for all providers. Protocol translation between OpenAI and Anthropic. Cost-based smart routing. Per-user budgets. Full request inspector.</sub>
</p>

---

## Why TokenParty?

**Save Money** — Smart routing picks the cheapest provider for each model. Set monthly budgets per user. See exactly where every dollar goes.

**Stay Simple** — One endpoint for all providers. Send OpenAI-format requests to Claude, or Anthropic-format to GPT. Protocol translation is transparent.

**Keep Control** — Scoped API keys, provider-level access control, full request logging, and separate admin/user dashboards give the right view to the right person.

**Zero Ops** — Single Node.js process, embedded SQLite, no Redis, no Postgres, no Docker required. Just `npx tokenparty` and you're running.

```
┌─────────────┐       ┌──────────────┐       ┌──────────────────┐
│  Your Apps  │──────▶│  TokenParty  │──────▶│  OpenAI / Claude  │
│  (any SDK)  │◀──────│   Gateway    │◀──────│  / DeepSeek / ... │
└─────────────┘       └──────────────┘       └──────────────────┘
                            │
                      ┌─────┴─────┐
                      │ Dashboard │
                      └───────────┘
```

## Quick Start

### npx (zero install)

```bash
npx @tokenparty/tokenparty
```

### npm global

```bash
npm install -g @tokenparty/tokenparty
tokenparty
```

### Docker

```bash
# Create docker-compose.yaml, then:
docker compose up -d
```

<details>
<summary>docker-compose.yaml</summary>

```yaml
services:
  tokenparty:
    image: nfqlt/node22
    entrypoint: sh -c "npm install -g @tokenparty/tokenparty && tokenparty"
    ports:
      - "3456:3456"
    volumes:
      - npm_global:/usr/local
      - ./tokenparty-data:/root/.tokenparty
    restart: unless-stopped

volumes:
  npm_global:
```

</details>

Open `http://localhost:3456` — configure providers and tokens from the dashboard.

### Use it

Point any OpenAI-compatible SDK at your gateway:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="tp-***"
)

# Routes to the cheapest provider automatically
response = client.chat.completions.create(
    model="claude-sonnet-4-20250514",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

Or use the Anthropic SDK:

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:3456/anthropic",
    api_key="tp-***"
)

# GPT-4o through the Anthropic SDK — protocol converted transparently
message = client.messages.create(
    model="gpt-4o",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Dashboard

<p align="center">
  <img src="docs/img/overview.png" width="32%" alt="Overview" />
  <img src="docs/img/requests.png" width="32%" alt="Requests" />
  <img src="docs/img/users.png" width="32%" alt="Users" />
</p>

**Admin Portal** — Overview with cost/usage charts, request inspector with full prompt/response detail, provider management with groups, user & budget management, settings.

**User Portal** — Personal cost dashboard, budget progress, cache hit rate, model-level breakdown, request history.

**Agent Aware** — Automatically detects Claude Code, OpenClaw, and other AI agents. Shows per-agent usage breakdown in the dashboard.

## Features

| Category | Feature |
|----------|---------|
| **Routing** | Cost-based smart routing across providers |
| **Routing** | Provider fallback & automatic retry |
| **Routing** | Multi-key load balancing (round-robin) |
| **Routing** | Model-level priority with ordered fallback chain |
| **Protocol** | OpenAI ↔ Anthropic bidirectional conversion |
| **Protocol** | Full SSE streaming with protocol translation |
| **Protocol** | OpenAI Chat, Responses, and Models API support |
| **Cost** | Per-model pricing configuration (input/output/cache) |
| **Cost** | Monthly budget enforcement per user |
| **Cost** | Cost analytics by user, provider, model, and tag |
| **Cost** | Cache hit rate tracking |
| **Cost** | USD/CNY dual currency support |
| **Access** | Scoped API keys with provider-level access control |
| **Access** | Provider groups for bulk access rules |
| **Access** | Usage quotas per token |
| **Access** | Admin authentication |
| **Observability** | Real-time usage dashboard with charts |
| **Observability** | Full request/response JSONL audit logs |
| **Observability** | Route trace — see exactly how each request was routed |
| **Observability** | Custom tags via `x-tkparty-tags` header |
| **Observability** | Request filtering by user, provider, model, status, tags |
| **Observability** | AI agent detection (Claude Code, OpenClaw) |
| **Operations** | Hot-reload config (no restart needed) |
| **Operations** | Environment variable interpolation in config |
| **Operations** | Log storage management with auto-cleanup |
| **Operations** | Version update check |
| **Operations** | Keep-alive connection pooling |
| **Deployment** | npm / npx — single command, zero config |
| **Deployment** | Docker / docker-compose ready |
| **Deployment** | Zero external dependencies (SQLite, no Redis/Postgres) |
| **UX** | Separate admin & user portals |
| **UX** | Multi-account quick switching |

## Configuration

```yaml
providers:
  - id: anthropic-main
    type: anthropic
    name: "Anthropic"
    apiKey: ${ANTHROPIC_API_KEY}
    baseUrl: https://api.anthropic.com
    group: production
    models:
      - id: claude-sonnet-4-20250514
        inputPrice: 3        # $ per 1M tokens
        outputPrice: 15
        cacheReadPrice: 0.3
      - claude-opus-4-20250514

  - id: openai-main
    type: openai
    name: "OpenAI"
    apiKey: ${OPENAI_API_KEY}
    baseUrl: https://api.openai.com/v1
    group: production
    models:
      - gpt-4o
      - gpt-4o-mini

tokens:
  - key: tp-team-alice
    name: "Alice"
    allowedProviders: ["group:production"]
    monthlyBudget: 100      # USD — enforced by the proxy
    enabled: true

  - key: tp-team-bob
    name: "Bob"
    allowedProviders: [openai-main]
    monthlyBudget: 50
    enabled: true
```

Unconfigured model prices are treated as free and routed with highest priority. Environment variables in `${VAR}` format are resolved at startup.

## Architecture

```
TokenParty/
├── packages/
│   ├── proxy/          # Hono reverse proxy (TypeScript)
│   │   └── src/
│   │       ├── adapters/       # OpenAI ↔ Anthropic translators
│   │       ├── proxy/          # Auth, routing, forwarding
│   │       ├── metrics/        # Usage collection → SQLite
│   │       ├── routes/         # Admin & user API handlers
│   │       ├── tags/           # Agent detection & tag extraction
│   │       └── store/          # Database & log writer
│   └── dashboard/      # React + Vite + Tailwind + Recharts
│       └── src/
│           ├── layouts/        # Admin & User layouts
│           └── pages/          # Overview, Requests, Providers, Users, Settings
```

| Component | Tech | Role |
|-----------|------|------|
| Gateway | Hono + Node.js | Reverse proxy with streaming SSE |
| Storage | better-sqlite3 (WAL) | Usage aggregation & request index |
| Logs | JSONL files | Full request/response audit trail |
| Dashboard | React 19 + Vite 6 | Admin & user monitoring UI |
| Config | YAML + chokidar | Hot-reloadable setup |

## How It Works

1. **Add providers** — Configure your OpenAI, Anthropic, DeepSeek, etc. API keys in the dashboard or YAML
2. **Create tokens** — Generate scoped API keys for your team with budgets and provider access rules
3. **Point your apps** — Any OpenAI or Anthropic SDK, just change the `base_url`
4. **Observe** — Watch costs, usage, and full request traces in real-time

## Roadmap

- [x] npm package & Docker deployment
- [x] Multi-provider support with load balancing
- [x] OpenAI ↔ Anthropic protocol translation
- [x] Full SSE streaming with protocol conversion
- [x] Cost-based smart routing
- [x] Per-user monthly budget enforcement
- [x] Separate admin & user portals
- [x] Multi-account quick switching
- [x] Real-time cost & usage dashboard
- [x] Request inspector with full audit trail
- [x] Custom tags & filtering
- [x] Provider groups & access control
- [x] Provider fallback / retry
- [x] Log storage management
- [x] Configurable log retention (1 week / 1 month / 2 months) + rolling daily cleanup; Overview aggregates preserved
- [x] AI agent detection & per-agent detail panel (Claude Code, OpenClaw)
- [x] Model-level priority with ordered fallback chain across providers
- [x] Route trace — visual routing diagram for each request
- [x] Upstream model auto-discovery
- [x] Connection pooling (keep-alive HTTP agents) — prevents TIME_WAIT port exhaustion
- [x] Provider config validation (rejects invalid baseUrl etc. at save time)
- [x] Dashboard copy-as-cURL on request route trace
- [x] Shareable request URLs (filters, pagination, and detail id in URL)
- [x] OpenAI Responses → Chat Completions bridge (per-provider, openai-only) — splits `<think>...</think>` into a `reasoning` output item and routes `delta.reasoning_content`; adds `output_text` + `created_at`
- [x] `/v1/models` matches Codex 0.144+ `ModelInfo` struct (all 38 fields + nested `ModelMessages`/`TruncationPolicyConfig` with correct enum values) — stops "failed to decode models response" warnings
- [x] Alias pool robustness — rename inline, ghost entries tinted in the dashboard, server-side validation rejects pool entries referencing models no provider serves, provider edit/delete reports orphaned aliases (cascade delete available)
- [ ] Automatic prompt cache optimization (Anthropic cache_control injection)
- [ ] Cost savings report ("TokenParty saved you $XX")
- [ ] Tag-based cost analysis (cost breakdown by project/feature)
- [ ] Usage alerts (webhook/email at budget thresholds)
- [ ] Model downgrade strategy (budget-aware auto-routing)
- [ ] Rate limiting enforcement
- [ ] Session tracking
- [ ] Export billing reports (CSV/PDF)

See the [full roadmap](https://github.com/tokenpartyhub/TokenParty/projects) and [open issues](https://github.com/tokenpartyhub/TokenParty/issues) for what's next.

## Comparison

| | TokenParty | LiteLLM | One API | Portkey |
|---|---|---|---|---|
| **Self-hosted** | ✅ | ✅ | ✅ | ❌ (SaaS) |
| **Language** | TypeScript / Node.js | Python | Go | — |
| **Zero dependencies** | ✅ (SQLite, no Redis/PG) | ❌ (Postgres/Redis) | ✅ | — |
| **Protocol translation** | OpenAI ↔ Anthropic | OpenAI only | OpenAI only | OpenAI only |
| **Built-in dashboard** | ✅ (React) | ❌ (separate) | ✅ (basic) | ✅ |
| **Per-user budgets** | ✅ | ❌ | ✅ (basic) | ✅ |
| **Agent detection** | ✅ | ❌ | ❌ | ❌ |

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and guidelines.

## License

[MIT](./LICENSE) © 2026 Zhou Zhengchang

---

<p align="center">
  <sub>Built with way too many tokens.</sub>
</p>
