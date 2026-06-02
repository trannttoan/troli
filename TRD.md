# Technical Requirements Document — Troli

**Version:** 1.0 (Draft)
**Status:** Draft
**Companion PRD:** PRD.md
**Date:** April 2026

---

## 1. System Architecture

Troli is split into two components: a React Native mobile client and a Node.js backend running the LangGraph.js agent. The mobile client handles authentication and the chat UI. The backend handles LLM calls, tool execution, state persistence, and Google API calls.

The client never calls Google APIs directly. It passes the user's OAuth access token to the backend with each request. The backend uses that token to make Google API calls on the user's behalf.

```
┌──────────────────────┐         ┌──────────────────────────────────┐
│   iOS App (Expo)     │  REST   │   Backend (LangGraph Cloud)      │
│                      │  + SSE  │                                  │
│  - Chat UI           │◄───────►│  - LangGraph.js Agent            │
│  - Google OAuth      │         │  - Google API Tool Execution     │
│  - Token Storage     │         │  - PostgreSQL Checkpointer       │
│  - SSE Streaming     │         │  - LangSmith Tracing             │
└──────────────────────┘         └──────────────────────────────────┘
         │                                      │
         │ OAuth 2.0                            │ REST (with user's access token)
         ▼                                      ▼
┌──────────────────────┐         ┌──────────────────────────────────┐
│   Google OAuth       │         │   Google APIs                    │
│   (accounts.google)  │         │   - Calendar, Tasks, Gmail       │
└──────────────────────┘         └──────────────────────────────────┘
```

---

## 2. Mobile Client (Frontend)

### 2.1 Tech Stack

| Aspect | Choice |
|---|---|
| Framework | React Native with Expo (managed workflow) |
| Language | TypeScript |
| Min iOS Version | iOS 16+ |
| Auth Library | `expo-auth-session` (Google OAuth 2.0 with PKCE) |
| Token Storage | `expo-secure-store` (Keychain, `AFTER_FIRST_UNLOCK`) |
| HTTP Client | `fetch` with SSE support for streaming |
| State Management | Zustand (selective subscriptions, works outside React components for auth logic) |

### 2.2 Authentication

The client initiates the OAuth 2.0 authorization code flow with PKCE via `expo-auth-session`. The flow:

1. `expo-auth-session` opens the Google consent screen with all required scopes.
2. The request includes `prompt: 'consent'` and `access_type: 'offline'` to guarantee a refresh token.
3. User grants permissions.
4. Client exchanges the authorization code for an access token and refresh token via POST to `https://oauth2.googleapis.com/token`.
5. Client fetches user email from `https://www.googleapis.com/oauth2/v2/userinfo` for display.
6. All tokens and metadata are stored in `expo-secure-store`.

**Token storage keys:**

| SecureStore Key | Value | Purpose |
|---|---|---|
| `auth_access_token` | Google OAuth access token | Passed to backend per request |
| `auth_refresh_token` | Google OAuth refresh token | Silent token renewal |
| `auth_token_expiry` | ISO 8601 timestamp | Determines when refresh is needed |
| `auth_user_email` | Google account email | Display in UI |

**Token lifecycle:**

| Token | Lifespan | Renewal |
|---|---|---|
| Access token | ~1 hour | Silent refresh using the refresh token before each API call if expired |
| Refresh token | Long-lived (months/years) | No renewal; revocation requires re-auth |

**Silent refresh flow:** Before each backend call, check the stored expiry. Apply a 5-minute buffer — if the token expires within 5 minutes, refresh preemptively. Use a promise-based mutex to prevent concurrent refresh requests.

### 2.3 Google Cloud Console Setup

1. A Google Cloud project with the Google Calendar API, Google Tasks API, and Gmail API enabled.
2. An OAuth 2.0 Client ID configured for iOS with the app's Bundle ID.
3. An OAuth consent screen configured as external (unverified for testing, verified for production).
4. Scopes declared: `calendar.events.owned`, `tasks`, `gmail.readonly`, `userinfo.email`.

