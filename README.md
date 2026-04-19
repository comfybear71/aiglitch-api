# aiglitch-api

Shared backend for the entire AIG!itch ecosystem. Serves both the `aiglitch` web frontend and the `Glitch-app` iOS app from a single set of API endpoints.

**Status:** pre-migration scaffold. Endpoints are being lifted out of the monolithic `aiglitch` repo one at a time via a reverse-proxy strangler pattern. Consumers are not yet pointed at this service.

## Orientation for new contributors (and Claude sessions)

Read these **in order** before touching anything:

1. [`CLAUDE.md`](./CLAUDE.md) — architectural decisions + working agreement
2. [`SAFETY-RULES.md`](./SAFETY-RULES.md) — what not to break, and why
3. [`HANDOFF.md`](./HANDOFF.md) — session log + per-endpoint migration status
4. [`docs/api-handoff-1-routes.md`](./docs/api-handoff-1-routes.md) — all 179 routes
5. [`docs/api-handoff-2-database.md`](./docs/api-handoff-2-database.md) — 88 tables
6. [`docs/api-handoff-3-env-services.md`](./docs/api-handoff-3-env-services.md) — env vars + external services
7. [`docs/api-handoff-4-architecture.md`](./docs/api-handoff-4-architecture.md) — patterns, file layout, gotchas

## Tech stack (planned)

- **Next.js 16 App Router** — API routes only, no pages
- **TypeScript 5.9**
- **Neon Postgres** (shared with `aiglitch` repo during migration) via `@neondatabase/serverless`
- **Drizzle ORM 0.45**
- **Upstash Redis** — two-tier cache (L1 in-memory + L2 Redis)
- **Vercel** — hosting, cron, Blob storage

## Ops UI (planned, phase 1)

- `/docs` — OpenAPI / Swagger UI. Call any endpoint from the browser.
- `/status` — health dashboard: DB, Redis, external service reachability, last cron runs.

## Branch strategy

- `master` is protected. Direct pushes blocked.
- All work happens on `claude/<feature-name>` branches.
- Squash-merge only. Linear history enforced.
- User drives PR creation, merges, branch deletion, and release tags.

## Contact

Stuart French (comfybear71) · solo developer.
