# Migration — LangGraph Cloud + LangSmith → Self-Hosted Lite + Langfuse

Replaces the hosted LangGraph Cloud deployment with a self-hosted LangGraph server, and
LangSmith tracing with Langfuse. Supersedes steps 5 and 6 of
[RENAME-MIGRATION.md](RENAME-MIGRATION.md).

Read the auth section first — it is the part that changes the app's architecture, not just
its config.

---

## 1. Authentication — the blocking design decision

**Custom auth is not available on Self-Hosted Lite.** It is restricted to Managed Cloud and
Enterprise self-hosted plans; a Lite deployment that declares an `auth` block in
`langgraph.json` fails with `ValueError: Custom authentication is only available in Managed
Cloud or Enterprise` ([langgraph#5390](https://github.com/langchain-ai/langgraph/issues/5390)).

This invalidates the approach previously recommended for getting the platform key out of the
mobile client. The remaining option is better anyway:

**Put your own thin HTTP layer in front of the LangGraph server.**

```
mobile app ──Google access token──▶ your proxy ──▶ LangGraph server (private)
                                        │
                                        └─ validates token, derives thread ID,
                                           injects config.configurable.access_token
```

- The LangGraph server binds to localhost or a private network. It is **never** exposed
  publicly.
- The proxy is the only public surface. It validates the caller's Google access token and
  forwards the request.
- The mobile client ships **no** API key at all — only the Google token it already holds.
  `x-api-key` disappears from `mobile/src/services/langgraph.ts:335`, and
  `EXPO_PUBLIC_LANGGRAPH_API_KEY` is deleted from `mobile/.env` and `.env.example`.

The validation logic already exists and does not need rewriting — `backend/src/utils/auth.ts`
does tokeninfo validation and thread authorization today, and
`backend/src/utils/thread.ts` derives the thread ID. The proxy reuses both.

> **Do not skip this by exposing the Lite server with a single shared API key baked into the
> app.** That is precisely the pattern that made the current LangSmith token extractable
> from the JS bundle. Verify what auth, if any, Lite gives you out of the box — but plan for
> none.

## 2. The LangSmith dependency does not fully go away

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

## 3. Langfuse wiring

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

`backend/src/agent.ts:122` is currently `export const graph = workflow.compile();` — this is
a one-line change plus the handler construction. Add `langfuse-langchain` to
`backend/package.json`.

To attach `thread_id` / user identity to Langfuse sessions, subclass the handler and read
them from the metadata on the first `on_chain_start` event. That is the documented workaround
for server-executed graphs.

## 4. Env var changes

`backend/.env.example` — remove:

```
LANGSMITH_TRACING=true
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_PROJECT="aisist-v1"
```

Keep `LANGSMITH_API_KEY` (license verification, §2), and add:

```
LANGGRAPH_CLOUD_LICENSE_KEY=
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_HOST=          # your self-hosted Langfuse, or https://cloud.langfuse.com
```

Set `LANGSMITH_TRACING=false` explicitly so the built-in LangChain tracer stays off — it is
env-driven with no code references today, so nothing else needs touching to disable it.

`mobile/.env.example` — delete `EXPO_PUBLIC_LANGGRAPH_API_KEY` entirely and repoint
`EXPO_PUBLIC_LANGGRAPH_API_URL` at the proxy.

## 5. Sequence

1. Stand up the self-hosted LangGraph server locally; confirm it starts (license check
   passes) and `backend/src/agent.ts`'s graph is reachable.
2. Wire Langfuse; confirm traces arrive.
3. Build the proxy; confirm a Google access token authenticates and an invalid one is
   rejected.
4. Update `mobile/src/services/langgraph.ts` to drop `x-api-key` and point at the proxy.
5. Rebuild the app. Confirm end-to-end, then decommission the LangGraph Cloud deployment.
6. Only then revoke the old LangSmith token (§6 of the security notes) — it is still what
   the current deployment runs on.

## 6. Security cleanup — reduced urgency

The `lsv2_pt_…` token in the old build was **never distributed**. There is no TestFlight
build of this app; the only on-device copy is on the developer's own phone, and the only
readable copies are 42 files across two Xcode DerivedData trees on the developer's Mac.
Zero third-party exposure.

That makes rotation ordinary hygiene rather than incident response — do it at the end of the
sequence above, not before, since the current deployment still depends on it. Then:

```bash
rm -rf ~/Library/Developer/Xcode/DerivedData/Troli-ghlpiihpfixhffgejjoboaucrarh
rm -rf ~/Library/Developer/Xcode/DerivedData/Aisist-dkerlysmrrzteihbquxdpylvxclf
```

The architectural fix in §1 is what actually matters, and the self-hosting move is what makes
it achievable.

## Open questions

- What hosts the self-hosted server, and how does the phone reach it (public TLS endpoint,
  Tailscale, LAN-only)? This determines how exposed the proxy is and whether it needs rate
  limiting.
- Langfuse Cloud or self-hosted Langfuse? Affects `LANGFUSE_HOST` and whether there is a
  second service to operate.
- Is the proxy a separate small service, or does it live in this repo as a third workspace
  package? The latter keeps `backend/src/utils/auth.ts` reuse trivial.