### 2.4 Chat UI

Simple chat bubble layout:

- Messages are a flat list. User messages on the right, agent messages on the left.
- Agent responses stream in token-by-token via SSE.
- When the agent proposes an update or delete, an approval card renders inline in the message list. The card has Approve and Reject buttons. Tapping either sends a resume command to the backend.
- A loading/typing indicator shows while the agent is processing.
- The input bar is fixed at the bottom with a text field and send button. The input bar is disabled while the agent is processing; re-enabled after the response completes or the user resolves an approval card.

### 2.5 Backend Communication

The client communicates with the backend via two patterns:

**Sending a message:** POST to `/threads/{thread_id}/runs` with the user's message and access token. The response is an SSE stream of agent output. The stream uses typed events — regular tokens arrive as `events` payloads, and when the agent hits an interrupt (HITL), the stream ends with the thread in `interrupted` status. The client detects this by checking the thread state after stream completion and renders the approval card from the interrupt payload.

**Resuming after HITL interrupt:** POST to `/threads/{thread_id}/runs` with a `Command(resume=...)` payload containing the user's decision (approve or reject). The response is again an SSE stream.

**Timezone:** The client reads the device timezone via `expo-localization` (`getCalendars()[0].timeZone`) and sends it with each request. The backend injects it into the system prompt so the agent interprets relative dates correctly.

**Thread management:** Each user has a single thread. The thread ID is derived from or mapped to the user's Google account email. On first login, the client creates a thread. On subsequent launches, it resumes the existing thread.

---

## 3. Backend (Agent Server)

### 3.1 Tech Stack

| Aspect | Choice |
|---|---|
| Runtime | Node.js (LTS) |
| Language | TypeScript |
| Agent Framework | LangGraph.js (`@langchain/langgraph`) |
| Agent Pattern | ReAct agent with tool-calling |
| Hosting | LangGraph Cloud (v1.0). AWS migration planned for scale. |
| State Persistence | PostgreSQL checkpointer (managed by LangGraph Cloud) |
| Observability | LangSmith |

### 3.2 LLM Configuration

LangGraph.js is model-agnostic. The LLM is injected at configuration time.

```typescript
// OpenAI
import { ChatOpenAI } from "@langchain/openai";
const model = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });

// OR Anthropic
import { ChatAnthropic } from "@langchain/anthropic";
const model = new ChatAnthropic({ model: "claude-sonnet-4-6", temperature: 0 });
```

Switching providers is a one-line change. Both `@langchain/openai` and `@langchain/anthropic` implement the same `BaseChatModel` interface.

**Model selection strategy:**

| Phase | Model Strategy |
|---|---|
| v1.0 Development | Start with GPT-4o or Claude Sonnet. Both have strong tool-calling support. Try both during prototyping. |
| Cost Optimization | Explore GPT-4o-mini or Claude Haiku for simple routing/classification. Capable model only for complex reasoning. |
| Future | Evaluate open-source models (Llama, Mistral) via Ollama for self-hosted inference. |

### 3.3 Agent Graph

The agent uses `createReactAgent` for rapid prototyping or a custom `StateGraph` for finer control. The graph follows this flow:

```
User Message
    │
    ▼
┌─────────┐
│  Agent   │◄──────────────────────┐
│  (LLM)  │                       │
└────┬────┘                       │
     │ decides tool call          │
     ▼                            │
┌──────────────┐                  │
│  Tool Router │                  │
└──┬───────┬───┘                  │
   │       │                      │
   ▼       ▼                      │
 Read    Write                    │
 Tool    Tool                     │
   │       │                      │
   │       ▼                      │
   │  ┌──────────┐               │
   │  │ interrupt │               │
   │  │ (HITL)    │               │
   │  └────┬─────┘               │
   │       │ user approves/rejects│
   │       ▼                      │
   │  Execute or                  │
   │  Reject                      │
   │       │                      │
   └───────┴──────────────────────┘
                │
                ▼
          Agent Response
```

