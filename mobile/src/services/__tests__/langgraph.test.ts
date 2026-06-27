import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

jest.mock('../sse', () => ({
  consumeSseStream: jest.fn(),
}));

import { consumeSseStream } from '../sse';
import {
  bootstrapThread,
  getMissingLangGraphConfig,
  hydrateThreadMessages,
  isLangGraphConfigured,
  streamRun,
} from '../langgraph';

function createJsonResponse(
  payload: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json',
    },
    status: 200,
    ...init,
  });
}

describe('langgraph service', () => {
  const fetchMock = jest.fn<typeof fetch>();

  beforeEach(() => {
    global.fetch = fetchMock as typeof fetch;
    process.env.EXPO_PUBLIC_LANGGRAPH_API_KEY = 'langgraph-api-key';
    process.env.EXPO_PUBLIC_LANGGRAPH_API_URL =
      'https://langgraph.example.com/';
    process.env.EXPO_PUBLIC_LANGGRAPH_ASSISTANT_ID = 'agent';
  });

  afterEach(() => {
    fetchMock.mockReset();
    jest.clearAllMocks();
  });

  it('bootstraps the thread, then hydrates normalized messages', async () => {
    fetchMock
      .mockResolvedValueOnce(createJsonResponse({ thread_id: 'thread-123' }))
      .mockResolvedValueOnce(
        createJsonResponse({
          status: 'idle',
          thread_id: 'thread-123',
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          values: {
            messages: [
              {
                additional_kwargs: {
                  timestamp: 1_700_000_000_000,
                },
                content: 'Hello',
                id: 'user-1',
                role: 'human',
              },
              {
                content: [{ text: 'Hi ' }, { text: 'there' }],
                id: 'assistant-1',
                kwargs: {
                  additional_kwargs: {
                    timestamp: '1700000000500',
                  },
                },
                type: 'ai',
              },
            ],
          },
        }),
      );

    await expect(bootstrapThread('thread-123')).resolves.toEqual({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'Hello',
          timestamp: 1_700_000_000_000,
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          text: 'Hi there',
          timestamp: 1_700_000_000_500,
        },
      ],
      status: 'idle',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://langgraph.example.com/threads',
      expect.objectContaining({
        body: JSON.stringify({
          if_exists: 'do_nothing',
          thread_id: 'thread-123',
        }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-api-key': 'langgraph-api-key',
        }),
        method: 'POST',
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://langgraph.example.com/threads/thread-123/state',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
          'x-api-key': 'langgraph-api-key',
        }),
        method: 'GET',
      }),
    );
  });

  it('parses streamed chunk payloads into assistant text snapshots', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        headers: {
          'content-type': 'text/event-stream',
        },
        status: 200,
      }),
    );

    jest.mocked(consumeSseStream).mockImplementation(async ({ onEvent }) => {
      await onEvent({
        data: JSON.stringify({
          chunk: {
            delta: [{ text: 'Hello' }],
            role: 'assistant',
          },
        }),
        event: 'message',
      });
      await onEvent({
        data: JSON.stringify({
          data: {
            message: {
              content: [{ text: 'Hello world' }],
              role: 'assistant',
            },
          },
        }),
        event: 'message',
      });
      await onEvent({
        data: '[DONE]',
        event: 'message',
      });
    });

    const onAssistantTextSnapshot = jest.fn<() => Promise<void>>();
    const onEvent = jest.fn<() => Promise<void>>();

    await streamRun({
      accessToken: 'google-access-token',
      message: 'Tell me something useful.',
      onAssistantTextSnapshot,
      onEvent,
      threadId: 'thread-123',
      timezone: 'America/Detroit',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://langgraph.example.com/threads/thread-123/runs/stream',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'x-api-key': 'langgraph-api-key',
        }),
        method: 'POST',
      }),
    );
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onAssistantTextSnapshot).toHaveBeenNthCalledWith(1, 'Hello');
    expect(onAssistantTextSnapshot).toHaveBeenNthCalledWith(2, 'Hello world');
  });

  it('polls until the thread settles when status is busy', async () => {
    fetchMock
      .mockResolvedValueOnce(createJsonResponse({ thread_id: 'thread-123' }))
      .mockResolvedValueOnce(createJsonResponse({ status: 'busy' }))
      .mockResolvedValueOnce(createJsonResponse({ status: 'busy' }))
      .mockResolvedValueOnce(createJsonResponse({ status: 'idle' }))
      .mockResolvedValueOnce(createJsonResponse({ values: { messages: [] } }));

    jest.useFakeTimers();

    const promise = bootstrapThread('thread-123');

    await jest.advanceTimersByTimeAsync(2000);
    await jest.advanceTimersByTimeAsync(2000);

    const result = await promise;

    jest.useRealTimers();

    expect(result.status).toBe('idle');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('throws when the langgraph api returns an error response', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Not found' }), {
        headers: { 'content-type': 'application/json' },
        status: 404,
      }),
    );

    await expect(bootstrapThread('thread-123')).rejects.toThrow('Not found');
  });

  it('throws with config hint when 404 and url points to langsmith', async () => {
    process.env.EXPO_PUBLIC_LANGGRAPH_API_URL =
      'https://api.smith.langchain.com/';

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Not found' }), {
        headers: { 'content-type': 'application/json' },
        status: 404,
      }),
    );

    await expect(bootstrapThread('thread-123')).rejects.toThrow(
      'EXPO_PUBLIC_LANGGRAPH_API_URL is pointing to LangSmith',
    );
  });

  it('throws with a non-json error body as the message', async () => {
    fetchMock.mockResolvedValue(
      new Response('Bad Gateway', {
        headers: { 'content-type': 'text/plain' },
        status: 502,
      }),
    );

    await expect(bootstrapThread('thread-123')).rejects.toThrow('Bad Gateway');
  });

  it('filters out messages with no role or empty text during hydration', async () => {
    fetchMock
      .mockResolvedValueOnce(createJsonResponse({ thread_id: 'thread-123' }))
      .mockResolvedValueOnce(createJsonResponse({ status: 'idle' }))
      .mockResolvedValueOnce(
        createJsonResponse({
          values: {
            messages: [
              { content: 'Hello', id: 'msg-1', role: 'human' },
              { content: '', id: 'msg-2', role: 'ai' },
              { content: 'No role', id: 'msg-3' },
              { content: 'Reply', role: 'assistant' },
            ],
          },
        }),
      );

    const result = await bootstrapThread('thread-123');

    expect(result.messages).toEqual([
      { id: 'msg-1', role: 'user', text: 'Hello', timestamp: null },
      { id: 'assistant-3', role: 'assistant', text: 'Reply', timestamp: null },
    ]);
  });

  it('generates a fallback id when the message has no id field', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({
        values: {
          messages: [{ content: 'Hello', role: 'human' }],
        },
      }),
    );

    const messages = await hydrateThreadMessages('thread-123');

    expect(messages[0]?.id).toBe('user-0');
  });
});

