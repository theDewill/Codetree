# CodeTree

A graph-first workspace for understanding code. Import a GitHub repository, follow its connections, inspect exact source, and keep conversations attached to the nodes they explain.

This is the first working **local development release**, implementing the feasibility slice and parts of the foundation. It is not the completed production beta described in [the architecture plan](docs/PLAN.md). It uses a single-process Go API and a tenant-scoped local file store with encrypted credentials so it can run without cloud credentials.

## Run

Requirements: Go 1.24+, Node.js 22.12+ (Node 24 recommended), and npm.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. The launcher builds the Go API, starts it on **127.0.0.1:8090**, and starts Vite on **127.0.0.1:5173**. Stop both with Ctrl+C. Restart this command after Go or environment changes; frontend edits reload automatically.

The bundled Atlas sample is real TypeScript source in `examples/atlas`. It is analyzed at API startup through the same analysis adapter used for imports. The sample's storage/authentication code is illustrative and is never used to authenticate CodeTree users.

## What works now

- A colorful 3D map with an alternate 2D view, directional relationships, overview/focus views, zoom/fit controls, a searchable explorer, and semantic colors.
- Floating dock with model and Git branch selection, settings, and profile.
- Public GitHub repository import at an immutable commit, progress, cancellation, background completion, saved snapshots, and branch imports.
- JavaScript/TypeScript declarations, anonymous callbacks, relative imports, symbol references, inheritance, and resolvable calls using a virtual TypeScript compiler host.
- Go declarations and unambiguous package-local direct calls using the Go AST. External and dynamic relationships remain unresolved; coverage is visible in the app.
- A source viewer with line selection and block-specific question context.
- Separate, persisted conversations for each snapshot/node, source context links, streaming responses, and cancellation.
- A credential-free **Source guide**, explicitly labeled as structural analysis rather than an LLM.
- Live OpenAI and OpenAI-compatible Chat Completions adapters once credentials are configured. Model IDs come from developer configuration, not a hardcoded catalog.
- Developer model registration, edit/enable/disable/delete, connectivity tests, encrypted API keys or environment references, and an audit log.
- Supabase email/password, email confirmation, password reset, and Google/GitHub/Apple OAuth flows once configured.
- GitHub App user authorization for access to private repositories once configured. Repository API requests use the connected user's token; there is no shared private-repository token. Private snapshot reads recheck access with GitHub.

## Live AI models

Copy `.env.example` to `.env` and set:

```dotenv
CODETREE_MODEL_NAME=Your display name
CODETREE_MODEL_ID=exact-provider-model-id
CODETREE_MODEL_BASE_URL=https://api.openai.com/v1
CODETREE_MODEL_API_KEY=your-provider-key
```

Restart `npm run dev`. You can also open the dock's model menu → **Manage models** and register a provider model there. Select the correct adapter: **OpenAI** uses `max_completion_tokens`; **OpenAI-compatible** uses `max_tokens`. Different provider protocols require additional adapters.

Keys entered through the developer console are encrypted on disk using the server's local key. They are never returned to the browser. Environment references must end in `_API_KEY`. Provider endpoints must be public HTTPS addresses; redirects and private-network connections are rejected.

The local beta limits each workspace to 100 live model request attempts per UTC day, two concurrent responses, and 100 questions per node history. Requests use a conservative input budget and a 1,500-token output cap. These are initial operational guards, not subscription billing or exact tokenizer accounting. A developer connectivity test sends a short billable request to the configured provider.

Official protocol references: [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events).

## Real accounts

Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `.env`. Only the public/publishable anon key belongs here; a Supabase service-role key is not needed.

In Supabase:

1. Enable email/password and configure email delivery.
2. Configure Google, GitHub, and Apple with their respective provider credentials.
3. Set the site URL and allowed redirect URLs to your development or deployed origin. For local development, use `http://127.0.0.1:5173` and allow the reset URL `http://127.0.0.1:5173/?reset=1`.
4. Put verified Supabase user IDs that should have developer access into the server's comma-separated `CODETREE_ADMIN_IDS` setting.