### 3.4 Tool Definitions

Each Google API operation is a LangGraph tool defined with Zod schemas. Tools are organized by service and operation type.

**Calendar tools:**

| Tool Name | Type | HITL | Parameters |
|---|---|---|---|
| `list_calendar_events` | Read | Auto | `timeMin`, `timeMax`, `query` (optional) |
| `get_calendar_event` | Read | Auto | `eventId` |
| `create_calendar_event` | Write | Auto | `summary`, `startDateTime`, `endDateTime`, `location` (optional), `description` (optional), `attendees` (optional, array of emails) |
| `update_calendar_event` | Write | Interrupt | `eventId`, `recurringEventScope` (`single` or `all`, required for recurring events), plus any fields to update |
| `delete_calendar_event` | Write | Interrupt | `eventId`, `recurringEventScope` (`single` or `all`, required for recurring events) |

**Tasks tools:**

| Tool Name | Type | HITL | Parameters |
|---|---|---|---|
| `list_task_lists` | Read | Auto | None |
| `list_tasks` | Read | Auto | `taskListId` |
| `get_task` | Read | Auto | `taskListId`, `taskId` |
| `create_task` | Write | Auto | `taskListId`, `title`, `due` (optional), `notes` (optional) |
| `update_task` | Write | Interrupt | `taskListId`, `taskId`, plus fields to update |
| `delete_task` | Write | Interrupt | `taskListId`, `taskId` |

**Gmail tools:**

| Tool Name | Type | HITL | Parameters |
|---|---|---|---|
| `search_gmail` | Read | Auto | `query` (Gmail search syntax), `maxResults` |
| `get_gmail_message` | Read | Auto | `messageId` |
| `get_gmail_thread` | Read | Auto | `threadId` |
| `list_gmail_labels` | Read | Auto | None |

### 3.5 Human-in-the-Loop Implementation

HITL uses LangGraph's `interrupt()` function. Write tools for update and delete operations call `interrupt()` before executing.

```typescript
// Example: update_calendar_event tool
const update_calendar_event = tool(
  async ({ eventId, ...updates }, config) => {
    // Fetch current event for context
    const current = await fetchEvent(eventId, config.configurable.accessToken);

    // Pause for approval
    const decision = interrupt({
      action: "update_calendar_event",
      description: `Update "${current.summary}": ${formatChanges(current, updates)}`,
      current: current,
      proposed: updates,
    });

    if (decision === "reject") {
      return "Update cancelled by user.";
    }

    // Execute the update
    return await executeUpdate(eventId, updates, config.configurable.accessToken);
  },
  {
    name: "update_calendar_event",
    description: "Update an existing calendar event. Requires user approval.",
    schema: z.object({
      eventId: z.string(),
      summary: z.string().optional(),
      startDateTime: z.string().optional(),
      endDateTime: z.string().optional(),
      location: z.string().optional(),
      description: z.string().optional(),
    }),
  }
);
```

**Interrupt/resume flow:**

1. Agent calls a write tool (update or delete).
2. Tool calls `interrupt()` with a payload describing the proposed action.
3. LangGraph checkpoints the thread state and marks it as `interrupted`.
4. Backend returns the interrupt payload to the client via SSE.
5. Client renders an approval card with Approve/Reject buttons.
6. User taps a button.
7. Client POSTs `Command(resume="approve")` or `Command(resume="reject")` to the resume endpoint.
8. LangGraph resumes the graph from the checkpoint. The tool receives the decision and either executes or cancels.

### 3.6 System Prompt

The agent's system prompt is constructed dynamically per request. It includes:

