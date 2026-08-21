# Rename Migration — Troli → Aisist

The repo, package names, app name, bundle ID, and LangSmith project were renamed from
Troli to Aisist. Code and docs are already updated. This is the checklist for the
external services that still point at the old name.

Work through it in order — steps 2–4 must land together or sign-in breaks. Steps 5
and 6 are superseded by the move to LangGraph Self-Hosted Lite + Langfuse.

---

## What already changed in the repo

| Thing                    | Before            | After               |
| ------------------------ | ----------------- | ------------------- |
| Workspace packages       | `@troli/*`        | `@aisist/*`         |
| Expo app name / slug     | `Troli` / `troli` | `Aisist` / `aisist` |
| iOS bundle ID and scheme | `com.troli.app`   | `com.aisist.app`    |
| LangSmith project        | `troli-v1`        | `aisist-v1`         |
| Auth error class         | `TroliAuthError`  | `AisistAuthError`   |
| Thread namespace const   | `TROLI_NAMESPACE` | `AISIST_NAMESPACE`  |
| Agent identity in prompt | "You are Troli…"  | "You are Aisist…"   |

**The namespace UUID value (`e587b8a0-…`) was deliberately left unchanged.** Thread IDs
are `uuidv5(email, AISIST_NAMESPACE)`, so existing conversations stay reachable after the
rename. Do not change that constant's value unless you intend to orphan every thread.

## 1. GitHub repo — done

`origin` already points at `git@github.com:trannttoan/aisist.git`, and the README badge
URLs were updated. GitHub redirects the old `trannttoan/troli` URL, so nothing to do.

## 2. Google Cloud — OAuth consent screen

**APIs & Services > OAuth consent screen > Edit app**

1. Change **App name** from `Troli` to `Aisist`.
2. Leave scopes and test users as they are.
3. Save.

The consent screen name is what users see during sign-in, so this and step 3 should ship
in the same sitting.

Optionally rename the GCP project display name (**IAM & Admin > Settings**) to `Aisist`.
The project **ID** is immutable — leaving it as-is has no functional impact.

## 3. Google Cloud — iOS OAuth client

**APIs & Services > Credentials > OAuth 2.0 Client IDs > Aisist iOS**

The registered bundle ID must match `mobile/app.json`'s `ios.bundleIdentifier`, which is
now `com.aisist.app`.

- **If the console lets you edit the bundle ID** on the existing client: change it to
  `com.aisist.app` and rename the client to `Aisist iOS`. The client ID string is
  unchanged, so `mobile/.env` needs no edit.
- **If it doesn't:** create a new iOS client (Name `Aisist iOS`, Bundle ID
  `com.aisist.app`), copy the new client ID into `mobile/.env`:

  ```
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=<new-client-id>
  ```

  Delete the old `com.troli.app` client only after step 4 verifies end to end.

## 4. Rebuild and reinstall the iOS dev client

A bundle ID change makes this a different app to iOS — the old build will not pick up the
new OAuth config, and the two can't coexist under one identifier.

```bash
rm -rf mobile/ios
pnpm --filter @aisist/mobile exec expo prebuild --clean
```

Then rebuild the dev client (EAS or local Xcode build) and install it. **Delete the old
Troli app from the device first** — same device, different bundle ID, so it would
otherwise linger as a separate stale app.

Expected consequence: SecureStore is per-app, so the reinstall wipes the stored session
and every user signs in again. Conversation history survives (see the namespace note
above).

## 5. LangSmith — superseded

**The project is moving to LangGraph Self-Hosted Lite + Langfuse, which replaces this
step.** Don't create an `aisist-v1` LangSmith project. See
[SELF-HOST-MIGRATION.md](SELF-HOST-MIGRATION.md) for the replacement path.

The rename already changed `LANGSMITH_PROJECT` to `aisist-v1` in `backend/.env.example`;
that var goes away with the platform switch, so leave it alone rather than wiring it up.

Note: Self-Hosted Lite still requires a LangSmith API key plus
`LANGGRAPH_CLOUD_LICENSE_KEY` for license verification at server startup — the switch drops
LangSmith as the _tracing_ backend, not as a dependency.

## 6. LangGraph Cloud — superseded

Also replaced by the self-hosting move. The current deployment URL
(`https://troli-<hash>.us.langgraph.app`) is being retired rather than renamed, so
`EXPO_PUBLIC_LANGGRAPH_API_URL` will point at the new self-hosted host instead. No action
here.

## 7. App Store Connect — not yet needed

Nothing is submitted, so there's no bundle ID to migrate. When you do register
`com.aisist.app`, confirm it's available before committing to the name.

---

## Verification

- [ ] Consent screen shows **Aisist** during sign-in
- [ ] iOS OAuth client bundle ID is `com.aisist.app`
- [ ] `mobile/.env` client ID matches the client from step 3
- [ ] Old Troli app deleted from device; new build installed
- [ ] Fresh sign-in succeeds and grants calendar + tasks scopes
- [ ] Prior conversation history loads for an existing account
- [ ] Traces land in Langfuse (see SELF-HOST-MIGRATION.md; the LangSmith project is not created)
