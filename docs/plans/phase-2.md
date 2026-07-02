# Task: Implement Phase 2 — Calendar

## Problem Statement

The Phase 1 walking skeleton is complete: auth → chat → stream → display works end-to-end. But the agent has no tools — it can only chat. Phase 2 adds full Google Calendar CRUD and introduces the HITL (human-in-the-loop) interrupt/resume flow that update and delete operations require.

This means:

1. The backend agent graph needs to evolve from a simple preprocess→agent chain into a ReAct tool-calling loop
2. Five calendar tools need to be implemented against the Google Calendar API
3. A shared `fetchWithAuth` helper must handle all Google API calls
4. Write tools (`update_calendar_event`, `delete_calendar_event`) must use `interrupt()` for user approval
5. The mobile client must detect interrupts via post-stream thread state inspection, render approval cards inline, and resume the graph with the user's decision
6. On app reopen, pending interrupts must be re-rendered
7. OAuth scopes must be expanded to include `calendar.events.owned`

## Relevant Files

### Backend — will create or modify

- `backend/src/agent.ts` — Refactor graph: bind tools, add tool-calling loop, restructure state channels (see "State channel refactoring" below)
- `backend/src/tools/calendar.ts` — New: all 5 calendar tool definitions
- `backend/src/utils/google-api.ts` — New: `fetchWithAuth` shared helper
- `backend/src/__tests__/tools/calendar.test.ts` — New: tool unit tests
- `backend/src/utils/__tests__/google-api.test.ts` — New: fetchWithAuth tests
- `backend/src/__tests__/agent.test.ts` — Extend with tool-calling integration tests

### Mobile — will create or modify

- `mobile/src/utils/auth.ts` — Add `calendar.events.owned` to `GOOGLE_SCOPES`
- `mobile/src/store/auth.ts` — Detect scope mismatch on existing sessions, force re-auth when scopes expand
- `mobile/src/services/langgraph.ts` — Add post-stream interrupt detection via thread state inspection, add `resumeRun` function, extend hydration to extract interrupt payloads from thread state
- `mobile/src/store/chat.ts` — Extend `ChatMessage` type with interrupt payload, add pending approval state, add `resumeApproval` action
- `mobile/src/components/ApprovalCard.tsx` — New: inline approval card (Approve/Reject buttons)
- `mobile/src/components/MessageBubble.tsx` — Render approval cards for interrupt messages
- `mobile/src/screens/ChatScreen.tsx` — Handle interrupted thread status on bootstrap, disable input during pending approval

### Tests

- `backend/src/__tests__/tools/calendar.test.ts` — Tool unit tests with mocked Google API
- `backend/src/utils/__tests__/google-api.test.ts` — fetchWithAuth tests
- `backend/src/__tests__/agent.test.ts` — Extend with tool-calling integration tests

## Patterns & Conventions Observed

### Backend

- **Graph architecture**: Uses custom `StateGraph` with `AgentState` annotation (not `createReactAgent`). Two channels: `messages` (persisted, uses `messagesStateReducer`) and `llmInputMessages` (ephemeral, overwritten each run). Preprocess node handles auth + timestamping + windowing.
- **Auth flow**: Access token passed via `config.configurable.access_token` — never stored. Token validated against Google tokeninfo. Thread ID verified against UUIDv5 derived from email.
- **Error handling**: Custom `TroliAuthError` class with `code`, `retryable`, `status` fields.
- **Testing**: Vitest, `vi.mock()` for modules, `vi.spyOn(Date, 'now')` for time. Mocked LLM returns via `vi.fn()`.
- **Module resolution**: ESM with `.js` extensions in imports.
- **Model**: `ChatGoogleGenerativeAI` with `gemini-3.1-flash-lite`, `temperature: 0`.

### Mobile