```
You are Troli, a personal assistant that manages the user's Google Calendar,
Google Tasks, and Gmail.

Today's date: {current_date}
User's timezone: {timezone}
Current time: {current_time}

Rules:
- When the user asks you to create an event or task, do it directly.
- When the user asks you to update or delete something, you'll be asked for
  approval before the change goes through. Show the user clearly what will change.
- For recurring events: always ask whether the user wants to change a single
  occurrence or all future occurrences before proposing the update or delete.
- When the user asks to create a task without specifying a task list, ask which
  list to use.
- Never fabricate event details, task content, or email content. Only report
  what the APIs return.
- If the user's request is ambiguous (e.g., "schedule a meeting" without a
  time), ask for the missing details before creating anything.
- When listing events or tasks, format them clearly with times, dates, and
  relevant details.
- For Gmail searches, use Gmail query syntax internally but speak naturally
  to the user.
```

The timezone is read from the device via `expo-localization` and sent by the client with each request. The current date/time are computed server-side from the user's timezone.

### 3.7 Thread and Conversation Management

Each user has one thread, identified by a deterministic thread ID derived from their Google account email (e.g., `troli-{sha256(email)}`).

**7-day message window:** The full conversation history stays in the PostgreSQL checkpointer — nothing is deleted from storage. Instead, a preprocessing step in the graph filters messages to the past 7 days before passing them to the LLM. The LLM only sees recent messages, but the full history remains available in the database for profile building and debugging.

This approach is infrastructure-agnostic (works on LangGraph Cloud and AWS) and avoids any dependency on the hosting platform's pruning capabilities.

**Implementation:** A preprocessing node at the start of each agent run filters the `messages` array. All messages must be timestamped at creation time. Messages without timestamps are dropped. A hard cap of 200 messages prevents unbounded context growth even within the 7-day window:

```typescript
const MAX_MESSAGES = 200;

function windowMessages(messages: BaseMessage[], windowDays: number = 7): BaseMessage[] {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const windowed = messages.filter(msg => {
    const timestamp = msg.additional_kwargs?.timestamp;
    return timestamp != null && timestamp >= cutoff;
  });
  return windowed.length > MAX_MESSAGES
    ? windowed.slice(-MAX_MESSAGES)
    : windowed;
}
```

### 3.8 User Profile (Agent Memory) — Deferred to Post-v1.0

Agent memory is deferred to post-v1.0. In v1.0, the agent operates only with the current 7-day message window and has no persistent profile. See PRD Section 12 for the planned capability.

---

## 4. Infrastructure

### 4.1 LangGraph Cloud (v1.0)

LangGraph Cloud is the hosting choice for v1.0. It provides managed deployment of LangGraph agents with built-in checkpointing, streaming, and HITL support.

**What LangGraph Cloud handles:**
- Deploying the agent from a LangGraph project definition.
- PostgreSQL-backed checkpointing for thread state and interrupts.
- SSE streaming endpoint for real-time agent output.
- Thread management API (create, list, get, resume).
- Automatic LangSmith integration.

**What you still manage:**
- The LangGraph agent code (tools, graph definition, system prompt).
- Google API tool implementations.
- The mobile client.
- Google Cloud project and OAuth configuration.
- LLM API keys (OpenAI / Anthropic).

### 4.2 AWS Migration (Post-v1.0)

When scaling beyond personal use, migrate the backend to AWS for cost control and flexibility.

| Component | AWS Service |
|---|---|
| Agent runtime | ECS Fargate or EC2 |
| State persistence | RDS PostgreSQL (for `AsyncPostgresSaver`) |
| API gateway | ALB + Express/Fastify |
| Secrets | AWS Secrets Manager |
| CI/CD | GitHub Actions → ECR → ECS |

The migration path is straightforward because LangGraph.js runs on any Node.js environment. The main work is setting up the PostgreSQL checkpointer, SSE streaming endpoint, and the thread management API that LangGraph Cloud currently provides for free.

---

## 5. Observability (LangSmith)

All agent runs are traced in LangSmith. Integration is automatic when these environment variables are set:

```
LANGCHAIN_TRACING_V2=true
LANGSMITH_API_KEY=<your-key>
LANGCHAIN_PROJECT=troli-v1
```

**What gets traced:**
- Every LLM call (prompt, response, token count, latency, model name).
- Every tool call (tool name, input arguments, output, duration).
- HITL interrupts (what was proposed, what the user decided, response time).
- Errors and retries.
- Full conversation thread replay for debugging.

