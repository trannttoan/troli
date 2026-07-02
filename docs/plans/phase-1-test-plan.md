# Phase 1 — Manual Test Plan

## Prerequisites

- iOS physical device with the app installed (dev client build)
- A Google account
- Access to the LangGraph deployment (dev or cloud)
- A second Google account for multi-account testing

---

## A. Authentication

| #   | Scenario                            | Steps                                                                                                                                                 | Expected                                                                                                           | Status |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| A1  | Fresh sign-in                       | 1. Clean install / clear app data. 2. Open app -> tap Sign In. 3. Complete Google consent screen.                                                     | Consent screen shows `openid email profile` permissions. After granting, app lands on ChatScreen. No error banner. |        |
| A2  | Session persists across app restart | 1. Sign in. 2. Kill app. 3. Reopen.                                                                                                                   | App restores session from SecureStore. Lands on ChatScreen with prior messages. No sign-in screen.                 |        |
| A3  | Token refresh                       | 1. Sign in. 2. Wait for access token to expire (~1 hour) or manually invalidate. 3. Send a message.                                                   | App silently refreshes the token. Message sends successfully. No sign-in prompt.                                   |        |
| A4  | Refresh token revoked               | 1. Sign in. 2. Revoke Troli access via [Google Permissions](https://myaccount.google.com/permissions). 3. Wait for token expiry, then send a message. | Refresh fails. App clears tokens, shows sign-in screen with error message. User can re-sign in.                    |        |
| A5  | Sign out                            | 1. Have an active session. 2. Tap sign out.                                                                                                           | Tokens cleared from SecureStore. Chat state cleared. Returns to sign-in screen.                                    |        |
| A6  | Sign-in cancelled                   | 1. Tap Sign In. 2. Dismiss the Google consent screen without completing.                                                                              | App stays on sign-in screen. No error, no partial state stored.                                                    |        |

---

## B. Basic Chat

| #   | Scenario                  | Steps                                                                                 | Expected                                                                                                                           | Status |
| --- | ------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| B1  | Simple greeting           | Send: "Hello"                                                                         | Assistant responds with a greeting. Streaming text appears progressively, then finalizes on hydration.                             |        |
| B2  | Multi-turn conversation   | Send: "Hello" -> wait for response -> Send: "What's your name?"                       | Both turns render correctly. Assistant remembers context from turn 1 (e.g., doesn't re-introduce itself).                          |        |
| B3  | Empty message             | Tap send with empty/whitespace input                                                  | Nothing happens. No network request sent.                                                                                          |        |
| B4  | Typing indicator timing   | Send a message. Watch for indicator.                                                  | Typing indicator (dots) appears immediately after send, disappears once streaming text appears. No flicker, no leftover indicator. |        |
| B5  | Message history on reopen | 1. Have a multi-turn conversation. 2. Kill app. 3. Reopen.                            | All previous messages load. Order preserved. No duplicates. Timestamps intact.                                                     |        |
| B6  | Error banner dismiss      | 1. Trigger any error (e.g., turn off network, send message). 2. Tap the error banner. | Banner dismisses. Can continue using the app after re-establishing network.                                                        |        |

---

## C. Error Handling

| #   | Scenario                       | Steps                                                                                             | Expected                                                                                                          | Status |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| C1  | Backend unreachable            | 1. Stop the LangGraph dev server (or point to wrong URL). 2. Send any message.                    | Error banner with connection error. No crash. No infinite spinner. Input re-enables after error.                  |        |
| C2  | Network loss during streaming  | 1. Send a message. 2. Immediately enable airplane mode / kill network.                            | Error banner appears. Streaming message cleaned up. After restoring network, user can resend.                     |        |
| C3  | Token expired mid-conversation | 1. Start a conversation. 2. Wait for token to expire (or manually invalidate). 3. Send a message. | App attempts token refresh. If refresh succeeds, message sends. If refresh fails, forces re-auth. Does NOT crash. |        |

---

## D. UI & UX Edge Cases

| #   | Scenario                                    | Steps                                                                                | Expected                                                                                                                                               | Status |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| D1  | Rapid double-send                           | Tap send twice quickly on the same message.                                          | Only one message sent. `isSending` guard prevents duplicate.                                                                                           |        |
| D2  | Send during bootstrap                       | Open app fresh. Before bootstrap completes, try to type and send.                    | Input is disabled during bootstrap. Cannot send.                                                                                                       |        |
| D3  | App background during streaming             | 1. Send a message. 2. Immediately background the app. 3. Return after a few seconds. | On return, the conversation should be in a consistent state -- either streaming completed and hydrated, or error shown. No stuck spinner.              |        |
| D4  | Keyboard interactions                       | 1. Open keyboard. 2. Scroll the message list. 3. Tap "Done" button.                  | Keyboard dismisses on scroll drag. "Done" button dismisses keyboard. Input field remains functional.                                                   |        |
| D5  | Sign out and re-sign in                     | 1. Have a conversation. 2. Sign out. 3. Sign in with same account.                   | Chat state resets on sign-out. After sign-in, bootstrap loads the thread history (persistent thread ID from email). Previous messages should reappear. |        |
| D6  | Sign out and sign in with different account | 1. Sign out. 2. Sign in with a different Google account.                             | New thread ID generated from new email. Clean chat.                                                                                                    |        |

---

## E. System Prompt & Agent Behavior

| #   | Scenario             | Steps                                               | Expected                                                                                                           | Status |
| --- | -------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| E1  | Timezone awareness   | Send: "What time is it?" or ask about today's date. | Agent uses the device's timezone (sent via `config.configurable.timezone`). Times should match local, not UTC.     |        |
| E2  | No tool capabilities | Send: "What's on my calendar today?"                | Agent does not claim to have calendar access. Responds that it can't access calendars (no tools exist in Phase 1). |        |
