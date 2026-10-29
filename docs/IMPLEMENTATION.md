# Implementation status

The architecture plan is the target for the beta. This first delivery establishes a runnable local vertical slice; it does not claim that every phase is complete.

| Area | Delivered | Remaining for the beta |
| --- | --- | --- |
| Workspace | Responsive React app, explorer, 3D/2D graph, dock, inspector, semantic palette | Larger-repo performance budgets and full accessibility audit |
| Analysis | Virtual TypeScript compiler adapter, callbacks/imports/references/calls, Go AST baseline | Tree-sitter language expansion, full Go types, aliases/frameworks/dependency resolution |
| Imports | Bounded public GitHub archives, commit identity, per-user private access plumbing, progress/cancel | GitHub token refresh, signed webhooks, installation-based background sync, incremental indexing |
| Identity | Local signed workspaces and configurable Supabase account flows | Live provider setup/verification, MFA enforcement for admin, account deletion |
| Isolation | Server-verified identities, tenant-bound resources, encrypted credentials, tests | PostgreSQL/RLS, managed secrets, per-job OS sandbox, distributed-worker authorization |
| Conversations | Independent snapshot/node histories, selected-block context, SSE, cancellation | Durable request idempotency, retrieval evaluation, validated answer-level citations, embeddings |
| Models | OpenAI/compatible adapters, configurable registry, admin CRUD/test, output/concurrency/request caps | More native provider adapters, capability discovery, exact usage ledger and billing |
| Persistence | Atomic local files and restart-safe snapshots/chats | PostgreSQL, object storage, River retries/resume, backups and retention policies |

The current browser/Go API workflow can be used locally with a real GitHub repository. The bundled source guide is deterministic and explicitly labeled; live AI requires configured model credentials. Native OAuth providers require external registration and Supabase configuration.

The next implementation milestone should replace the local storage/job adapters with PostgreSQL and River, then isolate analyzer jobs before offering hosted private-code ingestion.
