import { describe, expect, it } from '@jest/globals';

import { consumeSseStream } from '../sse';

function createStreamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }

      controller.close();
    },
  });

  return {
    body: stream,
  } as Response;
}

describe('consumeSseStream', () => {
  it('reassembles chunked multi-line SSE events', async () => {
    const events: Array<{ data: string; event: string; id?: string }> = [];

    await consumeSseStream({
      onEvent: async (event) => {
        events.push(event);
      },
      response: createStreamingResponse([
        'event: completion\nid: evt-1\ndata: hello',
        '\ndata: world\n\n',
      ]),
    });

    expect(events).toEqual([
      {
        data: 'hello\nworld',
        event: 'completion',
        id: 'evt-1',
      },
    ]);
  });

  it('flushes an incomplete trailing event when the stream ends', async () => {
    const events: Array<{ data: string; event: string; id?: string }> = [];

    await consumeSseStream({
      onEvent: async (event) => {
        events.push(event);
      },
      response: createStreamingResponse(['data: trailing payload']),
    });

    expect(events).toEqual([
      {
        data: 'trailing payload',
        event: 'message',
        id: undefined,
      },
    ]);
  });

  it('ignores comments and malformed fields that are not part of the event payload', async () => {
    const events: Array<{ data: string; event: string; id?: string }> = [];

    await consumeSseStream({
      onEvent: async (event) => {
        events.push(event);
      },
      response: createStreamingResponse([
        ': keepalive\nretry: 1000\nbogus-field\ndata: usable\n\n',
      ]),
    });

    expect(events).toEqual([
      {
        data: 'usable',
        event: 'message',
        id: undefined,
      },
    ]);
  });

  it('throws when the response body is null', async () => {
    await expect(
      consumeSseStream({
        onEvent: async () => {},
        response: { body: null } as Response,
      }),
    ).rejects.toThrow('Streaming response body is unavailable.');
  });

  it('parses multiple events delivered in a single chunk', async () => {
    const events: Array<{ data: string; event: string; id?: string }> = [];

    await consumeSseStream({
      onEvent: async (event) => {
        events.push(event);
      },
      response: createStreamingResponse([
        'data: first\n\nevent: custom\ndata: second\n\n',
      ]),
    });

    expect(events).toEqual([
      { data: 'first', event: 'message', id: undefined },
      { data: 'second', event: 'custom', id: undefined },
    ]);
  });

  it('handles \\r\\n line endings', async () => {
    const events: Array<{ data: string; event: string; id?: string }> = [];

    await consumeSseStream({
      onEvent: async (event) => {
        events.push(event);
      },
      response: createStreamingResponse(['event: ping\r\ndata: pong\r\n\r\n']),
    });

    expect(events).toEqual([{ data: 'pong', event: 'ping', id: undefined }]);
  });

  it('emits no events for an empty stream', async () => {
    const events: Array<{ data: string; event: string }> = [];

    await consumeSseStream({
      onEvent: async (event) => {
        events.push(event);
      },
      response: createStreamingResponse([]),
    });

    expect(events).toEqual([]);
  });
});
