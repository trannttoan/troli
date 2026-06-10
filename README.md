# Troli

An iOS app that manages Google Calendar, Google Tasks, and Gmail through a conversational AI interface.

<!-- ![Demo](docs/demo.gif) -->

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React Native](https://img.shields.io/badge/React_Native-61DAFB?logo=react&logoColor=black)
![Expo](https://img.shields.io/badge/Expo-000020?logo=expo&logoColor=white)
![LangGraph](https://img.shields.io/badge/LangGraph-1C3C3C?logo=langchain&logoColor=white)

## Overview

Troli connects to a user's Google Calendar, Google Tasks, and Gmail through a single chat interface. The user sends natural language requests, and a LangGraph-powered agent interprets them, calls the appropriate Google APIs, and streams the response back in real time via SSE.

Destructive operations (updates and deletes) require explicit user approval through inline approval cards before executing. Reads and creates proceed directly.

## Features

### Calendar

Full CRUD on the user's primary calendar. Supports timed and all-day events, recurring event handling (single occurrence or all future), and optional attendee emails.

### Tasks

Full CRUD across task lists. The agent asks which list to use when the user doesn't specify one. Tasks can be created, updated, marked as complete, or deleted.

### Gmail

Read-only access to messages, threads, and labels. The agent translates natural language queries into Gmail search syntax internally and returns results conversationally.

### Human-in-the-Loop

Write operations follow a split policy:

- **Creates** execute directly, with agent follow-up confirmation.
- **Updates and deletes** pause the conversation and present an approval card with the proposed change. The user approves or rejects before the operation executes.

This is implemented using LangGraph's `interrupt()` mechanism. The graph checkpoints its state at the interrupt point and resumes from that checkpoint once the user responds.

### Conversation

- **Streaming**: Agent responses stream token-by-token to the client via SSE rather than waiting for the full response.
- **Message window**: The LLM sees the most recent 7 days of messages (hard-capped at 200). Full history is retained in PostgreSQL for debugging.
- **Persistent threads**: Thread IDs are deterministic UUIDs derived from the user's email, so the conversation survives app reinstalls and device changes.

## Architecture

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

**Design patterns**:

- **Agent graph**: A preprocessing node validates the user's Google token, filters messages to the 7-day window, and stamps timestamps. The agent node runs a ReAct loop with tool-calling against the Google APIs.
- **HITL via graph interrupts**: Write tools call `interrupt()` before executing. The graph checkpoints to PostgreSQL, the client renders an approval card, and the graph resumes from the checkpoint on the user's decision.
- **Token lifecycle**: The client handles OAuth (PKCE flow, silent refresh with 5-minute buffer, mutex for concurrent requests). The backend validates the access token per request via Google's tokeninfo endpoint and never persists tokens.
- **Provider-agnostic LLM**: The agent uses LangChain's `BaseChatModel` interface. Swapping between Gemini, GPT-4o, or Claude is a one-line configuration change.

## Tech Stack

| Layer | Technology |
|---|---|
| Mobile | Expo 56, React Native, Zustand, expo-auth-session, expo-secure-store |
| Backend | Node.js, LangGraph.js, Gemini 2.5 Flash-Lite, Zod |
| Infrastructure | LangGraph Cloud, LangSmith |
| Tooling | TypeScript, pnpm workspaces |

## Project Structure

```
troli/
├── mobile/                 # iOS app (React Native + Expo)
│   ├── src/
│   │   ├── components/     # Chat UI components (message bubbles, input bar, typing indicator)
│   │   ├── screens/        # Sign-in and chat screens
│   │   ├── navigation/     # Stack navigator with auth-conditional routing
│   │   ├── services/       # LangGraph REST client, SSE parser
│   │   ├── store/          # Zustand stores (auth, chat)
│   │   └── utils/          # OAuth helpers, thread ID generation
│   └── App.tsx
├── backend/                # LangGraph.js agent
│   ├── src/
│   │   ├── agent.ts        # StateGraph definition (preprocess → agent)
│   │   ├── prompt.ts       # Dynamic system prompt with timezone-aware date/time
│   │   └── utils/          # Token validation, message windowing, timestamps
│   └── langgraph.json      # LangGraph Cloud deployment config
├── docs/                   # Product and technical documentation
│   ├── PRD.md
│   ├── TRD.md
│   ├── BUILD.md
│   ├── SETUP.md
│   └── DEPLOY.md
├── pnpm-workspace.yaml
└── package.json
```
