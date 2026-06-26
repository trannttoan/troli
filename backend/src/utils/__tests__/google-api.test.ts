import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TroliAuthError } from '../auth.js';
import { GoogleApiError, fetchWithAuth } from '../google-api.js';

describe('fetchWithAuth', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('adds the bearer token header and parses the JSON response', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ items: [{ id: 'event-1' }] }), {
        headers: {
          'content-type': 'application/json',
        },
        status: 200,
      }),
    );

    const result = await fetchWithAuth<{ items: Array<{ id: string }> }>(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        headers: {
          'x-test-header': 'present',
        },
        method: 'GET',
      },
      'calendar-access-token',
    );

    expect(result).toEqual({ items: [{ id: 'event-1' }] });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      expect.objectContaining({
        headers: expect.any(Headers),
        method: 'GET',
      }),
    );

    const requestInit = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(requestInit.headers);

    expect(headers.get('authorization')).toBe('Bearer calendar-access-token');
    expect(headers.get('x-test-header')).toBe('present');
  });

  it('maps 401 responses to TroliAuthError', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_token' }), {
        headers: {
          'content-type': 'application/json',
        },
        status: 401,
      }),
    );

    await expect(
      fetchWithAuth(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {},
        'expired-token',
      ),
    ).rejects.toMatchObject<TroliAuthError>({
      code: 'AUTH_INVALID_TOKEN',
      retryable: false,
      status: 401,
    });
  });

  it('maps 403 responses to insufficient scope errors', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'forbidden' }), {
        headers: {
          'content-type': 'application/json',
        },
        status: 403,
      }),
    );

    await expect(
      fetchWithAuth(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {},
        'missing-scope-token',
      ),
    ).rejects.toMatchObject<GoogleApiError>({
      code: 'GOOGLE_API_INSUFFICIENT_SCOPE',
      retryable: false,
      status: 403,
    });
  });

  it('maps 429 responses to retryable rate limit errors', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate_limited' }), {
        headers: {
          'content-type': 'application/json',
        },
        status: 429,
      }),
    );

    await expect(
      fetchWithAuth(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {},
        'valid-token',
      ),
    ).rejects.toMatchObject<GoogleApiError>({
      code: 'GOOGLE_API_RATE_LIMITED',
      retryable: true,
      status: 429,
    });
  });

  it('maps network failures to retryable request errors', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      fetchWithAuth(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {},
        'valid-token',
      ),
    ).rejects.toMatchObject<GoogleApiError>({
      code: 'GOOGLE_API_REQUEST_FAILED',
      retryable: true,
      status: 503,
    });
  });
});
