import { consumeSseStream, type SseEvent } from './sse';

const THREAD_POLL_INTERVAL_MS = 2000;
const THREAD_POLL_TIMEOUT_MS = 30000;

type LangGraphConfig = {
  assistantId: string;
  apiKey: string;
  apiUrl: string;
};

type LangGraphThreadResponse = {
  status?: LangGraphThreadStatus;
  thread_id?: string;
};

type LangGraphStateResponse = {
  values?: {
    messages?: unknown[];
  };
};

export type HydratedChatMessage = {
  id: string;
  role: 'assistant' | 'user';
  text: string;
  timestamp: number | null;
};

export type LangGraphThreadStatus = 'busy' | 'error' | 'idle' | 'interrupted';

export type StreamRunInput = {
  accessToken: string;
  message: string;
  onAssistantTextSnapshot?: (text: string) => void | Promise<void>;
  onEvent?: (event: ParsedSseEvent) => void | Promise<void>;
  signal?: AbortSignal;
  threadId: string;
  timezone: string;
};

export type ParsedSseEvent = SseEvent & {
  json: unknown | null;
};

export type BootstrapThreadResult = {
  messages: HydratedChatMessage[];
  status: LangGraphThreadStatus;
};

export function getMissingLangGraphConfig(): string[] {
  const missing: string[] = [];

  if (!process.env.EXPO_PUBLIC_LANGGRAPH_API_URL?.trim()) {
    missing.push('EXPO_PUBLIC_LANGGRAPH_API_URL');
  }

  if (!process.env.EXPO_PUBLIC_LANGGRAPH_API_KEY?.trim()) {
    missing.push('EXPO_PUBLIC_LANGGRAPH_API_KEY');
  }

  return missing;
}

export function isLangGraphConfigured(): boolean {
  return getMissingLangGraphConfig().length === 0;
}

export async function bootstrapThread(
  threadId: string,
): Promise<BootstrapThreadResult> {
  await createThread(threadId);

  let status = await getThreadStatus(threadId);

  if (status === 'busy') {
    status = await waitForThreadToSettle(threadId);
  }

  const messages = await hydrateThreadMessages(threadId);

  return { messages, status };
}

export async function hydrateThreadMessages(
  threadId: string,
): Promise<HydratedChatMessage[]> {
  const response = await fetchLangGraph<LangGraphStateResponse>(
    `/threads/${threadId}/state`,
    {
      method: 'GET',
    },
  );

  return normalizeThreadMessages(response.values?.messages ?? []);
}

export async function streamRun(input: StreamRunInput): Promise<void> {
  const response = await fetchLangGraphResponse(
    `/threads/${input.threadId}/runs/stream`,
    {
      body: JSON.stringify({
        assistant_id: getLangGraphConfig().assistantId,
        config: {
          configurable: {
            access_token: input.accessToken,
            timezone: input.timezone,
          },
        },
        input: {
          messages: [
            {
              content: input.message,
              role: 'human',
            },
          ],
        },
        stream_mode: ['messages'],
      }),
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: input.signal,
    },
  );

  await consumeSseStream({
    onEvent: async (event) => {
      if (!event.data || event.data === '[DONE]') {
        return;
      }

      const parsedEvent: ParsedSseEvent = {
        ...event,
        json: parseJson(event.data),
      };

      await input.onEvent?.(parsedEvent);

      if (event.event === 'messages/partial') {
        const snapshot = extractAssistantTextSnapshot(parsedEvent.json);

        if (snapshot) {
          await input.onAssistantTextSnapshot?.(snapshot);
        }
      }
    },
    response,
  });
}

async function createThread(threadId: string): Promise<void> {
  await fetchLangGraph('/threads', {
    body: JSON.stringify({
      if_exists: 'do_nothing',
      thread_id: threadId,
    }),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
}

async function getThreadStatus(
  threadId: string,
): Promise<LangGraphThreadStatus> {
  const response = await fetchLangGraph<LangGraphThreadResponse>(
    `/threads/${threadId}`,
    {
      method: 'GET',
    },
  );

  return response.status ?? 'idle';
}

async function waitForThreadToSettle(
  threadId: string,
): Promise<LangGraphThreadStatus> {
  const deadline = Date.now() + THREAD_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await delay(THREAD_POLL_INTERVAL_MS);

    const status = await getThreadStatus(threadId);

    if (status !== 'busy') {
      return status;
    }
  }

  return 'error';
}

async function fetchLangGraph<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetchLangGraphResponse(path, init);

  return (await response.json()) as T;
}

async function fetchLangGraphResponse(
  path: string,
  init: RequestInit,
): Promise<Response> {
  const config = getLangGraphConfig();

  const response = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'x-api-key': config.apiKey,
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw await buildLangGraphError(response, path, config.apiUrl);
  }

  return response;
}

