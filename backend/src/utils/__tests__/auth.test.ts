import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AisistAuthError,
  isAisistAuthError,
  validateGoogleToken,
  verifyThreadAuthorization,
} from '../auth.js';
import { generateThreadId } from '../thread.js';

describe('validateGoogleToken', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('normalizes the validated Google email address', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ email: 'Person@Example.com' }), {
        headers: {
          'content-type': 'application/json',
        },
        status: 200,
      }),
    );

    const result = await validateGoogleToken({
      configurable: {
        access_token: 'google-access-token',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/tokeninfo?access_token=google-access-token',
      expect.objectContaining({
        method: 'GET',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toEqual({ email: 'person@example.com' });
  });

  it('returns an auth error when Google rejects the token', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_token' }), {
        headers: {
          'content-type': 'application/json',
        },
        status: 401,
      }),
    );

    await expect(
      validateGoogleToken({
        configurable: {
          access_token: 'expired-token',
        },
      }),
    ).rejects.toMatchObject<AisistAuthError>({
      code: 'AUTH_INVALID_TOKEN',
      retryable: false,
      status: 401,
    });
  });

  it('returns an auth error when the tokeninfo payload has no valid email', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ sub: '123' }), {
        headers: {
          'content-type': 'application/json',
        },
        status: 200,
      }),
    );

    await expect(
      validateGoogleToken({
        configurable: {
          access_token: 'bad-payload',
        },
      }),
    ).rejects.toMatchObject<AisistAuthError>({
      code: 'AUTH_INVALID_TOKEN',
      retryable: false,
      status: 401,
    });
  });

  it('returns a retryable error when Google returns a 5xx status', async () => {
    fetchMock.mockResolvedValue(
      new Response('Internal Server Error', { status: 502 }),
    );

    await expect(
      validateGoogleToken({
        configurable: {
          access_token: 'valid-token',
        },
      }),
    ).rejects.toMatchObject<AisistAuthError>({
      code: 'AUTH_TOKENINFO_UNAVAILABLE',
      retryable: true,
      status: 503,
    });
  });

  it('returns a retryable error when the request times out', async () => {
    fetchMock.mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError'),
    );

    await expect(
      validateGoogleToken({
        configurable: {
          access_token: 'valid-token',
        },
      }),
    ).rejects.toMatchObject<AisistAuthError>({
      code: 'AUTH_TOKENINFO_UNAVAILABLE',
      retryable: true,
      status: 503,
    });
  });

  it('returns a retryable error on a transient network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      validateGoogleToken({
        configurable: {
          access_token: 'valid-token',
        },
      }),
    ).rejects.toMatchObject<AisistAuthError>({
      code: 'AUTH_TOKENINFO_UNAVAILABLE',
      retryable: true,
      status: 503,
    });
  });

  it('throws when the access token is missing from the config', async () => {
    await expect(
      validateGoogleToken({ configurable: {} }),
    ).rejects.toMatchObject<AisistAuthError>({
      code: 'AUTH_MISSING_ACCESS_TOKEN',
      retryable: false,
      status: 401,
    });
  });
});

describe('isAisistAuthError', () => {
  it('returns true for AisistAuthError instances', () => {
    const error = new AisistAuthError('AUTH_INVALID_TOKEN', 'test', {
      retryable: false,
      status: 401,
    });

    expect(isAisistAuthError(error)).toBe(true);
  });

  it('returns false for plain Error instances', () => {
    expect(isAisistAuthError(new Error('test'))).toBe(false);
  });
});

describe('verifyThreadAuthorization', () => {
  it('accepts the expected deterministic thread id', () => {
    const email = 'person@example.com';

    expect(() =>
      verifyThreadAuthorization(
        {
          configurable: {
            thread_id: generateThreadId(email),
          },
        },
        email,
      ),
    ).not.toThrow();
  });

  it('throws when the thread id is missing from the config', () => {
    expect(() =>
      verifyThreadAuthorization({ configurable: {} }, 'person@example.com'),
    ).toThrowError(
      expect.objectContaining({
        code: 'AUTH_THREAD_MISMATCH',
        retryable: false,
        status: 403,
      }),
    );
  });

  it('rejects a mismatched thread id', () => {
    expect(() =>
      verifyThreadAuthorization(
        {
          configurable: {
            thread_id: generateThreadId('other@example.com'),
          },
        },
        'person@example.com',
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'AUTH_THREAD_MISMATCH',
        retryable: false,
        status: 403,
      }),
    );
  });
});
