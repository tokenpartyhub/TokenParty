# Contributing to TokenParty

Thanks for your interest in contributing! 🎉

## Getting Started

```bash
git clone https://github.com/tokenpartyhub/TokenParty.git
cd TokenParty
pnpm install
pnpm dev              # Start proxy on :3456
pnpm dev:dashboard    # Start dashboard on :3457
```

## Project Structure

```
packages/
├── proxy/      # Hono reverse proxy (TypeScript)
│   └── src/
│       ├── adapters/    # OpenAI ↔ Anthropic protocol translators
│       ├── proxy/       # Auth, routing, forwarding
│       ├── metrics/     # Usage collection → SQLite
│       ├── routes/      # Admin & user API handlers
│       ├── tags/        # Agent detection & tag extraction
│       └── store/       # Database & log writer
└── dashboard/  # React 19 + Vite + Tailwind + Recharts
```

## Development Workflow

1. **Fork & branch** — Create a branch from `main` (e.g. `feat/my-feature`)
2. **Code** — Follow existing style. TypeScript strict mode is enforced.
3. **Test** — Make sure `pnpm build` succeeds and existing functionality works
4. **Commit** — Use conventional commits:
   - `feat: add X`
   - `fix: resolve Y`
   - `docs: update Z`
   - `chore: cleanup W`
5. **PR** — Open a pull request against `main`. Describe what and why.

## Code Style

- TypeScript strict mode
- No `any` types unless absolutely necessary
- Prefer functional style; avoid classes unless managing stateful resources
- Named exports (no default exports)
- File names: kebab-case for files, PascalCase for components/types

## Reporting Bugs

Use the bug report template when opening an issue. Include:
- TokenParty version
- Node.js version
- Provider and model involved
- Minimal reproduction steps
- Expected vs actual behavior

## Feature Requests

Open a discussion or issue with the `enhancement` label. Describe the use case — not just the solution.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
