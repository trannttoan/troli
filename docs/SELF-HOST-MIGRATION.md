# Self-Host Migration — LangGraph Cloud → Desktop, LangSmith → Langfuse

Moves the backend off LangGraph Cloud onto a standalone LangGraph server running on the
gaming desktop (Windows 11 + WSL2, rootless Docker), reachable from the phone over
Tailscale. Tracing moves from LangSmith to the self-hosted Langfuse already running on the
desktop.

This document consolidates and supersedes:

- `aisist-full-setup.md` (repo root) — app + desktop setup template
- the app-facing parts of `gaming-desktop-server-setup.md` (repo root)
- the previous draft of this file
- steps 5–6 of [RENAME-MIGRATION.md](RENAME-MIGRATION.md)

Facts below were verified against the repo at `c15b301` and against current LangChain and
Langfuse docs (Aug 2026). Anything still uncertain is marked **verify**.

---

## 0. Where things stand

**Done:**

- Troli → Aisist rename merged (`7e3153e`, PR #11). Sign-in verified on device.
- Desktop set up per `gaming-desktop-server-setup.md` steps 1–6, with these confirmed
  specifics:
  - **Option B** distro hardening: the existing Ubuntu distro has `automount`/`interop`
    disabled — no `/mnt/c`, no Windows credential access from WSL.
  - Rootless Docker as the unprivileged `services` user, linger enabled, WSL keep-alive
    scheduled task in place (reboot + login brings everything back).
  - Langfuse self-hosted at `127.0.0.1:3000`, served on the tailnet at
    `https://<desktop>.<tailnet>.ts.net` (port 443) via `tailscale serve`.
  - Tailnet ACLs hardened: phone/Mac reach the desktop only on enumerated ports
    (currently 443, possibly 22). Mac and phone are on the tailnet.
- Steps 7+ of the desktop guide (GPU/vLLM/monitoring/training) are **not** done and are
  not needed for this migration — the backend calls Gemini via `GOOGLE_API_KEY`.

**Current app state:**

- Mobile talks directly to LangGraph Cloud. `mobile/src/services/langgraph.ts` hand-rolls
  the HTTP calls (no `@langchain/langgraph-sdk` anywhere in the workspace) against four
  endpoints: `POST /threads`, `GET /threads/{id}`, `GET /threads/{id}/state`,
  `POST /threads/{id}/runs/stream` (SSE).
- Every call carries `x-api-key` (`mobile/src/services/langgraph.ts:335`) holding a
  LangSmith personal token from `EXPO_PUBLIC_LANGGRAPH_API_KEY`. The client refuses to
  start without a non-empty value (`langgraph.ts:93`).
- The Google access token travels in the run body as `config.configurable.access_token`
  and is read back by `backend/src/utils/tool-config.ts`.
- Auth runs inside the graph: `preprocessNode` (`backend/src/agent.ts`) calls
  `validateGoogleToken` (Google tokeninfo) and `verifyThreadAuthorization`. Thread IDs are
  `uuidv5(email, AISIST_NAMESPACE)`, with the namespace duplicated in
  `backend/src/utils/thread.ts` and `mobile/src/utils/thread.ts`.
- `backend/langgraph.json` already exists: graph `agent` → `./src/agent.ts:graph`,
  `node_version` 22, `dependencies: ["."]`, `env: ".env"` (dev only).
- CLI is `@langchain/langgraph-cli@^1.2.5` with `dev`/`build`/`up`/`dockerfile` wired as
  pnpm scripts (`langgraph:build` etc.).

## 1. Target architecture

**Current phase — Tailscale direct, no proxy:**

```
iPhone (Expo dev build, Tailscale VPN on)
   │  https://<desktop>.<tailnet>.ts.net:8445
   ▼
Windows host ── tailscale serve (TLS, tailnet-only) ──▶ localhost:8123 (WSL2 relay)
   ▼
Ubuntu WSL2, rootless Docker (services user)
   ├─ aisist api      127.0.0.1:8123 → container :8000   (langgraph standalone image)
   ├─ postgres:16     (threads, checkpoints — internal network only)
   ├─ redis:7         (run queue — internal network only)
   └─ langfuse stack  127.0.0.1:3000 (already running)
        └── shared docker network: agents-shared
```

Port plan on the tailnet: 443 = Langfuse (taken), **8445 = aisist API**. 8443/8444 stay
reserved for vLLM/Grafana if desktop-guide steps 7+ ever happen.

**Later phase (unchanged plumbing):** an OCI VPS joins the tailnet as the public front
door, runs the auth proxy (§8), and calls this same `:8445` endpoint. Nothing built here
gets redone.

## 2. Design decisions (and why)

**Standalone container, not a rewrite.** `langgraph build` wraps the graph in LangChain's
official API server image, exposing the same HTTP API the mobile client already speaks
(`/threads`, `/runs/stream` SSE, checkpoints), backed by Postgres + Redis you provide. The
mobile client needs **no code changes** this phase — only env values.

**Auth this phase = network layer + existing graph validation.** Custom auth is not
available on Self-Hosted Lite ([langgraph#5390](https://github.com/langchain-ai/langgraph/issues/5390));
the `x-api-key` header is ignored. Known consequence (was `docs/plans/phase-1.md:68-74`):
the three non-run endpoints have no user-level auth, and thread IDs are derivable from an
email. That is acceptable **now** because the only devices that can reach port 8445 at all
are your own (tailnet ACLs), and it stops being acceptable the moment anything public
fronts this — which is why the VPS phase requires the proxy in §8 before launch. Do not
shortcut the VPS phase with a shared key baked into the app; that recreates the
extractable-token problem this migration closes.

**LangSmith stays as a license, not a tracer.** The standalone server authenticates at
startup with `LANGSMITH_API_KEY` and needs egress to `https://beacon.langchain.com` for
license verification ([docs](https://docs.langchain.com/langsmith/deploy-standalone-server)).
`LANGGRAPH_CLOUD_LICENSE_KEY` is the enterprise variant — only reach for it if startup
demands it (confirmed at first boot: the server logs `running in lite mode with LangSmith API
key` and starts — that warning is the healthy state, not a problem; a node-execution
cap applies on the free plan). "License verification failed" in container logs is
always env config, never code. The key now lives server-side, never in a mobile bundle.

**Langfuse via the v4 JS SDK.** The backend is on `@langchain/core` 1.x; LangChain v1
support landed in `@langfuse/langchain` **≥ 4.3.0**
([changelog](https://langfuse.com/changelog/2025-10-26-langchain-v1-support)). The old
`langfuse-langchain` v3 package is the wrong choice here (v1 compat unverified, and it
reads `LANGFUSE_BASEURL` — no underscore — a classic silent-no-traces trap). v4 is
OpenTelemetry-based: it needs a `LangfuseSpanProcessor` registered in a `NodeSDK` at
module load, plus the `CallbackHandler` bound to the graph at compile time (the server
invokes the graph itself, so per-call callbacks aren't possible). Tracing is fail-open:
Langfuse down ⇒ spans dropped, runs unaffected.

## 3. Phase 1 — Backend changes (on the Mac, in this repo)

### 3.1 Dependencies

```bash
pnpm --filter @aisist/backend add @langfuse/langchain @langfuse/otel @opentelemetry/sdk-node
```

**Security floor:** `@langchain/langgraph` must be ≥ 1.4.12 and
`@langchain/langgraph-checkpoint` ≥ 1.1.4 —
[GHSA-j87f-x5h5-gr75](https://github.com/langchain-ai/langgraphjs/security/advisories/GHSA-j87f-x5h5-gr75)
(insecure deserialization in `JsonPlusSerializer`, CVSS 7.7) allows arbitrary code
execution when a checkpoint containing attacker-crafted structured data (e.g.
`additional_kwargs`) is restored. Auth is not a mitigation — an authorized caller can
plant the payload — so never downgrade below these versions. The langgraph-cli 1.4.x
line ships the matching patched dev-server harness.

### 3.2 `backend/src/agent.ts`

Two additions (shape below — confirm exact API against the Langfuse v4 docs when
implementing):

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { CallbackHandler } from '@langfuse/langchain';

// module scope — runs once per server worker
if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
  new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] }).start();
}

export const graph = workflow.compile().withConfig({
  callbacks: [new CallbackHandler()],
});
```

Today the last line is `export const graph = workflow.compile();`. Without keys set, the
handler's spans hit a no-op tracer — local dev without Langfuse still works. Do **not**
wire a checkpointer into the compiled graph; the server injects its own (that's what its
Postgres is for).

The handler/processor read `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`,
`LANGFUSE_BASE_URL`, and `LANGFUSE_TRACING_ENVIRONMENT` from env. Per-user/session
attribution in traces (userId, sessionId from run metadata) is a later upgrade — get
plain traces flowing first.

### 3.3 Env files

`backend/.env.example` — remove `LANGSMITH_ENDPOINT` and `LANGSMITH_PROJECT`, flip
tracing off, add Langfuse:

```bash
GOOGLE_API_KEY=
LANGSMITH_API_KEY=            # standalone-server license only — tracing stays off
LANGSMITH_TRACING=false
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=            # dev: http://localhost:3000 tunnel or leave unset
LANGFUSE_TRACING_ENVIRONMENT=dev
```

`LANGSMITH_TRACING=false` matters: the built-in LangChain tracer is env-driven with no
code references, so this is the whole off-switch. Mirror the same shape in `backend/.env`
(gitignored).

### 3.4 Keep `.env` out of the image

`langgraph.json` has `dependencies: ["."]`, so the build context is all of `backend/` —
including `backend/.env` if you build where it exists. Add `backend/.dockerignore`:

```
.env
node_modules
```

(The desktop builds from a fresh clone with no `.env`, so this is a backstop, but a cheap
one.)

### 3.5 Local dev loop

```bash
pnpm --filter @aisist/backend dev        # langgraphjs dev, in-memory persistence
curl -s http://localhost:2024/ok
```

Optionally point the phone dev client at `http://<mac-ip>:2024` to smoke-test on-device
before the desktop exists. Then `pnpm -r run typecheck && pnpm -r run test` — the
`withConfig` change should not disturb the existing 121 backend / 100 mobile tests, but
confirm.

## 4. Phase 2 — Desktop deployment (Ubuntu WSL, as `services`)

Everything below runs as the `services` user unless marked **[Windows]**. Enter with
`sudo -iu services` (`-i` matters: full login shell, correct `$HOME`).

### 4.1 Toolchain + repo

```bash
# SSH deploy key — Option B distro has no Windows credential access
ssh-keygen -t ed25519 -C "desktop-services"
cat ~/.ssh/id_ed25519.pub        # add as read-only deploy key on the GitHub repo

# Node 22 + pnpm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
corepack enable && corepack prepare pnpm@latest --activate

git clone git@github.com:<you>/aisist.git ~/apps/aisist
cd ~/apps/aisist && pnpm install
```

Clone into the Linux filesystem (`~/apps`) — on this distro `/mnt/c` doesn't exist
anyway.

### 4.2 Log caps for the rootless daemon

```bash
mkdir -p ~/.config/docker
cat > ~/.config/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
systemctl --user restart docker    # briefly bounces Langfuse; it self-heals
```

### 4.3 Build the image

```bash
cd ~/apps/aisist/backend
npx @langchain/langgraph-cli build -t aisist-backend:latest
```

The CLI pulls the latest `langgraphjs-api` base image by default — do **not** pass
`--no-pull`: the server runtime inside the base image has its own copy of the checkpoint
serializer and must also carry the GHSA-j87f-x5h5-gr75 patch (§3.1).

If the container later fails on DB config, inspect what the generated image expects:
`npx @langchain/langgraph-cli dockerfile -` from `backend/`.

### 4.4 Shared network → Langfuse

```bash
docker network create agents-shared
```

In `~/langfuse/docker-compose.yml`, add at top level:

```yaml
networks:
  agents-shared:
    external: true
```

and under the web service (name it exactly as `docker compose ps` shows — usually
`langfuse-web`):

```yaml
networks:
  - default
  - agents-shared
```

Apply with `cd ~/langfuse && docker compose up -d`. This is why
`LANGFUSE_BASE_URL=http://langfuse-web:3000` resolves from inside the aisist container,
sidestepping rootless Docker's host-loopback limitations.

### 4.5 Deploy config

Deployment lives outside the repo checkout so `git pull` never touches it.

`~/apps/aisist-deploy/docker-compose.yml`:

```yaml
name: aisist
networks:
  agents-shared:
    external: true
services:
  api:
    image: aisist-backend:latest
    restart: always
    ports:
      - '127.0.0.1:8123:8000'
    env_file: .env
    environment:
      REDIS_URI: redis://redis:6379
      DATABASE_URI: postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/aisist?sslmode=disable
      POSTGRES_URI: postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/aisist?sslmode=disable
    networks:
      - default
      - agents-shared
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
  postgres:
    image: postgres:16
    restart: always
    environment:
      POSTGRES_DB: aisist
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 5s
      retries: 10
  redis:
    image: redis:7
    restart: always
volumes:
  pgdata:
```

`DATABASE_URI` is the documented variable; `POSTGRES_URI` is set too because server
versions have differed on which they read — the extra one is ignored.

`~/apps/aisist-deploy/.env`, then `chmod 600 .env`:

```bash
POSTGRES_PASSWORD=<openssl rand -hex 24>
LANGSMITH_API_KEY=<langsmith key>       # license only
LANGSMITH_TRACING=false                 # keep traces out of LangSmith cloud
GOOGLE_API_KEY=<gemini key>
LANGFUSE_PUBLIC_KEY=<pk from self-hosted Langfuse project "aisist">
LANGFUSE_SECRET_KEY=<sk from same>
LANGFUSE_BASE_URL=http://langfuse-web:3000
LANGFUSE_TRACING_ENVIRONMENT=prod
```

Create the `aisist` project in the Langfuse UI first and copy its keys.

### 4.6 First boot + local verification

```bash
cd ~/apps/aisist-deploy
docker compose up -d
docker compose logs -f api          # wait for migrations + license check, then Ctrl+C
curl -s http://localhost:8123/ok    # → {"ok":true}

# Langfuse reachability from inside the container (no wget/curl in the image)
docker compose exec api node -e \
  "fetch('http://langfuse-web:3000/api/public/health').then(r=>r.text()).then(t=>console.log('OK',t)).catch(e=>console.error('ERR',e.cause?.code||e.message))"
```

Then drive a real run with the repo's verify script (it reads `LANGGRAPH_API_URL` /
`LANGGRAPH_API_KEY`; Lite ignores the key but the script requires a value):

```bash
cd ~/apps/aisist
LANGGRAPH_API_URL=http://localhost:8123 \
LANGGRAPH_API_KEY=unused \
GOOGLE_ACCESS_TOKEN=<token> GOOGLE_ACCOUNT_EMAIL=<test-email> \
pnpm --filter @aisist/backend run verify:cloud
```

After it passes, check both tracing outcomes: the run appears in Langfuse
(`environment=prod`), and nothing new appears in the LangSmith cloud dashboard.

### 4.7 Publish over Tailscale — [Windows]

443 stays with Langfuse. Elevated PowerShell:

```powershell
tailscale serve --bg --https=8445 http://localhost:8123
```

(If the syntax complains, check `tailscale serve --help` — it changed between versions.)

**ACLs:** the tailnet ACLs enumerate ports, so add 8445 to what phone/Mac may reach on
the desktop — otherwise the next test fails and looks like a server bug.

Test from the phone on cellular with Tailscale on:
`https://<desktop>.<tailnet>.ts.net:8445/ok` → `{"ok":true}`. Then confirm it does NOT
load from a non-tailnet device.

## 5. Phase 3 — Point the app at it

`mobile/.env` (and matching `.env.example` comments):

```bash
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=<unchanged>
EXPO_PUBLIC_LANGGRAPH_API_URL=https://<desktop>.<tailnet>.ts.net:8445
EXPO_PUBLIC_LANGGRAPH_API_KEY=unused    # client requires non-empty; Lite ignores it
EXPO_PUBLIC_LANGGRAPH_ASSISTANT_ID=agent
```

No mobile code changes: the client keeps sending `x-api-key` (harmlessly ignored), the
SSE path (`mobile/src/services/sse.ts`) is talking to the same server API, and the
existing tests asserting the header stay valid. Dropping the header entirely happens in
the VPS phase.

Rebuild the Expo dev build, then smoke test: send a message → response streams; kill and
reopen the app → thread rehydrates from the server.

## 6. Phase 4 — Acceptance checklist

- [x] `docker compose ps` in `~/apps/aisist-deploy`: three services running
- [x] `curl localhost:8123/ok` inside Ubuntu → ok
- [x] `https://<desktop>.<tailnet>.ts.net:8445/ok` from phone on cellular → ok
- [x] `verify:cloud` passes against `localhost:8123` (and optionally the ts.net URL from the Mac)
- [x] Mobile smoke test: stream + rehydrate
- [x] A phone-initiated run appears in Langfuse with `environment=prod`
- [x] Nothing new appears in LangSmith cloud
- [x] **Reboot test:** reboot Windows, log in (manual login is by design), touch nothing
      else; after ~2 minutes the `/ok` URL answers from the phone on cellular. Linger +
      the scheduled task + `restart: always` should need zero further intervention.

## 7. Phase 5 — Decommission and cleanup

Only after the checklist passes:

1. Delete the LangGraph Cloud deployment (`https://troli-<hash>.us.langgraph.app`).
2. Revoke the LangSmith personal token that shipped in the old mobile env; if it's the
   same key now used as the server license, rotate it instead and update the deploy
   `.env`. Ordinary hygiene, not incident response — the old token was never distributed
   (no TestFlight; only the dev phone and local Xcode build products).
3. Clear stale build products on the Mac:
   ```bash
   rm -rf ~/Library/Developer/Xcode/DerivedData/Troli-* ~/Library/Developer/Xcode/DerivedData/Aisist-*
   ```

## 8. Later phase — OCI VPS front door + auth proxy

Deferred, but designed now so nothing this phase conflicts with it. When the app needs to
work off-tailnet (TestFlight testers, public launch):

- A free OCI instance joins the tailnet (desktop guide step 10) and is the only public
  surface, on 443. Tailnet ACLs let it reach the desktop on exactly 8445 (and 443 if it
  ingests to Langfuse).
- It runs a thin HTTP proxy in front of this same endpoint. The mobile client then ships
  **no** API key — only the Google access token it already holds, as a Bearer header.
  Per endpoint, the proxy must:
  - `POST /threads` — validate the token (tokeninfo), derive the thread ID from the
    email, reject any client-supplied mismatch.
  - `GET /threads/{id}`, `GET /threads/{id}/state` — verify `{id}` equals
    `uuidv5(email, AISIST_NAMESPACE)`. This closes the currently-open endpoints.
  - `POST /threads/{id}/runs/stream` — same thread check, plus **rewrite**
    `config.configurable.access_token` to the token the proxy validated (never forward
    the client's value unchecked), and stream SSE through without buffering — a naive
    read-then-return breaks the typing indicator.
- Open questions that only matter then: proxy as a third workspace package vs separate
  service (in-repo makes sharing `AISIST_NAMESPACE` + auth helpers easy); whether
  `validateGoogleToken` gets refactored to take a raw token instead of a
  `LangGraphRunnableConfig` so graph and proxy share it (touches
  `backend/src/utils/auth.ts` and its 12 tests); rate limiting at the proxy; per-user
  attribution in Langfuse traces.

## 9. Collateral to update alongside

- **`docs/DEPLOY.md`** — documents the LangGraph Cloud rollout; rewrite for this path or
  retire it in favor of this doc's §4.
- **`docs/TRD.md`** — architecture and auth-model sections change.
- **`docs/plans/phase-1.md:68-74`** — record the shared-key exposure as closed for the
  tailnet phase (key is now inert), with the proxy as the condition for going public.
- **`backend/scripts/verify-langgraph-cloud.mjs`** — works as-is against the self-hosted
  server (§4.6); consider renaming `verify:cloud` later, not load-bearing.
- **Tests** — no changes required this phase. `mobile/src/services/__tests__/langgraph.test.ts`
  still asserts `x-api-key`, which the client still sends.
- Root-level `aisist-full-setup.md` and `gaming-desktop-server-setup.md` — the app-facing
  content now lives here; keep the desktop guide for infra reference, delete or archive
  the full-setup file.

## 10. Troubleshooting

| Symptom                                        | Likely cause / fix                                                                                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container exits: "License verification failed" | `LANGSMITH_API_KEY` missing/invalid in deploy `.env`, or no egress to beacon.langchain.com — never a code problem                                                                                               |
| api crash-loops on DB errors                   | URI var mismatch — both `DATABASE_URI` and `POSTGRES_URI` are set in §4.5; if still failing, inspect the generated Dockerfile (§4.3)                                                                            |
| Runs work, no traces in Langfuse               | Keys/`LANGFUSE_BASE_URL` unset in deploy `.env`; OTel processor not initialized (§3.2); or the v3-package `LANGFUSE_BASEURL` trap if the wrong SDK got installed. Then check the §4.6 in-container health probe |
| Traces appear in LangSmith cloud               | `LANGSMITH_TRACING=false` missing from deploy `.env`                                                                                                                                                            |
| Unreachable from phone, fine on desktop        | Phone VPN off, ACL missing 8445, or serve not persisted (`--bg`)                                                                                                                                                |
| `localhost:8123` dead, containers running      | WSL localhost relay went stale — `wsl --shutdown` from PowerShell, reopen Ubuntu, `docker compose up -d`                                                                                                        |
| Unreachable after reboot                       | Not logged in yet (manual login is by design), or the keep-alive scheduled task didn't fire — check Task Scheduler history                                                                                      |
| Build/install fails weirdly as `services`      | Wrong `$HOME` — enter with `sudo -iu services`; nvm must be installed for that user                                                                                                                             |
| Everything slow                                | Repo not under `~/apps` on the Linux filesystem                                                                                                                                                                 |

## 11. Maintenance

- **Deploy a change:** `cd ~/apps/aisist && git pull && pnpm install && cd backend &&
npx @langchain/langgraph-cli build -t aisist-backend:latest && cd ~/apps/aisist-deploy
&& docker compose up -d api`
- **Backups** (once threads stop being test data):
  `docker compose exec postgres pg_dump -U postgres aisist | gzip > backup-$(date +%F).sql.gz`
- **Monthly:** `sudo apt update && sudo apt upgrade`; `docker compose pull && docker
compose up -d` per compose dir; `wsl --update` from PowerShell; Windows reboot on your
  schedule after Patch Tuesday.
- **Disk:** `docker system prune` after a few image rebuilds.
- **Next app on the box:** own repo under `~/apps/<app>`, own deploy dir + postgres, next
  host port (8124…), join `agents-shared` if it traces, `tailscale serve --bg
--https=<8446…>`, ACL update, own Langfuse project.
