# LangGraph Cloud Deploy

This is the Phase 1 cloud rollout path for the `backend` LangGraph project and the matching mobile env wiring.

## Current CLI Reality

The repo currently pins `@langchain/langgraph-cli@1.2.5`. That CLI exposes `dev`, `build`, `up`, and `dockerfile`. It does **not** expose a `deploy` command, so the old `npx @langchain/langgraph-cli deploy` instruction is stale for this repo state.

Use the LangGraph Cloud dashboard or GitHub integration for the actual hosted deployment, and use the repo scripts here for local validation plus post-deploy verification.

## Prerequisites

- `backend/.env` populated with `GOOGLE_API_KEY`, `LANGSMITH_API_KEY`, `LANGSMITH_TRACING=true`, and `LANGSMITH_PROJECT=aisist-v1`
- `pnpm install`
- A LangGraph Cloud workspace with permission to create an API key
- A Google access token for a test account that is also allowed through the Aisist OAuth consent screen

## Pre-Deploy Checks

Run these before pushing a deploy:

```bash
pnpm --filter @aisist/backend typecheck
pnpm --filter @aisist/backend dev
```

The backend project definition lives at `backend/langgraph.json`, and the graph name is `agent`. The mobile client defaults to `assistant_id=agent`, so a standard deploy does not need an override.

## Cloud Deploy

1. Deploy the `backend` LangGraph project from `backend/langgraph.json` through LangGraph Cloud.
2. After the deployment finishes, copy the deployment base URL.
3. Create a LangGraph Cloud API key for the deployment.
4. Populate `mobile/.env`:

```bash
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=<your-ios-client-id>
EXPO_PUBLIC_LANGGRAPH_API_URL=<your-langgraph-cloud-url>
EXPO_PUBLIC_LANGGRAPH_API_KEY=<your-langgraph-cloud-api-key>
EXPO_PUBLIC_LANGGRAPH_ASSISTANT_ID=agent
```

Leave `EXPO_PUBLIC_LANGGRAPH_ASSISTANT_ID` as `agent` unless your cloud deployment uses a different assistant ID.

## Post-Deploy Verification

Run the cloud verification script from the backend package:

```bash
LANGGRAPH_API_URL=<your-langgraph-cloud-url> \
LANGGRAPH_API_KEY=<your-langgraph-cloud-api-key> \
GOOGLE_ACCESS_TOKEN=<google-access-token> \
GOOGLE_ACCOUNT_EMAIL=<test-user-email> \
pnpm --filter @aisist/backend run verify:cloud
```

Optional overrides:

```bash
LANGGRAPH_ASSISTANT_ID=<assistant-id-if-not-agent>
LANGGRAPH_THREAD_ID=<specific-thread-id>
LANGGRAPH_TEST_MESSAGE="Say hello in one short sentence."
LANGGRAPH_TIMEZONE=America/Detroit
```

Success output includes:

- `assistant_id=...`
- `thread_id=...`
- `thread_status=...`
- `assistant_text=...`

That confirms:

- thread create works with `if_exists: "do_nothing"`
- `POST /threads/{id}/runs/stream` returns SSE
- the deployed graph can validate the Google token and produce assistant output

## Mobile Smoke Test

After the cloud verification script passes:

```bash
pnpm --filter @aisist/mobile start
```

Sign in on the iOS device, send one short message, kill the app, reopen it, and confirm the conversation hydrates from the same thread.