Go validates the access token with Supabase's `/auth/v1/user` endpoint on each authenticated request. Administrator access comes from server configuration, never editable user metadata. OAuth scopes and Apple secret rotation are configured with the providers.

Without Supabase configuration, each browser gets a signed, HttpOnly cookie for its own local workspace, with developer tools enabled. Local-auth mode refuses to bind to a non-loopback address. It is for development, not internet exposure.

## Private GitHub access

Create a GitHub App with read-only repository **Contents** and **Metadata** permissions and selected-repository installation access. Configure its OAuth client ID and secret:

```dotenv
GITHUB_APP_CLIENT_ID=your-client-id
GITHUB_APP_CLIENT_SECRET=your-client-secret
GITHUB_APP_SLUG=your-app-slug
```

Use `http://127.0.0.1:5173/api/v1/github/callback` as the development callback URL. Install the App for the repositories you want to inspect, then use **Settings → GitHub → Connect**. This is separate from signing into CodeTree with GitHub.

The current implementation uses GitHub App **user access tokens** to preserve the intersection of app and user permissions. Expired or revoked tokens require reconnection. Installation-token background synchronization, token refresh, and verified push/revocation webhooks remain part of the production phase.

## Indexing boundaries

The first release accepts repositories with at most 500 included source files, 4 MB of included source, 256 KB per source file, and 2,500 graph nodes. Downloads also have compressed/uncompressed archive bounds and a two-minute job timeout. Large repositories receive an explicit limit error.

Source is kept in memory during parsing; archives are not extracted to arbitrary filesystem paths. Symlinks are ignored, unsafe paths are rejected, common generated/dependency directories are skipped, and repository scripts/builds are never executed. The TypeScript adapter receives virtual files over stdin with a sanitized environment; it does not load repo plugins, tsconfig execution hooks, or installed dependencies. It is **not yet an operating-system sandbox**.

TypeScript package dependencies, path aliases, full framework root detection, and Go type/selector/interface analysis are incomplete. Text files such as Python, Markdown, and JSON have file-level coverage. The UI reports these limitations rather than manufacturing edges.

## Data and operation

Local records live in `.data/`, which is excluded from source control and container build contexts. Workspace data and source are stored with restrictive file permissions. The encryption/signing key is `.data/server.key`; preserve it with backups, since losing it invalidates local cookies and encrypted credentials.

The store uses atomic file replacement and is intended for **one API process**. Import metadata survives restarts, but interrupted queued/running imports are marked failed and must be retried. Successfully published snapshots and chat histories persist. Node IDs belong to a snapshot; branch/commit/analyzer identity prevents source history from silently changing.

Do not expose this local edition as a production SaaS. The remaining production work includes PostgreSQL tenant policies and migrations, River workers, an actual per-job sandbox, managed secret storage, object-store retention/deletion, GitHub webhooks and token refresh, stronger retrieval/citation evaluation, quotas/billing, rate limiting, and load/accessibility testing. See [implementation status](docs/IMPLEMENTATION.md).

## Verify

```sh
npm run typecheck
npm run build
npm test
go test -race ./...
```

The tests cover semantic alias/method resolution, callbacks, recursion, shadowing, workspace isolation, signed-cookie tampering, persisted chat, encrypted keys, admin enforcement, origin checks, archive limits, and URL validation. They do not require provider credentials or billable API calls.

The development browser flow was also checked against a real public GitHub import. Live OAuth and billable model responses still require your provider configuration to verify end to end.

## Structure

```text
apps/web/                 React UI and developer console
cmd/api/                  Go server entry point
internal/app/             HTTP API, auth, imports, storage, chat, models
internal/analysis/        Shared graph contract and Go analysis
services/typescript/      In-memory TypeScript semantic adapter
examples/atlas/           Locally analyzed sample repository
scripts/dev.mjs           Development launcher
docs/                    Architecture and implementation status
```