async function buildLangGraphError(
  response: Response,
  path: string,
  apiUrl: string,
): Promise<Error> {
  const fallbackMessage = `LangGraph request to ${path} failed with status ${response.status}.`;
  const contentType = response.headers.get('content-type') ?? '';
  const likelyConfigIssue = buildLikelyConfigIssue(response.status, apiUrl);

  if (!contentType.includes('application/json')) {
    const bodyText = (await response.text()).trim();
    return new Error(
      [bodyText || fallbackMessage, likelyConfigIssue]
        .filter(Boolean)
        .join(' '),
    );
  }

  const payload = (await response.json()) as
    | { detail?: string; error?: string; message?: string }
    | undefined;

  return new Error(
    [
      payload?.detail ?? payload?.error ?? payload?.message ?? fallbackMessage,
      likelyConfigIssue,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

function getLangGraphConfig(): LangGraphConfig {
  const apiUrl = process.env.EXPO_PUBLIC_LANGGRAPH_API_URL?.trim() ?? '';
  const apiKey = process.env.EXPO_PUBLIC_LANGGRAPH_API_KEY?.trim() ?? '';
  const assistantId =
    process.env.EXPO_PUBLIC_LANGGRAPH_ASSISTANT_ID?.trim() || 'agent';

  if (!apiUrl || !apiKey) {
    const missing = getMissingLangGraphConfig();
    throw new Error(`Missing LangGraph config: ${missing.join(', ')}.`);
  }

  return {
    assistantId,
    apiKey,
    apiUrl: apiUrl.replace(/\/+$/, ''),
  };
}

function buildLikelyConfigIssue(status: number, apiUrl: string): string | null {
  if (status !== 404) {
    return null;
  }

  if (apiUrl.includes('api.smith.langchain.com')) {
    return 'EXPO_PUBLIC_LANGGRAPH_API_URL is pointing to LangSmith. Use your LangGraph deployment base URL instead.';
  }

  return 'Verify EXPO_PUBLIC_LANGGRAPH_API_URL points to the deployed LangGraph API base URL.';
}

function normalizeThreadMessages(messages: unknown[]): HydratedChatMessage[] {
  return messages
    .map((message, index) => normalizeThreadMessage(message, index))
    .filter((message): message is HydratedChatMessage => message !== null);
}

function normalizeThreadMessage(
  message: unknown,
  index: number,
): HydratedChatMessage | null {
  const role = extractMessageRole(message);
  const text = extractMessageText(message).trim();

  if (!role || !text) {
    return null;
  }

  return {
    id: extractMessageId(message) ?? `${role}-${index}`,
    role,
    text,
    timestamp: extractMessageTimestamp(message),
  };
}

function extractAssistantTextSnapshot(payload: unknown): string {
  return collectAssistantText(payload).join('');
}

function collectAssistantText(
  payload: unknown,
  assistantContext = false,
): string[] {
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

  const role = extractRoleValue(payload);
  const nextAssistantContext = assistantContext || role === 'assistant';
  const fragments: string[] = [];

  if (nextAssistantContext) {
    fragments.push(...flattenTextContent(payload.content));
    fragments.push(...flattenTextContent(payload.text));
    fragments.push(...flattenTextContent(payload.delta));
  }

  const nestedKeys = [
    'chunk',
    'data',
    'kwargs',
    'message',
    'messages',
    'value',
  ];

  for (const key of nestedKeys) {
    if (key in payload) {
      fragments.push(
        ...collectAssistantText(payload[key], nextAssistantContext),
      );
    }
  }

  return fragments;
}

function extractMessageId(message: unknown): string | null {
  const record = getPrimaryRecord(message);

  if (!record) {
    return null;
  }

  const directId = typeof record.id === 'string' ? record.id : null;

  if (directId) {
    return directId;
  }

  const kwargs = isRecord(record.kwargs) ? record.kwargs : null;

  return kwargs && typeof kwargs.id === 'string' ? kwargs.id : null;
}

function extractMessageRole(
  message: unknown,
): HydratedChatMessage['role'] | null {
  const record = getPrimaryRecord(message);

  if (!record) {
    return null;
  }

  return extractRoleValue(record);
}

function extractRoleValue(
  record: Record<string, unknown>,
): HydratedChatMessage['role'] | null {
  const candidates = [
    record.role,
    record.type,
    isRecord(record.kwargs) ? record.kwargs.role : undefined,
    isRecord(record.kwargs) ? record.kwargs.type : undefined,
    extractLangChainMessageName(record),
  ];

  for (const candidate of candidates) {
    if (
      candidate === 'ai' ||
      candidate === 'AIMessage' ||
      candidate === 'AIMessageChunk'
    ) {
      return 'assistant';
    }

    if (
      candidate === 'assistant' ||
      candidate === 'human' ||
      candidate === 'HumanMessage' ||
      candidate === 'user'
    ) {
      return candidate === 'assistant' ? 'assistant' : 'user';
    }
  }

  return null;
}

function extractMessageText(message: unknown): string {
  const record = getPrimaryRecord(message);

  if (!record) {
    return '';
  }

  const fragments = [
    ...flattenTextContent(record.content),
    ...flattenTextContent(
      isRecord(record.kwargs) ? record.kwargs.content : undefined,
    ),
  ];

  return fragments.join('').trim();
}

function extractMessageTimestamp(message: unknown): number | null {
  const record = getPrimaryRecord(message);

  if (!record) {
    return null;
  }

  const candidates = [
    getTimestampValue(record.additional_kwargs),
    getTimestampValue(
      isRecord(record.kwargs) ? record.kwargs.additional_kwargs : undefined,
    ),
  ];

  return candidates.find((value) => value !== null) ?? null;
}

function extractLangChainMessageName(
  record: Record<string, unknown>,
): string | null {
  if (!Array.isArray(record.id)) {
    return null;
  }

  const name = record.id.at(-1);
  return typeof name === 'string' ? name : null;
}

function flattenTextContent(content: unknown): string[] {
  if (typeof content === 'string') {
    return [content];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) => {
    if (typeof part === 'string') {
      return [part];
    }

    if (!isRecord(part)) {
      return [];
    }

    if (typeof part.text === 'string') {
      return [part.text];
    }

    if (part.type === 'text' && typeof part.value === 'string') {
      return [part.value];
    }

    return [];
  });
}

function getPrimaryRecord(message: unknown): Record<string, unknown> | null {
  if (!isRecord(message)) {
    return null;
  }

  return message;
}

function getTimestampValue(value: unknown): number | null {
  if (!isRecord(value)) {
    return null;
  }

  const timestamp = value.timestamp;

  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return timestamp;
  }

  if (typeof timestamp === 'string') {
    const parsed = Number(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
