# Task: Expand Phase 1 (Walking Skeleton) into a detailed implementation plan

## Problem Statement

Phase 1 in `docs/BUILD.md` describes the Walking Skeleton at a high level — auth, thread bootstrap, chat UI, bare agent, conversation model, wiring, deploy, tests. It needs to be expanded into a concrete, subtask-level plan with specific files, APIs, data flows, and acceptance criteria so it can be delegated for execution.

The goal is a fully detailed plan that someone can pick up and implement without needing to cross-reference PRD/TRD for implementation details.

## Relevant Files

**Docs (read-only reference):**

- `docs/PRD.md` — product requirements, scopes, constraints
- `docs/TRD.md` — architecture, API contracts, state model, system prompt template
- `docs/BUILD.md` — current Phase 1 description (to be expanded)
- `docs/SETUP.md` — GCP/LangSmith setup checklist

**Backend (to be built in Phase 1):**

- `backend/src/agent.ts` — bare skeleton exists, needs: LLM call, system prompt, message preprocessing
- `backend/src/` — will need new files for: prompt template, auth validation utils, message windowing utils, thread ID utils (no custom HTTP server — LangGraph Cloud provides the API layer)
- `backend/langgraph.json` — exists, no changes needed

**Mobile (to be built in Phase 1):**

- `mobile/App.tsx` — boilerplate exists, needs full rewrite for navigation + auth
- `mobile/` — will need new files for: auth store, chat screen, SSE client, components

## Patterns & Conventions Observed

- **Monorepo:** pnpm workspaces, `@aisist/backend` and `@aisist/mobile` packages
- **TypeScript strict mode** in both packages
- **Backend:** LangGraph.js `StateGraph(MessagesAnnotation)`, Zod for validation, LangGraph Cloud hosting
- **Mobile:** Expo 56, Zustand for state, `expo-auth-session` for OAuth, `expo-secure-store` for tokens
- **Thread ID:** Deterministic UUID v5 from email — same user always gets same thread (see Thread ID section below)
- **Token flow:** Client holds Google tokens, sends access token per request, backend validates via `tokeninfo`
- **SSE:** Backend streams agent response tokens; client renders incrementally
- **Conversation model:** All messages timestamped; preprocessing node filters to 7-day window + 200-message cap before LLM
- **HITL:** Not needed in Phase 1 (no write tools), but conversation model should be ready for it
- **System prompt:** Dynamic — injects current date, timezone, time per request

## Constraints & Risks

1. **LangGraph Cloud API surface:** Thread/run endpoints are provided by LangGraph Cloud — backend doesn't need custom HTTP server. The agent graph is deployed and LangGraph Cloud handles `/threads`, `/runs`, SSE streaming. Mobile hits LangGraph Cloud directly (or via its SDK).
2. **No custom backend server needed in Phase 1:** LangGraph Cloud provides the HTTP API. Backend code is just the graph definition deployed to LangGraph Cloud.
3. **Google OAuth:** Phase 1 targets iOS physical device only (dev client build). `expo-auth-session` opens the system browser for the Google consent screen and redirects back via the app scheme (`com.aisist.app`). No Simulator, Expo Go, or Android support needed in Phase 1.
4. **SSE on React Native:** `EventSource` API is limited in RN. May need polyfill or manual `fetch` with `ReadableStream`.
5. **Token refresh race condition:** Multiple concurrent requests during refresh need mutex — the TRD specifies a promise-based mutex pattern.
6. **LangGraph Cloud deployment:** Requires `langgraph-cli` or GitHub integration. First deploy is a risk point.
7. **Thread hydration on app launch:** Need to handle case where thread doesn't exist yet (first login) vs already exists (returning user).

## Open Questions