- **State management**: Zustand stores with selective subscriptions. Actions defined inside `create()`.
- **SSE handling**: Custom parser in `services/sse.ts`. Events parsed in `streamRun()` — `onAssistantTextSnapshot` callback for streaming text, `onEvent` for raw events.
- **Message model**: `ChatMessage` type with `id`, `role`, `text`, `status?`, `timestamp?`. Streaming messages have `status: 'streaming'`.
- **UI patterns**: Warm earth-tone palette (#1f5c4a green, #f4f1ea cream, #fffdf8 white). `StyleSheet.create()`, `Pressable` with `pressed` opacity.
- **Thread ID**: Deterministic UUIDv5 from email using shared `TROLI_NAMESPACE` (both backend and mobile).

### LangGraph HITL conventions (from TRD)

- Write tools call `interrupt({ action, description, current, proposed })` before executing
- Decision comes back as `Command(resume="approve"|"reject")`
- Client sends resume via `POST /threads/{id}/runs/stream` with `command: { resume: "approve" }` (no `input`)
- Thread status becomes `interrupted` when waiting for approval

## Constraints & Risks

### 1. State channel refactoring (critical)

The current graph has two state channels:

- `messages`: full history, persisted by checkpointer, uses `messagesStateReducer`
- `llmInputMessages`: windowed subset, set once by `preprocess`, overwritten each run

**Problem:** In a tool-calling loop, the agent reads from `llmInputMessages`. When the agent makes a tool call, the tool call message and tool result are appended to `messages` by LangGraph's machinery. But `llmInputMessages` is never updated — so when the agent node runs again in the loop, it still sees the stale windowed messages without tool calls or results. The tool loop is structurally broken.

**Solution:** Remove `llmInputMessages`. Have `preprocess` replace `messages` with only the windowed subset (it already does `RemoveMessage({ id: REMOVE_ALL_MESSAGES }) + ...stampedMessages` — change to `...windowedMessages`). The agent reads from `messages` directly. Tool calls and results naturally append to `messages`, so subsequent agent iterations see them.

**Concern — history loss:** If `messages` only holds the windowed subset after preprocess, won't we lose old messages from the checkpointer? No. The checkpointer stores state at each checkpoint. The next run starts with the checkpointed state (which includes messages added after preprocess: tool calls, tool results, agent response, new user message). Preprocess then re-windows from whatever is in `messages` at that point. Messages older than 7 days naturally fall out of the window. The checkpointer's history of prior states preserves the full audit trail.

### 2. OAuth scope expansion (critical)

Current scopes (`mobile/src/utils/auth.ts:8-12`): `openid`, `userinfo.email`, `userinfo.profile`.
Missing: `https://www.googleapis.com/auth/calendar.events.owned`.

Without this scope, all calendar API calls will 403. Existing signed-in users must re-consent. Since the app already uses `prompt: 'consent'`, a sign-out/sign-in cycle works. The simplest approach: store the scopes that were used for the current session, and on app launch, if stored scopes don't include the new one, force sign-out with a clear message ("Troli now needs calendar access. Please sign in again.").

### 3. LangGraph `interrupt()` behavior

The `interrupt()` function checkpoints the graph and stops execution. The resume `Command` must reach the exact same tool node. Need to verify this works correctly with LangGraph Cloud deployment and SSE streaming.

### 4. Approval card data model

The current `ChatMessage` type has no provision for interrupt payloads:

```typescript
type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  status?: 'streaming';
  text: string;
  timestamp?: number | null;
};
```

Need to extend with a concrete shape for approval cards:

```typescript
type InterruptPayload = {
  action: string; // e.g. "update_calendar_event"
  description: string; // human-readable summary of proposed change
  current: unknown; // current state of the resource
  proposed: unknown; // proposed changes
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  status?: 'streaming' | 'pending_approval' | 'approved' | 'rejected';
  text: string;
  timestamp?: number | null;
  interrupt?: InterruptPayload; // present when status is pending_approval/approved/rejected
};
```

Hydration must extract interrupt payloads from thread state (`tasks` field in LangGraph state contains pending interrupts). On bootstrap, if thread status is `interrupted`, the last interrupt payload must be extracted and rendered as an approval card.

### 5. Idempotency for create operations

HITL tools (update/delete) are naturally idempotent — `interrupt()` checkpoints the graph, and resume replays from that checkpoint. A lost approve response leaves the thread in `interrupted` state; re-sending approve picks up cleanly.

`create_calendar_event` (no HITL) has a duplicate risk on ambiguous failures: if the agent creates the event server-side but the SSE stream disconnects before the client sees it, the user might retry and create a duplicate. For Phase 2, this is an accepted limitation — the next hydration will show the created event, and the user can see it was created. A dedup mechanism (client-side message IDs) is tracked for a future hardening pass.

### 6. Recurring event scope

`update_calendar_event` and `delete_calendar_event` need `recurringEventScope` parameter. The Google Calendar API uses different URL patterns for recurring events — single instance uses the instance ID, `thisAndFollowing`/`all` use the recurring event ID.

### 7. All-day events

Google Calendar API uses `start.date`/`end.date` (YYYY-MM-DD) for all-day events vs `start.dateTime`/`end.dateTime` for timed events. The create tool must handle both formats based on the parameters provided.

### 8. Token in tool context

The access token lives in `config.configurable.access_token`. Tools receive the LangGraph config and must extract the token from there to pass to `fetchWithAuth`.

## Resolved Questions

1. **Interrupt detection strategy**: Use post-stream detection, not in-stream parsing. After `streamRun()` completes (or on app reopen), check thread status and extract interrupt payload from thread state. This avoids coupling the SSE parser to interrupt-specific event shapes, eliminates the need for two detection mechanisms (in-stream vs reopen), and the extra HTTP roundtrip latency is negligible. The exact SSE event shape and `tasks` field structure are empirical questions — resolve by testing against `langgraph dev` during the first HITL subtask.

2. **History preservation after windowing**: Go with the single-channel refactor (remove `llmInputMessages`, window directly into `messages`). No v1.0 use case requires accessing old messages within a single run. Checkpointer history covers debugging needs. Simpler architecture wins.

## Additional Notes

Key files to read for planning: `backend/src/agent.ts`, `mobile/src/services/langgraph.ts`, `mobile/src/store/chat.ts`, `docs/TRD.md` (sections 3.4–3.5 for tool schemas and HITL flow, section 7 for Google API details).

**Decisions already made — do not re-open:**

1. **Single-channel refactor.** Remove `llmInputMessages` from `AgentState`. Preprocess replaces `messages` with the windowed subset. The agent reads from `messages` directly. Tool calls/results flow through `messages` naturally. History loss is acceptable — checkpointer prior states cover debugging.

2. **Post-stream interrupt detection.** Do NOT parse interrupt events from the SSE stream in real-time. After `streamRun()` completes, check thread status via the API and extract the interrupt payload from thread state. Same code path handles both "interrupt during active session" and "reopen app with pending interrupt." The exact SSE event shape and `tasks` field structure should be verified empirically against `langgraph dev` during the first HITL subtask.

3. **OAuth scope expansion.** Add `calendar.events.owned` to `GOOGLE_SCOPES` in `mobile/src/utils/auth.ts`. Force re-auth for existing sessions when stored scopes don't include the new one.

4. **Create idempotency.** Accepted limitation for Phase 2 — `create_calendar_event` has duplicate risk on ambiguous failures. HITL tools (update/delete) are naturally protected by checkpoint/resume. Full dedup deferred.

5. **Subtask structure.** Plan as vertical slices, not horizontal layers. Start with a walking skeleton that gets one tool (e.g., `list_calendar_events`) working end-to-end through the refactored graph before adding breadth. Each subtask should cross backend + mobile where applicable.

## Scope limitations (Phase 2)

- **Recurring events:** `single` and `all` scopes only. `thisAndFollowing` deferred — requires split-series flow, purely additive to tool internals when added later.
- **Create idempotency:** Accepted duplicate risk on ambiguous failures. Dedup deferred.
- **Event list pagination:** `list_calendar_events` does not paginate — Google defaults to 250 results per page. Users with >250 events in the query window will get a silently truncated list. Add `nextPageToken` handling or an explicit `maxResults` cap if this becomes a problem.

## Subtasks

### Slice 1: Walking skeleton

#### 1.1 — State channel refactor

- **Description**: Remove `llmInputMessages` channel from `AgentState`. Change `preprocessMessages` to return only `{ messages }` with the windowed subset (remove-all + windowed messages). Agent node reads `state.messages` directly instead of `state.llmInputMessages`. Update existing agent tests that reference `llmInputMessages`.
- **Files involved**: `backend/src/agent.ts` (modify), `backend/src/__tests__/agent.test.ts` (modify)
- **Prerequisites**: None
- **Acceptance criteria**: All existing agent tests pass with the single-channel architecture. `preprocessMessages` no longer returns `llmInputMessages`. Agent node uses `state.messages`.
- **Estimated scope**: Small

#### 1.2 — fetchWithAuth helper

- **Description**: Create a shared `fetchWithAuth(url, init, accessToken)` helper for Google API calls. Sets `Authorization: Bearer` header, parses JSON response, throws typed errors for 401 (invalid token), 403 (insufficient scope), 429 (rate limit), and network failures. Reuses `TroliAuthError` pattern for auth errors.
- **Files involved**: `backend/src/utils/google-api.ts` (create), `backend/src/utils/__tests__/google-api.test.ts` (create)
- **Prerequisites**: None
- **Acceptance criteria**: Unit tests cover: successful JSON response, 401/403/429 error mapping, network error handling. ESM import with `.js` extension works.
- **Estimated scope**: Small

#### 1.3 — list_calendar_events + ReAct tool-calling loop

- **Description**: Implement `list_calendar_events` tool and wire the ReAct loop into the agent graph. Tool: Zod schema with `timeMin`, `timeMax`, `query` (all optional), calls `GET /calendars/primary/events` with `singleEvents=true`, `orderBy=startTime` via `fetchWithAuth`. Graph: import `ToolNode`/`toolsCondition` from `@langchain/langgraph/prebuilt`, bind tools to model, add `tools` node, conditional routing `preprocess → agent → (toolsCondition) → tools → agent | __end__`. Access token extracted from `config.configurable.access_token`.
- **Files involved**: `backend/src/tools/calendar.ts` (create), `backend/src/agent.ts` (modify), `backend/src/__tests__/tools/calendar.test.ts` (create), `backend/src/__tests__/agent.test.ts` (modify)
- **Prerequisites**: 1.1, 1.2
- **Acceptance criteria**: `list_calendar_events` unit tests pass (mocked Google API). Agent integration test: `graph.invoke()` with a message that triggers tool use completes the ReAct loop. Model mock must return a tool-call message, then a final text message after seeing tool results.
- **Estimated scope**: Medium

#### 1.4 — OAuth scope expansion + scope mismatch detection

- **Description**: Add `https://www.googleapis.com/auth/calendar.events.owned` to `GOOGLE_SCOPES` in mobile. Store granted scopes in SecureStore alongside the session. On `initialize()`, if stored scopes don't include all current `GOOGLE_SCOPES`, force sign-out with message "Troli now needs calendar access. Please sign in again."
- **Files involved**: `mobile/src/utils/auth.ts` (modify), `mobile/src/store/auth.ts` (modify), `mobile/src/__tests__/store/auth.test.ts` (modify or create)
- **Prerequisites**: None (can run in parallel with 1.1–1.3)
- **Acceptance criteria**: `GOOGLE_SCOPES` includes the calendar scope. Scope mismatch test: stored session with old scopes → `initialize()` triggers sign-out with reason message. Matching scopes → proceeds normally.
- **Estimated scope**: Medium

---

### Slice 2: Read + create tools

#### 2.1 — get_calendar_event

- **Description**: Implement `get_calendar_event` tool. Zod schema: `eventId` (required). Calls `GET /calendars/primary/events/{eventId}` via `fetchWithAuth`. Returns event details as formatted string. Register in agent tools array.
- **Files involved**: `backend/src/tools/calendar.ts` (modify), `backend/src/agent.ts` (modify), `backend/src/__tests__/tools/calendar.test.ts` (modify)
- **Prerequisites**: 1.3
- **Acceptance criteria**: Unit tests: fetches event by ID, returns formatted details, handles not-found error.
- **Estimated scope**: Small

#### 2.2 — create_calendar_event

- **Description**: Implement `create_calendar_event` tool. Zod schema: `summary` (required), `startDateTime`/`endDateTime` (optional, ISO 8601 with offset), `startDate`/`endDate` (optional, YYYY-MM-DD), `location`, `description`, `attendees` (optional array of emails). Validation: `dateTime` and `date` mutually exclusive (`.refine()`), start+end must be paired, all-day `end.date` incremented by +1 day (Google API exclusive end). Calls `POST /calendars/primary/events` via `fetchWithAuth`. Register in agent tools array.
- **Files involved**: `backend/src/tools/calendar.ts` (modify), `backend/src/agent.ts` (modify), `backend/src/__tests__/tools/calendar.test.ts` (modify)
- **Prerequisites**: 1.3
- **Acceptance criteria**: Unit tests: timed event creation, all-day event creation, event with attendees, rejects mixed date/dateTime, rejects start without end.
- **Estimated scope**: Medium

---

### Slice 3: HITL infrastructure + update_calendar_event

#### 3.1 — update_calendar_event backend tool

- **Description**: Implement `update_calendar_event` tool with `interrupt()`. Zod schema: `eventId`, `recurringEventScope` (optional: `single` | `all`), plus update fields (same shape as create). Fetches current event via `GET`, calls `interrupt({ action: "update_calendar_event", description, current, proposed })`. On `approve` → `PATCH /calendars/primary/events/{eventId}`. On `reject` → returns "Update cancelled." For `all` scope, uses `recurringEventId` from fetched event. Same date/dateTime validation as create.
- **Files involved**: `backend/src/tools/calendar.ts` (modify), `backend/src/agent.ts` (modify), `backend/src/__tests__/tools/calendar.test.ts` (modify), `backend/src/__tests__/agent.test.ts` (modify)
- **Prerequisites**: 2.1 (needs fetchWithAuth patterns + calendar tool conventions established)
- **Acceptance criteria**: Unit tests: approve path patches event, reject path returns cancellation, `interrupt()` called with correct payload shape. Integration test: model → update tool → graph status `interrupted` → resume with approve → graph completes.
- **Estimated scope**: Medium

#### 3.2 — Interrupt detection service layer

- **Description**: Add three functions to `langgraph.ts`: (1) `getThreadState()` — fetches full thread state including `tasks` field; (2) `extractInterruptPayload(state)` — extracts `InterruptPayload` from thread state's `tasks` array, derives stable ID as `interrupt-{taskId}`; (3) `resumeRun(threadId, decision, callbacks)` — POST `/threads/{id}/runs/stream` with `{ assistant_id, command: { resume: decision } }` (no `input`), streams response via `consumeSseStream`. Extend `HydratedChatMessage` with optional `interrupt?: InterruptPayload` field. **Note**: exact `tasks` field shape must be verified empirically against `langgraph dev` before finalizing extraction logic.
- **Files involved**: `mobile/src/services/langgraph.ts` (modify), `mobile/src/__tests__/services/langgraph.test.ts` (create or modify)
- **Prerequisites**: 3.1 (need a backend tool that actually interrupts, to verify `tasks` shape empirically)
- **Acceptance criteria**: Unit tests: `extractInterruptPayload` extracts payload and stable ID from mocked thread state. `resumeRun` sends correct request shape. `getThreadState` fetches and parses response.
- **Estimated scope**: Medium

#### 3.3 — Chat store HITL extensions

- **Description**: Extend `ChatMessage` type: new `status` values `'pending_approval' | 'approved' | 'rejected'`, new optional `interrupt?: InterruptPayload` field. Add `resumeApproval(messageId, decision)` action: optimistically sets status to approved/rejected, calls `resumeRun()`, streams follow-up text, re-hydrates. On failure: rolls back status to `pending_approval`, sets `errorMessage`. Add `hasPendingApproval` derived check. In `sendMessage()`, after `streamRun()` completes, call `getThreadState()` — if status is `interrupted`, extract payload and append a `pending_approval` message with stable `interrupt-{taskId}` ID.
- **Files involved**: `mobile/src/store/chat.ts` (modify), `mobile/src/__tests__/store/chat.test.ts` (modify or create)
- **Prerequisites**: 3.2
- **Acceptance criteria**: Unit tests: `resumeApproval` approve path updates status + streams + hydrates. Failure path rolls back to `pending_approval`. `sendMessage` appends approval message when thread is interrupted. `hasPendingApproval` returns true when a `pending_approval` message exists. No duplicate approval messages (stable ID dedup).
- **Estimated scope**: Large

#### 3.4 — Approval card UI

- **Description**: Create `ApprovalCard` component: shows action description, current vs proposed diff, Approve/Reject buttons. Buttons disabled after tap, shows decided state text. Earth-tone palette matching existing design (`#1f5c4a` green, `#f4f1ea` cream, `#fffdf8` white). Integrate into `MessageBubble`: when `message.interrupt` is present, render `<ApprovalCard>` instead of text bubble. In `ChatScreen`: disable `ChatInput` when `hasPendingApproval` is true (add to existing `disabled` condition).
- **Files involved**: `mobile/src/components/ApprovalCard.tsx` (create), `mobile/src/components/MessageBubble.tsx` (modify), `mobile/src/screens/ChatScreen.tsx` (modify)
- **Prerequisites**: 3.3
- **Acceptance criteria**: Approval card renders with description and current/proposed data. Approve button calls `resumeApproval(id, "approve")`. Reject button calls `resumeApproval(id, "reject")`. Buttons disabled after first tap. Input field disabled during pending approval. Visual: matches earth-tone palette.
- **Estimated scope**: Medium

---

### Slice 4: delete_calendar_event + reopen hydration

#### 4.1 — delete_calendar_event backend tool

- **Description**: Implement `delete_calendar_event` tool with `interrupt()`. Zod schema: `eventId`, `recurringEventScope` (optional: `single` | `all`). Fetches current event, calls `interrupt({ action: "delete_calendar_event", description, current, proposed: null })`. On `approve` → `DELETE /calendars/primary/events/{eventId}`. On `reject` → returns "Deletion cancelled." For `all` scope, uses `recurringEventId`. Register in agent tools array.
- **Files involved**: `backend/src/tools/calendar.ts` (modify), `backend/src/agent.ts` (modify), `backend/src/__tests__/tools/calendar.test.ts` (modify)
- **Prerequisites**: 3.1 (reuses interrupt pattern from update tool)
- **Acceptance criteria**: Unit tests: approve path deletes event, reject path returns cancellation, recurring `all` scope uses correct event ID. `interrupt()` payload has `proposed: null`.
- **Estimated scope**: Small

#### 4.2 — Bootstrap interrupt detection + reopen hydration

- **Description**: In `bootstrapThread()`, after hydrating messages, if thread status is `interrupted`, call `getThreadState()` + `extractInterruptPayload()` and append a `pending_approval` message with the stable `interrupt-{taskId}` ID. Extend `BootstrapThreadResult` to include optional `interruptPayload`. Dedup: if a message with the same interrupt ID already exists in the hydrated messages (from post-stream path), skip appending.
- **Files involved**: `mobile/src/services/langgraph.ts` (modify), `mobile/src/store/chat.ts` (modify), `mobile/src/__tests__/store/chat.test.ts` (modify)
- **Prerequisites**: 3.3, 4.1
- **Acceptance criteria**: Test: bootstrap with `interrupted` status → approval message appended with correct stable ID. Test: approval card already present from post-stream + reopen with same ID → no duplicate. Manual: close app mid-approval → reopen → card re-renders → can approve/reject.
- **Estimated scope**: Medium
