# Infrastructure Setup

Manual setup steps for Google Cloud and LangSmith. Follow in order.

---

## 1. Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project — name it **Troli**
3. Note the project ID (you'll need it later)

## 2. Enable APIs

In the new project, go to **APIs & Services > Library** and enable:

- **Google Calendar API**
- **Google Tasks API**
- **Gmail API**
- **Generative Language API** (Gemini)

## 3. OAuth Consent Screen

Go to **APIs & Services > OAuth consent screen**:

1. Select **External** user type
2. Fill in:
   - App name: **Troli**
   - User support email: your email
   - Developer contact email: your email
3. Add scopes:
   - `https://www.googleapis.com/auth/calendar.events.owned`
   - `https://www.googleapis.com/auth/tasks`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/userinfo.email`
4. Add your Google account as a **test user**
5. Save — the consent screen stays in **Testing** mode (100 user limit, unverified app warning)

## 4. iOS OAuth Client ID

Go to **APIs & Services > Credentials**:

1. Click **Create credentials > OAuth client ID**
2. Application type: **iOS**
3. Name: **Troli iOS**
4. Bundle ID: `com.troli.app`
5. Save and copy the **client ID**
6. Put it in `/mobile/.env`:
   ```
   EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=<your-client-id>
   ```

## 5. Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey) (or **APIs & Services > Credentials** in Cloud Console)
2. Create an API key for the Gemini API
3. Put it in `/backend/.env`:
   ```
   GOOGLE_API_KEY=<your-api-key>
   ```

## 6. LangSmith

1. Go to [LangSmith](https://smith.langchain.com)
2. Create a new project named **troli-v1**
3. Go to **Settings > API Keys > Create API Key**
4. Put it in `/backend/.env`:
   ```
   LANGSMITH_API_KEY=<your-api-key>
   ```

The other LangSmith env vars (`LANGSMITH_TRACING=true`, `LANGSMITH_PROJECT=troli-v1`) are already in `.env.example`.

---

## Verification Checklist

- [x] GCP project created
- [x] Google Calendar API enabled
- [x] Google Tasks API enabled
- [x] Gmail API enabled
- [x] Generative Language API (Gemini) enabled
- [x] OAuth consent screen configured (external, testing mode)
- [x] Test user added
- [x] iOS OAuth client ID created with bundle ID `com.troli.app`
- [x] Gemini API key created
- [x] LangSmith project `troli-v1` created
- [x] LangSmith API key created
- [x] `/backend/.env` populated from `.env.example`
- [x] `/mobile/.env` populated from `.env.example`