1. **SSE wire format:** The exact event names and data shapes from LangGraph Cloud's streaming endpoint must be verified at implementation time by running the agent locally (`langgraph dev`) and inspecting the output. Do not hardcode from docs or this plan — test against the real API.
2. **React Native streaming compatibility:** `fetch` + `ReadableStream` in Hermes (RN's JS engine) may have limitations for SSE parsing. If streaming doesn't work reliably, fall back to a polyfill like `react-native-sse` or `event-source-polyfill`. **This cannot be verified until Subtask 5** — the mobile app runs on a physical device that cannot reach the local `langgraph dev` server, so the SSE parser is only tested in the real RN/Hermes runtime after cloud deploy. Treat first on-device run after Subtask 5 as the verification point; budget time for a potential polyfill swap.

## Plan

### Approach

Expand the Phase 1 section of `docs/BUILD.md` into 6 subtasks, each producing a demoable increment. Mobile talks directly to LangGraph Cloud (no proxy server) — accepted risk for v1.0 closed beta (see mitigations in API layer decision). Google access token passed via `config.configurable` per-run, not persisted to checkpoints. During development, use `langgraph dev` as the local backend — cloud deployment (Subtask 5) happens after the graph and chat UI are working locally.

### API layer decision

Mobile talks directly to LangGraph Cloud. LangGraph Cloud API key embedded in mobile app. Accepted risk for v1.0 (100 test users, closed beta). Introduce a proxy server before public launch.

**Known limitations — accepted for closed beta:**

The embedded API key is the sole credential for all LangGraph Cloud operations. A tester who extracts it can:

1. **Privacy:** Read any user's thread (derive thread ID from email via the extractable `AISIST_NAMESPACE`, then call `GET /threads/{id}/state`). Conversation text only — no tokens or API data in thread state.
2. **Integrity:** Create arbitrary threads or inject messages into other users' threads via `POST /threads/{id}/runs/stream`.
3. **Cost abuse:** Execute unbounded runs against the Gemini backend, generating LLM compute costs with no per-user rate limit.

Google token validation only runs inside graph execution (`POST /threads/{id}/runs`), so thread create/read/status endpoints have no user-level auth.

**Phase 1 mitigations (required before distributing to testers):**

- Set a monthly spend cap or run-count quota in LangGraph Cloud (or the underlying Gemini API key) to bound cost exposure.
- Monitor run volume and per-thread activity via LangSmith — alert on anomalous patterns (e.g., >50 runs/day from a single thread, runs on threads with no prior history).
- Document a key rotation procedure: if abuse is detected, rotate the LangGraph Cloud API key, push a new mobile build, and invalidate the old key. Ensure the rotation can be executed within 1 business day.
- Distribute only via TestFlight/EAS to known testers — do not publish the API key in any public artifact.

**Before public launch:** introduce a proxy server that validates the Google access token before forwarding thread operations to LangGraph Cloud. This eliminates all three risk categories.

### Thread ID format

LangGraph Cloud requires `thread_id` to be a valid UUID (`string<uuid>`). The TRD's `aisist-{sha256(email)}` format is not compatible. Use **UUID v5** (name-based, deterministic) with a fixed namespace:

```typescript
import { v5 as uuidv5 } from 'uuid';

const AISIST_NAMESPACE = 'e587b8a0-3e1a-4c5d-9f2b-1a8c4d6e7f90'; // fixed, arbitrary
function generateThreadId(email: string): string {
  return uuidv5(email, AISIST_NAMESPACE);
}
```

Same email always produces the same UUID, enabling reconnection across reinstalls/devices. Add `uuid` package (+ `@types/uuid` devDep) to both `mobile` and `backend`.

**Note:** This supersedes the `aisist-{sha256(email)}` format described in `docs/TRD.md` and `docs/BUILD.md`. Those docs should be updated as part of implementation to reflect the UUID v5 format.

### LangGraph Cloud API contracts

The mobile client communicates with LangGraph Cloud via its REST API. Use `fetch` with a custom SSE parser — `@langchain/langgraph-sdk` is a Node.js SDK and may not work in React Native (relies on `node:stream`, `node:http`, etc.).

**Create thread:**

```
POST {LANGGRAPH_API_URL}/threads
Headers: { "x-api-key": LANGGRAPH_API_KEY, "Content-Type": "application/json" }
Body: { "thread_id": "<uuid-v5-from-email>", "if_exists": "do_nothing" }
Response: 200 with thread object (returns existing thread if already created — no error handling needed)
```

**Get thread (status check):**

```
GET {LANGGRAPH_API_URL}/threads/{thread_id}
Headers: { "x-api-key": LANGGRAPH_API_KEY }
Response: { "thread_id": "...", "status": "idle"|"busy"|"interrupted"|"error", "created_at": "...", ... }
```

Returns 404 if thread doesn't exist. The `status` field indicates whether a run is active.

**Get thread state (hydration):**

```
GET {LANGGRAPH_API_URL}/threads/{thread_id}/state
Headers: { "x-api-key": LANGGRAPH_API_KEY }
Response: { "values": { "messages": [...] }, "next": [...], "tasks": [...], "metadata": {} }
```

Returns 200 with state or 422 on validation error. Does **not** return 404 for missing threads and does **not** include a `status` field — use `GET /threads/{id}` for that.

**Bootstrap flow:** Always create-then-hydrate. Call `POST /threads` with `if_exists: "do_nothing"` first (idempotent — returns existing thread if already created), then `GET /threads/{id}` to check status, then `GET /threads/{id}/state` to hydrate messages. This avoids branching on error codes for missing threads.

**Stream a run (send message):**

```
POST {LANGGRAPH_API_URL}/threads/{thread_id}/runs/stream
Headers: { "x-api-key": LANGGRAPH_API_KEY, "Content-Type": "application/json" }
Body: {
  "assistant_id": "agent",
  "input": { "messages": [{ "role": "human", "content": "user text" }] },
  "config": {
    "configurable": {
      "access_token": "Google OAuth access token",
      "timezone": "America/Chicago"
    }
  },
  "stream_mode": ["messages"]
}
Response: SSE stream
```

**SSE parsing:** Build a lightweight custom parser using `fetch` + `ReadableStream` (RN-compatible). The exact SSE event names and data shapes depend on the LangGraph Cloud streaming protocol version — **do not hardcode event names from this plan**. At implementation time, verify the actual wire format by:

1. Running the agent locally via `langgraph dev` and inspecting the SSE output with curl
2. Referencing the LangGraph Cloud streaming docs or SDK source for the current protocol
3. Building the parser to handle the observed format

The parser should: read the response stream line-by-line, split on `event:` and `data:` fields, JSON-parse data payloads, and yield parsed events to the caller.

**Disconnect handling:** Deferred to Phase 5. For Phase 1, use the server's default `on_disconnect` behavior. Phase 5 should specify an explicit `on_disconnect` policy (e.g., `"cancel"`) and handle client-side reconnection/rehydration.

### Message timestamping flow

All messages must have `additional_kwargs.timestamp` for the windowing logic to work. The flow:

1. **User messages:** Stamped by the `preprocess` node when they arrive. The preprocess node finds the incoming human message by selecting the last message with `role === "human"` that lacks `additional_kwargs.timestamp`, and adds `additional_kwargs.timestamp = Date.now()`. This is idempotent and role-aware — safe under hydration, retries, or interrupted runs.
2. **Agent (AI) messages:** Stamped by the `agent` node immediately after the LLM responds, before returning the AI message to state. This ensures the timestamp reflects when the response was actually generated, not when the next user message arrives. Without this, an AI reply from day 1 followed up on day 8 would get a day-8 timestamp, making the 7-day window inaccurate.
3. **Windowing:** After stamping, `windowMessages()` filters to 7-day window + 200-message cap. Messages without timestamps are dropped (defensive — shouldn't happen after stamping).
4. **Phase 1 starts fresh:** No existing messages to migrate. All messages will be stamped from the start.

### Required dependencies (not yet installed)

**Mobile — navigation packages (Subtask 2):**

- `@react-navigation/native`
- `@react-navigation/native-stack`
- `react-native-screens`
- `react-native-safe-area-context`

**Mobile — thread ID (Subtask 3):**

- `uuid` + `@types/uuid` (devDependency)

**Backend — thread ID + test runner (Subtask 1 + 5):**

- `uuid` + `@types/uuid` (devDependency)
- `vitest` (devDependency)

**Mobile — test runner (Subtask 5):**

- `jest-expo` (devDependency) — Expo's Jest preset
- `@testing-library/react-native` (devDependency)
- Add `"test": "jest"` script and Jest config (`preset: "jest-expo"`) to `mobile/package.json`

**Mobile env vars (Subtask 2 + 3):**

- `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` — iOS OAuth client ID from GCP (matches existing `.env.example` and `docs/SETUP.md`)
- `EXPO_PUBLIC_LANGGRAPH_API_URL` — LangGraph Cloud deployment URL
- `EXPO_PUBLIC_LANGGRAPH_API_KEY` — LangGraph Cloud API key

**Backend env vars (Subtask 1):**

- `GOOGLE_API_KEY` — Gemini API key (see `docs/SETUP.md` section 5)
- `LANGSMITH_API_KEY` — LangSmith API key (see `docs/SETUP.md` section 6)
- `LANGSMITH_TRACING=true` — already in `backend/.env.example`
- `LANGSMITH_PROJECT=aisist-v1` — already in `backend/.env.example`

**OAuth scopes (Phase 1 only):**

- Request only `openid email profile` in Phase 1. These are non-sensitive scopes — no compliance burden, no Google verification required.
- Do **not** request Calendar, Tasks, or Gmail scopes until the phase that uses them. `gmail.readonly` is a restricted scope — it works fine in test mode (100 users, unverified app warning), but requires a CASA Tier 2 security assessment for public App Store release (PRD section 4, section 13). Requesting it in Phase 1 adds no compliance burden today, but there's no functional benefit either — defer to keep the scope surface minimal and avoid user-facing permission prompts for features that don't exist yet.
- When Phase 2+ ships tool integrations, use incremental authorization to request additional scopes. `expo-auth-session` supports this — the user sees a re-consent prompt for only the new scopes. This is standard OAuth behavior, not a migration.
- Note: this supersedes the TRD's scope list (section 2.2), which uses the shorthand `userinfo.email` instead of OIDC `openid email profile`. Use the full URL forms listed here.

## Subtasks

### Subtask 0 (gating spike): Verify `thread_id` access path in LangGraph config

Before any backend subtask begins, confirm how to read the current thread's ID from within a graph node. The auth design (Subtask 4) assumes `config.configurable.thread_id` is injected by LangGraph Cloud at runtime, but this is unverified.

**Steps:**

1. Run `langgraph dev` with the existing bare `agent.ts` stub.
2. In the agent node, log the full `config` object (`console.log(JSON.stringify(config, null, 2))`).
3. Send a test run via curl to a specific thread ID and inspect the log output.
4. Confirm the exact path where `thread_id` appears (expected: `config.configurable.thread_id`). If it's elsewhere (e.g., `config.metadata.thread_id`), document the correct path.

**If the assumption is wrong:** Update the auth design in Subtask 4 and the `verifyThreadAuthorization()` spec to use the correct access path before starting Subtask 1.

**Verified result (2026-06-09):** `thread_id` is available at `config.configurable.thread_id` during node execution. It is also mirrored at `config.metadata.thread_id` and `config.executionInfo.threadId` in local `langgraph dev`, but Subtask 4 should read `config.configurable.thread_id` as the primary access path inside graph code.

**Acceptance criteria:** The exact `config` path for `thread_id` is documented in this task file (update the Subtask 4 description with the verified path). Takes <30 minutes.

### Subtask 1: Backend — Agent graph with system prompt and message preprocessing

- **Description:** Replace bare `agent.ts` stub with working agent: LLM call (Gemini 2.5 Flash-Lite), dynamic system prompt, message preprocessing node (timestamps, 7-day window, 200-message cap).
- **Files:**
  - `backend/src/agent.ts` — graph: `preprocess` → `agent` nodes
  - `backend/src/prompt.ts` — system prompt template with `{current_date}`, `{timezone}`, `{current_time}`
  - `backend/src/utils/window-messages.ts` — `windowMessages()`: filter by timestamp within 7-day cutoff, slice to last 200
  - `backend/src/utils/timestamp.ts` — stamp messages with `additional_kwargs.timestamp`
- **Acceptance criteria:** `pnpm --filter @aisist/backend typecheck` passes. Agent responds to messages in LangGraph Studio via `npx @langchain/langgraph-cli dev`.
- **Scope:** Medium (4 files)

### Subtask 2: Mobile — Auth flow (OAuth + token management + sign-in screen)

- **Description:** Google OAuth with PKCE via `expo-auth-session`, token storage in SecureStore, silent refresh with 5-min buffer and promise-based mutex, sign-in screen. Install navigation packages first: `@react-navigation/native`, `@react-navigation/native-stack`, `react-native-screens`, `react-native-safe-area-context`.
- **Platform scope:** Phase 1 targets **iOS physical device only** (dev client build via EAS or Xcode). No Simulator, no Expo Go, no Android. Android config exists in `app.json` but is out of scope — no client ID, package signing, or redirect URI setup needed yet.
- **Redirect URI:** Do not pass `redirectUri` to `Google.useAuthRequest()`. The Google provider automatically constructs the correct redirect URI from the reversed iOS client ID scheme. Passing a custom `redirectUri` (e.g., via `AuthSession.makeRedirectUri()`) causes a `400 invalid_request` from Google because the app scheme doesn't match the iOS OAuth client's expected redirect.
- **OAuth config:** Use `Google.useAuthRequest()` from `expo-auth-session/providers/google` with `iosClientId` only. No `webClientId` needed — physical device builds use the native iOS OAuth client. Pass both `prompt: "consent"` and `access_type: "offline"` in the auth request extra params — both are required to guarantee a refresh token (see TRD section 2.2). `access_type: "offline"` tells Google to issue a refresh token; `prompt: "consent"` ensures it's returned even if the user previously granted access.
- **Auth failure handling:**
  - **No refresh token returned:** If `prompt: "consent"` is set and Google still doesn't return a refresh token, treat as a sign-in failure — clear any partial state, show an error, and let the user retry.
  - **Refresh fails (400/401):** The refresh token is revoked or expired. Clear all tokens from SecureStore, clear the chat store, and force the user back to the sign-in screen (forced re-auth).
  - **Refresh timeout:** Set a 5-second timeout on the refresh call. On timeout, treat as a transient failure — retry once, then force re-auth if the retry also fails.
  - **Token exchange failure:** Show an error on the sign-in screen with a retry option. Do not store partial tokens.
- **Files:**
  - `mobile/src/store/auth.ts` — Zustand store (accessToken, refreshToken, expiry, email, signIn/signOut/getValidToken). Sign-out must clear both auth tokens (SecureStore) and chat store (messages, threadId). No local message persistence — the server is the source of truth. On next sign-in, chat is hydrated from the server, satisfying PRD 9.3 (history retained on server, available when the same user signs back in) while preventing cross-user leakage on shared devices.
  - `mobile/src/utils/auth.ts` — OAuth helpers (token exchange, refresh, userinfo fetch)
  - `mobile/src/screens/SignInScreen.tsx` — "Sign in with Google" button
  - `mobile/src/navigation/RootNavigator.tsx` — conditional auth/chat routing
  - `mobile/App.tsx` — navigation wrapper + auth init
  - `mobile/.env.example` — add `EXPO_PUBLIC_LANGGRAPH_API_URL`, `EXPO_PUBLIC_LANGGRAPH_API_KEY` (keep existing `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`)
- **Acceptance criteria:** User signs in on iOS physical device, tokens stored in SecureStore, session survives app restart. Refresh failure forces re-auth. `pnpm --filter @aisist/mobile typecheck` passes.
- **Scope:** Medium (6 files)

### Subtask 3: Mobile — Chat UI + SSE streaming + end-to-end wiring

- **Description:** Chat screen with message list, text input, SSE streaming, thread bootstrap. The walking skeleton moment. Thread creation uses `if_exists: "do_nothing"` so the API returns the existing thread instead of erroring — no special error handling needed. Install `uuid`, `@types/uuid`. **Do not use `@langchain/langgraph-sdk`** — it's a Node.js SDK and may not work in React Native. Use `fetch` + custom SSE parser instead.
- **Development backend:** During development, verify the chat client code compiles and the SSE parser works by running the backend locally via `langgraph dev` and testing with curl or LangGraph Studio on the laptop. The mobile app cannot reach `localhost` from a physical device, so on-device testing is deferred until after Subtask 5 (cloud deploy). The `LANGGRAPH_API_URL` env var is only populated with the cloud URL after Subtask 5.
- **Files:**
  - `mobile/src/screens/ChatScreen.tsx` — FlatList messages, input bar, typing indicator, thread bootstrap on mount
  - `mobile/src/store/chat.ts` — Zustand store (messages, threadId, sendMessage, bootstrapThread, hydrateMessages)
  - `mobile/src/services/langgraph.ts` — LangGraph Cloud REST client using `fetch`. See "LangGraph Cloud API contracts" section for endpoints.
  - `mobile/src/services/sse.ts` — lightweight SSE parser (fetch + ReadableStream, RN-compatible). See "SSE parsing" notes in API contracts section — verify actual event format against the running API before hardcoding.
  - `mobile/src/utils/thread.ts` — `generateThreadId(email)` using UUID v5. See "Thread ID format" section above.
  - `mobile/src/components/MessageBubble.tsx` — chat bubble (user vs agent)
  - `mobile/src/components/TypingIndicator.tsx` — animated dots
  - `mobile/src/components/ChatInput.tsx` — text input + send button + disabled state
- **Concurrency:** LangGraph Cloud allows only one active run per thread. The client must handle two cases: (1) **Double-send:** disable the send button and input while a run is streaming; re-enable when the stream completes or errors. (2) **App reopen during active run:** the bootstrap flow (see "Bootstrap flow" in API contracts) calls `GET /threads/{id}` which returns `status: "idle"|"busy"|"interrupted"|"error"`. If status is `busy`, show a loading state and poll `GET /threads/{id}` (e.g., every 2s, max 30s). On resolution: if `idle`, hydrate messages via `GET /threads/{id}/state`. If `error`, hydrate whatever messages exist and allow the user to send a new message (the failed run doesn't block future runs). If polling times out (still `busy` after 30s), treat as error — hydrate and re-enable input. If `interrupted`, hydrate and re-enable (Phase 1 has no HITL, so this shouldn't occur but is safe to treat as idle).
- **Disconnect / ambiguous failure:** If the client disconnects after `POST /runs/stream` is accepted but before consuming the full response, the human message may already be committed to thread state. On next app open, the bootstrap hydration will show the actual thread state (including any committed messages and the agent's response if the run completed server-side). In Phase 1 this is sufficient — no write tools exist, so a duplicate human turn only produces a duplicate chat response. **Phase 2+ (with write tools) must add a client-side message ID or deduplication mechanism** to prevent duplicate tool executions from ambiguous retries.
- **Acceptance criteria:**
  - **Local (before Subtask 5):** `pnpm --filter @aisist/mobile typecheck` passes. Backend responds to curl / LangGraph Studio via `langgraph dev`. Mobile chat code compiles and is structurally complete — on-device testing blocked until cloud URL is available.
  - **Cloud (after Subtask 5):** Conversation persists across app restarts. Thread creation is idempotent via `if_exists: "do_nothing"`. Full round-trip on iOS physical device against the deployed backend.
- **Scope:** Large (8 files)

### Subtask 4: Backend — Auth validation + thread authorization

- **Description:** Preprocess node validates Google access token via tokeninfo endpoint, verifies thread ID matches UUID v5 derived from email. Subtask 0 verified that graph nodes receive the current thread ID at `config.configurable.thread_id`; use that path in `verifyThreadAuthorization()`. Install `uuid` + `@types/uuid`.
- **Tokeninfo failure handling:**
  - **Timeout:** `validateGoogleToken()` must set a 3-second timeout on the `fetch` call to `https://oauth2.googleapis.com/tokeninfo`. On timeout, return a retryable error to the client (the graph should not proceed to the LLM node).
  - **5xx from Google:** Treat as transient — return a retryable error. Do not reject the user's token.
  - **4xx from Google (400 invalid token, 401 expired):** Reject the request. Return an auth error that the mobile client can interpret as "force re-auth" (distinct from a retryable error).
  - **Missing `access_token` in config:** Reject immediately — do not call tokeninfo.
- **Files:**
  - `backend/src/utils/auth.ts` — `validateGoogleToken()`, `verifyThreadAuthorization()` (uses `generateThreadId(email)` with UUID v5)
  - `backend/src/utils/thread.ts` — `generateThreadId(email)` using UUID v5 with `AISIST_NAMESPACE` (same implementation as mobile)
  - `backend/src/agent.ts` — update preprocess node with auth validation
- **Acceptance criteria:** Invalid/expired tokens cause the graph to return an error (not an LLM response). Thread ID mismatch (email doesn't derive to the run's thread) rejected. Tokeninfo timeout returns retryable error. Valid requests proceed. Note: this only protects run execution (`POST /threads/{id}/runs`). Thread create/read endpoints remain gated by API key only — see "Known limitation" in the API layer decision section.
- **Scope:** Small (3 files)

### Subtask 5: Deploy to LangGraph Cloud

- **Description:** First deployment of the agent graph to LangGraph Cloud. This produces the `EXPO_PUBLIC_LANGGRAPH_API_URL` and `EXPO_PUBLIC_LANGGRAPH_API_KEY` that the mobile app needs for cloud operation. Subtask 3 can be developed and tested locally against `langgraph dev` before this subtask is complete — this subtask unlocks the cloud acceptance criteria (persistence across restarts, full device round-trip).
- **Steps:**
  1. Install `@langchain/langgraph-cli` globally or use `npx`
  2. Deploy via `npx @langchain/langgraph-cli deploy` (or connect via GitHub integration in the LangGraph Cloud dashboard)
  3. Note the deployment URL and create an API key in the LangGraph Cloud dashboard
  4. Add `EXPO_PUBLIC_LANGGRAPH_API_URL` and `EXPO_PUBLIC_LANGGRAPH_API_KEY` to `mobile/.env`
  5. Verify the `assistant_id` — by default, LangGraph Cloud uses the graph name from `langgraph.json` (which is `"agent"`, matching the run payload's `"assistant_id": "agent"`)
  6. Confirm end-to-end: `curl` a test run against the deployed endpoint and verify SSE response
- **Acceptance criteria:** Agent is deployed and reachable. `POST /threads/{id}/runs/stream` returns a valid SSE response with agent output. Mobile env vars are populated.
- **Scope:** Small (ops, no code changes)

### Subtask 6: Tests

- **Description:** Unit tests for critical Phase 1 paths. Install test runners: `vitest` for backend, `jest-expo` + `@testing-library/react-native` for mobile. Add `test` scripts to both `package.json` files.
- **Files:**
  - `backend/src/__tests__/agent.test.ts` — full graph pipeline (auth gating, preprocessing, agent node invocation, end-to-end message flow)
  - `backend/src/__tests__/prompt.test.ts` — system prompt builder (timezone normalization, date/time formatting, identity preamble, rules section)
  - `backend/src/utils/__tests__/auth.test.ts` — token validation (mock `fetch` to tokeninfo, email normalization, 5xx/timeout retryable errors), thread authorization (UUID v5 match/mismatch/missing), `isAisistAuthError` type guard
  - `backend/src/utils/__tests__/timestamp.test.ts` — `getMessageTimestamp` (valid, null, NaN, Infinity), `stampMessage` (explicit/default timestamp, preserves kwargs/content), `stampLatestHumanMessage` (last unstamped, skip stamped, no-op cases)
  - `backend/src/utils/__tests__/window-messages.test.ts` — windowing logic (7-day filter, 200-msg cap, missing timestamps)
  - `mobile/src/store/__tests__/auth.test.ts` — token refresh (< 5min trigger), mutex (concurrent refreshes), sign-out (clears SecureStore + chat store), initialize from storage, partial session cleanup, force-reauth on refresh failure, non-fatal refresh error
  - `mobile/src/store/__tests__/chat.test.ts` — bootstrap (success, loading state, error, missing email, error status), sendMessage (stream + hydrate, snapshots, error + re-hydrate, empty/whitespace/busy guards, auto-bootstrap), hydrateMessages, reset
  - `mobile/src/services/__tests__/sse.test.ts` — SSE parser handles chunked data, multi-line events, incomplete reads, malformed lines, `\r\n` endings, null body, multiple events per chunk
  - `mobile/src/services/__tests__/langgraph.test.ts` — thread bootstrap (create + poll busy→idle + hydrate), message assembly from streamed chunks, error responses (404, non-JSON, LangSmith config hint), message filtering (no role, empty text, fallback IDs), config validation helpers
  - `mobile/src/utils/__tests__/auth.test.ts` — direct tests for Google auth utilities: `buildSessionFromAuthResponse` (success, cancel/dismiss, exchange error, missing refresh token, userinfo failure, missing email), `refreshGoogleAccessToken` (success, preserved refresh token, 400/401 force-reauth, 5xx transient, missing access_token, timeout, network failure), error type guards
  - `backend/package.json` — add `vitest` devDep, `"test": "vitest run"` script
  - `mobile/package.json` — add `jest-expo` + `@testing-library/react-native` devDeps, `"test": "jest"` script, Jest config (`preset: "jest-expo"`)
- **Acceptance criteria:** `pnpm --filter @aisist/backend test` and `pnpm --filter @aisist/mobile test` pass. 53 backend tests, 68 mobile tests (121 total).
- **Scope:** Medium (12 files)
