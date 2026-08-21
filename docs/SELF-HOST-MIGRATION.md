# Migration — LangGraph Cloud + LangSmith → Self-Hosted Lite + Langfuse

Replaces the hosted LangGraph Cloud deployment with a self-hosted LangGraph server, and
LangSmith tracing with Langfuse. Supersedes steps 5 and 6 of
[RENAME-MIGRATION.md](RENAME-MIGRATION.md).

Not started. §0 and §1 are the orientation; read §2 before designing anything.

---

## 0. Where things stand

- The Troli → Aisist rename is **merged** (`7e3153e`, PR #11). Sign-in is verified working on
  device against the updated Google OAuth client.
- The app currently runs on **LangGraph Cloud** at `https://troli-<hash>.us.langgraph.app`,
  with the mobile client authenticating via an `x-api-key` header holding a LangSmith
  personal token.
- `pnpm -r run typecheck` is clean; 121 backend (vitest) and 100 mobile (jest) tests pass.
- Nothing in this document has been implemented.

## 1. Current architecture

The mobile client talks **directly** to LangGraph Cloud. There is no server of ours in the
path. `mobile/src/services/langgraph.ts` hand-rolls the HTTP calls (no
`@langchain/langgraph-sdk` in either workspace package) and hits four endpoints:

| Endpoint                    | Method | Used for                   | Enters the graph? |
| --------------------------- | ------ | -------------------------- | ----------------- |
| `/threads`                  | POST   | bootstrap on first sign-in | No                |
| `/threads/{id}`             | GET    | hydrate on launch          | No                |
| `/threads/{id}/state`       | GET    | load conversation history  | No                |
| `/threads/{id}/runs/stream` | POST   | send a message / resume    | **Yes** (SSE)     |

Every call carries `x-api-key: <LangSmith token>` (`mobile/src/services/langgraph.ts:335`).
That single shared key is the _only_ thing gating all four.

**How the Google token flows.** The client puts it in the request body, not a header —
`config.configurable.access_token`, built in `streamRun` and `resumeRun`
(`mobile/src/services/langgraph.ts:180` and `:204`). The graph reads it back out via
`backend/src/utils/tool-config.ts:9` to authorize Google API calls.

**Where auth runs today.** Inside the graph, in `preprocessNode`
(`backend/src/agent.ts:80-81`):

```ts
const { email } = await validateGoogleToken(config);
verifyThreadAuthorization(config, email);
```

Both take a `LangGraphRunnableConfig` and read from `config.configurable` — they are **not**
HTTP middleware and cannot be dropped into a proxy unchanged. Adapting them means either
constructing a synthetic config at the proxy or extracting the tokeninfo call out of
`validateGoogleToken`.

**The consequence, already documented in this repo.** Because validation only happens during
graph execution, the three non-run endpoints have no user-level auth at all. See
`docs/plans/phase-1.md:68-74`, which spells out the resulting privacy, integrity, and
cost-abuse exposure — including that thread IDs are `uuidv5(email, AISIST_NAMESPACE)` with
the namespace committed to this repo, so deriving another user's thread ID from their email
address is trivial.

On Cloud, `x-api-key` is what keeps that from being reachable. **Self-hosting removes that
gate.** Closing it is the point of §2, not a nice-to-have.

## 2. Authentication — the blocking design decision

**Custom auth is not available on Self-Hosted Lite.** It is restricted to Managed Cloud and
Enterprise self-hosted plans; a Lite deployment that declares an `auth` block in
`langgraph.json` fails with `ValueError: Custom authentication is only available in Managed
Cloud or Enterprise` ([langgraph#5390](https://github.com/langchain-ai/langgraph/issues/5390)).

So: **put a thin HTTP proxy in front of a private LangGraph server.**

```
mobile app ──Bearer <google token>──▶ proxy ──▶ LangGraph server (private)
                                        │
                                        ├─ validates the token (tokeninfo)
                                        ├─ derives thread ID from the email
                                        ├─ rejects mismatched thread IDs
                                        └─ rewrites config.configurable.access_token
```

- The LangGraph server binds to localhost or a private network. **Never** exposed publicly.
- The proxy is the only public surface. The mobile client ships **no** API key — only the
  Google token it already holds. `x-api-key` disappears from
  `mobile/src/services/langgraph.ts:335`, and `EXPO_PUBLIC_LANGGRAPH_API_KEY` is deleted
  from `mobile/.env` and `.env.example`.

### What the proxy must do per endpoint

All four require a valid Google access token. Beyond that:

- **`POST /threads`** — derive the thread ID from the validated email; reject any
  client-supplied ID that doesn't match.
- **`GET /threads/{id}`, `GET /threads/{id}/state`** — verify `{id}` equals
  `uuidv5(email, AISIST_NAMESPACE)`. This is the endpoint pair that is currently wide open;
  getting it wrong reintroduces the exact hole in `docs/plans/phase-1.md:71`.
- **`POST /threads/{id}/runs/stream`** — same thread check, plus **rewrite**
  `config.configurable.access_token` in the body to the token the proxy just validated.
  Do not pass the client's value through: forwarding it unchecked lets a caller authenticate
  to the proxy with one token and drive Google API calls with another. The graph's own
  `validateGoogleToken` still runs, so this endpoint is defence-in-depth — the other three
  are where the proxy is load-bearing.

**SSE passthrough is the hard part.** `/runs/stream` returns a Server-Sent Events stream that
the chat UI consumes incrementally (`mobile/src/services/sse.ts`, covered by
`mobile/src/services/__tests__/sse.test.ts`). The proxy must stream chunks through without
buffering the response — a naive read-then-return will appear to work and then break the
typing indicator and streamed replies.

> **Do not shortcut this by exposing the Lite server with a shared API key baked into the
> app.** That is the pattern that made the current LangSmith token extractable from the JS
> bundle. Verify what auth, if any, Lite gives you out of the box — but plan for none.

## 3. The LangSmith dependency does not fully go away

Self-Hosted Lite requires `LANGSMITH_API_KEY` **and** `LANGGRAPH_CLOUD_LICENSE_KEY` to
authenticate once at server startup, and needs egress to `https://beacon.langchain.com` for
license verification and usage reporting unless running air-gapped
([docs](https://docs.langchain.com/langsmith/deploy-standalone-server)). Failures surface as
[`INVALID_LICENSE`](https://langchain-ai.github.io/langgraph/troubleshooting/errors/INVALID_LICENSE/).

So the switch drops LangSmith as the _tracing_ backend, not as a dependency. The practical
difference that matters: that key now lives on **your server**, not in a mobile bundle.

Free tier is capped at 1M nodes executed. Confirm the current cap and whether a separate
license key is issued for Lite or the LangSmith key doubles as one — the docs conflate the
two and the naming changed when LangGraph Platform was rebranded to "LangSmith Deployment"
in late 2025.

## 4. Langfuse wiring

LangGraph Server invokes the graph itself, so you cannot pass callbacks at call time. Attach
the handler at **compile time** instead, where the server picks it up via `langgraph.json`
([langfuse#5158](https://github.com/orgs/langfuse/discussions/5158)):

```ts
// backend/src/agent.ts:122
import { CallbackHandler } from 'langfuse-langchain';

const langfuseHandler = new CallbackHandler({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_HOST,
});

export const graph = workflow
  .compile()
  .withConfig({ callbacks: [langfuseHandler] });
```

`backend/src/agent.ts:122` is currently `export const graph = workflow.compile();` — a
one-line change plus the handler construction. Add `langfuse-langchain` to
`backend/package.json`.

To attach `thread_id` / user identity to Langfuse sessions, subclass the handler and read
them from the metadata on the first `on_chain_start` event. That is the documented workaround
for server-executed graphs.

## 5. Env var changes

`backend/.env.example` — remove `LANGSMITH_TRACING`, `LANGSMITH_ENDPOINT`, and
`LANGSMITH_PROJECT`. Keep `LANGSMITH_API_KEY` (license verification, §3) and add:

```
LANGGRAPH_CLOUD_LICENSE_KEY=
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_HOST=          # your self-hosted Langfuse, or https://cloud.langfuse.com
```

Set `LANGSMITH_TRACING=false` explicitly so the built-in LangChain tracer stays off — it is
env-driven with no code references, so nothing else needs touching to disable it.

`mobile/.env.example` — delete `EXPO_PUBLIC_LANGGRAPH_API_KEY` and repoint
`EXPO_PUBLIC_LANGGRAPH_API_URL` at the proxy.

## 6. Collateral this invalidates

- **`docs/DEPLOY.md`** documents the LangGraph Cloud rollout end to end. Rewrite for the
  self-hosted path or retire it.
- **`backend/scripts/verify-langgraph-cloud.mjs`** is a Cloud-specific smoke test — it reads
  `LANGGRAPH_API_URL` + `LANGGRAPH_API_KEY` and drives a real run. Repoint it at the proxy
  (dropping the API key, adding a bearer token) or replace it. It is wired to
  `pnpm --filter @aisist/backend run verify:cloud`, referenced from `docs/DEPLOY.md`.
- **`docs/TRD.md`** describes the direct client-to-Cloud architecture and the
  client-to-backend auth model. Both change.
- **`docs/plans/phase-1.md:68-74`** documents the shared-key exposure as accepted risk. Once
  the proxy lands, that section should record it as closed.
- **Tests:** `backend/src/utils/__tests__/auth.test.ts` (12 tests across
  `validateGoogleToken` / `verifyThreadAuthorization`) will need updating if those signatures
  change to serve the proxy. `mobile/src/services/__tests__/langgraph.test.ts` asserts the
  `x-api-key` header.

## 7. Sequence

1. Stand up the self-hosted LangGraph server locally — `langgraph build` / `langgraph up`
   from `backend/langgraph.json` (graph name `agent`, `node_version` 22). Confirm the license
   check passes and the graph is reachable. **This step is unresearched; expect it to be the
   slowest.**
2. Wire Langfuse (§4); confirm traces arrive.
3. Build the proxy (§2); confirm a valid Google token authenticates, an invalid one is
   rejected, another user's thread ID is rejected, and SSE streams through incrementally.
4. Update `mobile/src/services/langgraph.ts` — drop `x-api-key`, point at the proxy.
5. Rebuild the app, verify end to end, then decommission the LangGraph Cloud deployment.
6. Only then revoke the old LangSmith token (§8) — the Cloud deployment still runs on it.

## 8. Security cleanup — reduced urgency

The `lsv2_pt_…` token in the old build was **never distributed**. There is no TestFlight
build of this app; the only on-device copy is on the developer's own phone, and the only
readable copies are 42 files across two Xcode DerivedData trees on the developer's Mac.
Zero third-party exposure.

That makes rotation ordinary hygiene rather than incident response — do it at the end of §7,
not before. Then:

```bash
rm -rf ~/Library/Developer/Xcode/DerivedData/Troli-ghlpiihpfixhffgejjoboaucrarh
rm -rf ~/Library/Developer/Xcode/DerivedData/Aisist-dkerlysmrrzteihbquxdpylvxclf
```

The architectural fix in §2 is what actually matters, and self-hosting is what makes it
achievable.

## Open questions

These block implementation and need a human answer.

- **What hosts the server, and how does the phone reach the proxy** — public TLS endpoint,
  Tailscale, or LAN-only? Determines how exposed the proxy is and whether it needs rate
  limiting (see the cost-abuse item in `docs/plans/phase-1.md:72`).
- **Langfuse Cloud or self-hosted Langfuse?** Affects `LANGFUSE_HOST` and whether there is a
  second service to operate.
- **Is the proxy a third workspace package in this repo, or a separate service?** In-repo
  makes sharing `AISIST_NAMESPACE` and the auth helpers straightforward; separate keeps the
  deployable smaller.
- **Does `validateGoogleToken` get refactored to take a raw token** instead of a
  `LangGraphRunnableConfig`, so both the graph and the proxy can call it? That is the
  cleanest reuse, but it touches `backend/src/agent.ts:80` and its tests.
