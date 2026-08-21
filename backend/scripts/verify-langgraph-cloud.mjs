import process from 'node:process';
import { v5 as uuidv5 } from 'uuid';

const AISIST_NAMESPACE = 'e587b8a0-3e1a-4c5d-9f2b-1a8c4d6e7f90';
const DEFAULT_ASSISTANT_ID = 'agent';
const DEFAULT_MESSAGE = 'Say hello in one short sentence.';
const DEFAULT_TIMEZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Detroit';

async function main() {
  const apiUrl = getRequiredEnv('LANGGRAPH_API_URL').replace(/\/+$/, '');
  const apiKey = getRequiredEnv('LANGGRAPH_API_KEY');
  const accessToken = getRequiredEnv('GOOGLE_ACCESS_TOKEN');
  const email = getRequiredEnv('GOOGLE_ACCOUNT_EMAIL').trim().toLowerCase();
  const assistantId =
    process.env.LANGGRAPH_ASSISTANT_ID?.trim() || DEFAULT_ASSISTANT_ID;
  const message = process.env.LANGGRAPH_TEST_MESSAGE?.trim() || DEFAULT_MESSAGE;
  const timezone = process.env.LANGGRAPH_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
  const threadId =
    process.env.LANGGRAPH_THREAD_ID?.trim() || uuidv5(email, AISIST_NAMESPACE);

  await createThread({ apiKey, apiUrl, threadId });

  const thread = await fetchJson(`${apiUrl}/threads/${threadId}`, {
    headers: buildHeaders(apiKey),
    method: 'GET',
  });

  const streamResponse = await fetch(
    `${apiUrl}/threads/${threadId}/runs/stream`,
    {
      body: JSON.stringify({
        assistant_id: assistantId,
        config: {
          configurable: {
            access_token: accessToken,
            timezone,
          },
        },
        input: {
          messages: [
            {
              content: message,
              role: 'human',
            },
          ],
        },
        stream_mode: ['messages'],
      }),
      headers: {
        ...buildHeaders(apiKey),
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    },
  );

  if (!streamResponse.ok) {
    throw new Error(await buildHttpError(streamResponse));
  }

  const summary = await consumeSseStream(streamResponse);

  if (!summary.sawEvent) {
    throw new Error('LangGraph returned no SSE events.');
  }

  if (!summary.assistantText.trim()) {
    throw new Error('LangGraph SSE stream completed without assistant output.');
  }

  console.log(`assistant_id=${assistantId}`);
  console.log(`thread_id=${threadId}`);
  console.log(`thread_status=${thread?.status ?? 'unknown'}`);
  console.log(`assistant_text=${summary.assistantText.trim()}`);
}

async function createThread({ apiKey, apiUrl, threadId }) {
  const response = await fetch(`${apiUrl}/threads`, {
    body: JSON.stringify({
      if_exists: 'do_nothing',
      thread_id: threadId,
    }),
    headers: {
      ...buildHeaders(apiKey),
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(await buildHttpError(response));
  }
}

function buildHeaders(apiKey) {
  return {
    'x-api-key': apiKey,
  };
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);

  if (!response.ok) {
    throw new Error(await buildHttpError(response));
  }

  return response.json();
}

async function consumeSseStream(response) {
  if (!response.body) {
    throw new Error('LangGraph response did not include a readable stream.');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let sawEvent = false;
  let assistantText = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');

    while (true) {
      const delimiterIndex = buffer.indexOf('\n\n');

      if (delimiterIndex === -1) {
        break;
      }

      const rawEvent = buffer.slice(0, delimiterIndex);
      buffer = buffer.slice(delimiterIndex + 2);

      const event = parseSseEvent(rawEvent);

      if (!event?.data || event.data === '[DONE]') {
        continue;
      }

      sawEvent = true;
      assistantText = mergeAssistantText(
        assistantText,
        extractAssistantText(event.data),
      );
    }
  }

  const trailingEvent = parseSseEvent(buffer.trim());

  if (trailingEvent?.data && trailingEvent.data !== '[DONE]') {
    sawEvent = true;
    assistantText = mergeAssistantText(
      assistantText,
      extractAssistantText(trailingEvent.data),
    );
  }

  return { assistantText, sawEvent };
}

function parseSseEvent(rawEvent) {
  if (!rawEvent) {
    return null;
  }

  const lines = rawEvent.split(/\r?\n/);
  let event = 'message';
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim() || 'message';
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  return {
    data: dataLines.join('\n'),
    event,
  };
}

function extractAssistantText(data) {
  let parsed;

  try {
    parsed = JSON.parse(data);
  } catch {
    return '';
  }

  return collectAssistantText(parsed).join('');
}

function mergeAssistantText(previousText, nextText) {
  if (!nextText) {
    return previousText;
  }

  if (!previousText || nextText.startsWith(previousText)) {
    return nextText;
  }

  return `${previousText}${nextText}`;
}

function collectAssistantText(payload, assistantContext = false) {
  if (typeof payload === 'string') {
    return assistantContext ? [payload] : [];
  }

  if (Array.isArray(payload)) {
    return payload.flatMap((item) =>
      collectAssistantText(item, assistantContext),
    );
  }

  if (!isRecord(payload)) {
    return [];
  }

  const role = getRole(payload);
  const nextAssistantContext = assistantContext || role === 'assistant';
  const fragments = [];

  if (nextAssistantContext) {
    fragments.push(...flattenText(payload.content));
    fragments.push(...flattenText(payload.text));
    fragments.push(...flattenText(payload.delta));
  }

  for (const key of [
    'chunk',
    'data',
    'kwargs',
    'message',
    'messages',
    'value',
  ]) {
    if (key in payload) {
      fragments.push(
        ...collectAssistantText(payload[key], nextAssistantContext),
      );
    }
  }

  return fragments;
}

function flattenText(value) {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenText(item));
  }

  if (!isRecord(value)) {
    return [];
  }

  return [
    ...flattenText(value.text),
    ...flattenText(value.content),
    ...flattenText(value.value),
  ];
}

function getRole(payload) {
  const role = payload.role ?? payload.type;
  return typeof role === 'string' ? role : null;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

async function buildHttpError(response) {
  const body = (await response.text()).trim();
  return body || `Request failed with status ${response.status}.`;
}

function getRequiredEnv(key) {
  const value = process.env[key]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