describe('getMissingLangGraphConfig', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_LANGGRAPH_API_URL;
    delete process.env.EXPO_PUBLIC_LANGGRAPH_API_KEY;
  });

  it('returns missing env var names when unset', () => {
    delete process.env.EXPO_PUBLIC_LANGGRAPH_API_URL;
    delete process.env.EXPO_PUBLIC_LANGGRAPH_API_KEY;

    expect(getMissingLangGraphConfig()).toEqual([
      'EXPO_PUBLIC_LANGGRAPH_API_URL',
      'EXPO_PUBLIC_LANGGRAPH_API_KEY',
    ]);
  });

  it('returns an empty array when all vars are set', () => {
    process.env.EXPO_PUBLIC_LANGGRAPH_API_URL = 'https://example.com';
    process.env.EXPO_PUBLIC_LANGGRAPH_API_KEY = 'key';

    expect(getMissingLangGraphConfig()).toEqual([]);
  });
});

describe('isLangGraphConfigured', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_LANGGRAPH_API_URL;
    delete process.env.EXPO_PUBLIC_LANGGRAPH_API_KEY;
  });

  it('returns false when config is missing', () => {
    delete process.env.EXPO_PUBLIC_LANGGRAPH_API_URL;
    delete process.env.EXPO_PUBLIC_LANGGRAPH_API_KEY;

    expect(isLangGraphConfigured()).toBe(false);
  });

  it('returns true when config is present', () => {
    process.env.EXPO_PUBLIC_LANGGRAPH_API_URL = 'https://example.com';
    process.env.EXPO_PUBLIC_LANGGRAPH_API_KEY = 'key';

    expect(isLangGraphConfigured()).toBe(true);
  });
});