**Key metrics to monitor:**
- Average tokens per conversation turn (cost tracking).
- Tool call success/failure rate.
- HITL approval vs. rejection rate (high rejection rate suggests the agent is making bad proposals).
- End-to-end latency per user message.

---

## 6. API Endpoints

The backend exposes these endpoints to the mobile client. When using LangGraph Cloud, most of these are provided out of the box.

| Method | Path | Purpose |
|---|---|---|
| POST | `/threads` | Create a new thread for a user |
| GET | `/threads/{thread_id}` | Get thread state (messages, status) |
| POST | `/threads/{thread_id}/runs` | Send a user message or resume after HITL. Returns SSE stream. |

The client includes the user's Google access token in the `Authorization` header of every request. The backend extracts it and passes it to tool functions for Google API calls.

### 6.1 Sign-Out Flow

1. Client clears all tokens from `expo-secure-store` (`auth_access_token`, `auth_refresh_token`, `auth_token_expiry`, `auth_user_email`).
2. Client navigates to the sign-in screen.
3. The thread ID is retained locally so the user can reconnect to the same conversation on re-auth.
4. No backend call is needed — the backend holds no session state or tokens.

---

## 7. Google API Implementation Details

### 7.1 Calendar API

**Base URL:** `https://www.googleapis.com/calendar/v3`

Key endpoints:
- `GET /calendars/primary/events` — list events with `timeMin`, `timeMax`, `singleEvents=true`, `orderBy=startTime`.
- `GET /calendars/primary/events/{eventId}` — get single event.
- `POST /calendars/primary/events` — create event.
- `PATCH /calendars/primary/events/{eventId}` — update event fields.
- `DELETE /calendars/primary/events/{eventId}` — delete event.

v1.0 uses the primary calendar only. The `calendar.events.owned` scope restricts access to calendars the user owns.

**All-day events** use `start.date` instead of `start.dateTime`. The agent should handle both formats.

### 7.2 Tasks API

**Base URL:** `https://www.googleapis.com/tasks/v1`

Key endpoints:
- `GET /users/@me/lists` — list task lists.
- `GET /lists/{taskListId}/tasks` — list tasks in a list.
- `GET /lists/{taskListId}/tasks/{taskId}` — get single task.
- `POST /lists/{taskListId}/tasks` — create task.
- `PATCH /lists/{taskListId}/tasks/{taskId}` — update task (title, notes, due, status).
- `DELETE /lists/{taskListId}/tasks/{taskId}` — delete task.

To mark a task as complete, PATCH with `status: "completed"`.

### 7.3 Gmail API

**Base URL:** `https://www.googleapis.com/gmail/v1`

Key endpoints:
- `GET /users/me/messages` — list messages with `q` parameter for search.
- `GET /users/me/messages/{messageId}` — get full message.
- `GET /users/me/threads` — list threads.
- `GET /users/me/threads/{threadId}` — get thread with all messages.
- `GET /users/me/labels` — list labels.

Gmail message bodies are base64url-encoded. The tool implementation must decode them and extract the text/plain or text/html part for the agent to summarize.

### 7.4 Shared HTTP Helper

All Google API calls go through a shared `fetchWithAuth` function that:
- Sets the `Authorization: Bearer {accessToken}` header.
- Handles 401 responses by returning an error that tells the client to refresh the token and retry.
- Handles 429 (rate limit) by returning a user-friendly error.
- Handles network errors gracefully.

---

## 8. Security Considerations

- **Client-to-backend authentication.** The backend validates the Google access token on each request by calling Google's tokeninfo endpoint (`https://oauth2.googleapis.com/tokeninfo?access_token=...`). This confirms the token is valid and extracts the user's email. For v1.0 (personal/test use), this is sufficient. For production scale, add a dedicated auth layer (e.g., short-lived JWT issued after token validation).
- **Tokens never touch the backend's storage.** The client sends the Google access token per request. The backend passes it to tool functions via LangGraph's `config.configurable` (not graph state), which is not serialized by the checkpointer. The token exists only in memory for the duration of the request.
- **Token refresh happens client-side only.** The backend never sees the refresh token.
- **HTTPS everywhere.** All client-to-backend and backend-to-Google communication is over TLS.
- **Thread isolation.** Each user's thread is identified by a hash of their email. There is no cross-user data access in v1.0 (single-user app).
- **LangSmith traces may contain PII.** Traces will include calendar event titles, task names, and email content. Ensure the LangSmith project is private and access-controlled.

---

## 9. Development Dependencies

### Mobile Client

```
expo
expo-auth-session
expo-secure-store
expo-crypto (for hashing email to thread ID)
react-native
typescript
```

### Backend

```
@langchain/langgraph
@langchain/core
@langchain/openai (and/or @langchain/anthropic)
@langgraphjs/toolkit
zod (tool parameter validation)
typescript
```

### External Services

| Service | Purpose | Free Tier |
|---|---|---|
| Google Cloud | OAuth + Calendar/Tasks/Gmail APIs | Free for personal use |
| OpenAI or Anthropic | LLM API | Pay per token |
| LangGraph Cloud | Agent hosting | Free tier available for development |
| LangSmith | Tracing and observability | Free tier available |

---

## 10. Testing Strategy

### 10.1 Backend (Vitest)

| Layer | What to Test | Approach |
|---|---|---|
| Tool unit tests | Each Google API tool in isolation | Mock `fetchWithAuth` responses. Verify correct API calls, parameter mapping, error handling. |
| HITL flow | Interrupt/resume cycle for update and delete tools | Use LangGraph's test utilities to simulate interrupt and resume with approve/reject. |
| Agent integration | Full graph execution for representative user queries | Mock all Google API responses. Assert the agent selects the correct tool with correct parameters. |
| Message windowing | 7-day filter and hard cap | Unit test `windowMessages` with synthetic message arrays. |

### 10.2 Mobile Client (React Native Testing Library)

| Layer | What to Test | Approach |
|---|---|---|
| Components | Chat bubbles, approval cards, input bar | Render with test data. Verify approve/reject callbacks, disabled state during processing. |
| Auth flow | Token storage, silent refresh, sign-out | Mock `expo-secure-store` and `expo-auth-session`. Verify token lifecycle. |
| SSE handling | Stream parsing, interrupt detection | Mock SSE responses. Verify messages render incrementally and approval cards appear on interrupt. |

### 10.3 Deferred to Post-v1.0

- **E2E tests (Detox):** Full iOS simulator tests for critical flows (sign-in → send message → approve update). Complex setup; defer until the app stabilizes.
- **Live Google API tests:** Integration tests against real Google APIs with a dedicated test account. Useful but requires careful setup to avoid polluting real calendars.

---

## 11. Resolved Technical Questions

| # | Question | Resolution |
|---|---|---|
| 1 | How to handle the 7-day message pruning? Background job, or inline? | Inline — prune in the graph, not in storage. A preprocessing step filters messages to the past 7 days before passing them to the LLM. Full history stays in PostgreSQL for profile building and debugging. See Section 3.7. |
| 2 | Should the backend validate the Google access token proactively, or let tools fail and handle 401s reactively? | Reactive. The client handles token refresh and should almost always send a valid token. A 401 from a tool is an edge case (revoked account, expired refresh token). Not worth adding an extra HTTP roundtrip to every request. The tool returns a typed error so the client knows to trigger re-auth. |
| 3 | Can LangGraph Cloud handle custom message pruning? | Not needed. Pruning happens at the graph level (a state reducer filters messages before the LLM sees them), not at the storage level. This works on any infrastructure — LangGraph Cloud, AWS, whatever. See Section 3.7. |

## 12. Open Technical Questions

| # | Question | Status |
|---|---|---|
| 1 | GPT-4o or Claude Sonnet? Need to test both for tool-calling accuracy. | Open |
