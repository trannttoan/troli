import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';

import { generateThreadId } from './thread.js';

const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_TOKENINFO_TIMEOUT_MS = 3000;

const tokenInfoSchema = z.object({
  email: z.string().email(),
});

type AuthErrorCode =
  | 'AUTH_INVALID_TOKEN'
  | 'AUTH_MISSING_ACCESS_TOKEN'
  | 'AUTH_THREAD_MISMATCH'
  | 'AUTH_TOKENINFO_UNAVAILABLE';

export class AisistAuthError extends Error {
  readonly code: AuthErrorCode;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    code: AuthErrorCode,
    message: string,
    {
      retryable,
      status,
    }: {
      retryable: boolean;
      status: number;
    },
  ) {
    super(message);
    this.name = 'AisistAuthError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export function isAisistAuthError(error: unknown): error is AisistAuthError {
  return error instanceof AisistAuthError;
}

export async function validateGoogleToken(
  config: LangGraphRunnableConfig,
): Promise<{ email: string }> {
  const accessToken = getRequiredConfigurableString(config, 'access_token', {
    code: 'AUTH_MISSING_ACCESS_TOKEN',
    message: 'Missing Google access token in run config.',
    retryable: false,
    status: 401,
  });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    GOOGLE_TOKENINFO_TIMEOUT_MS,
  );

  try {
    const response = await fetch(
      `${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'GET',
        signal: controller.signal,
      },
    );

    if (response.status >= 500) {
      throw new AisistAuthError(
        'AUTH_TOKENINFO_UNAVAILABLE',
        'Google token validation is temporarily unavailable. Retry the request.',
        {
          retryable: true,
          status: 503,
        },
      );
    }

    if (response.status >= 400) {
      throw new AisistAuthError(
        'AUTH_INVALID_TOKEN',
        'Google access token is invalid or expired. Sign in again.',
        {
          retryable: false,
          status: 401,
        },
      );
    }

    const payload = tokenInfoSchema.parse(await response.json());

    return {
      email: payload.email.trim().toLowerCase(),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AisistAuthError(
        'AUTH_TOKENINFO_UNAVAILABLE',
        'Google token validation timed out. Retry the request.',
        {
          retryable: true,
          status: 503,
        },
      );
    }

    if (error instanceof z.ZodError) {
      throw new AisistAuthError(
        'AUTH_INVALID_TOKEN',
        'Google token validation response was missing a valid email.',
        {
          retryable: false,
          status: 401,
        },
      );
    }

    if (error instanceof AisistAuthError) {
      throw error;
    }

    throw new AisistAuthError(
      'AUTH_TOKENINFO_UNAVAILABLE',
      'Google token validation failed due to a transient error. Retry the request.',
      {
        retryable: true,
        status: 503,
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function verifyThreadAuthorization(
  config: LangGraphRunnableConfig,
  email: string,
): void {
  const threadId = getRequiredConfigurableString(config, 'thread_id', {
    code: 'AUTH_THREAD_MISMATCH',
    message: 'Missing thread ID in run config.',
    retryable: false,
    status: 403,
  });
  const expectedThreadId = generateThreadId(email);

  if (threadId !== expectedThreadId) {
    throw new AisistAuthError(
      'AUTH_THREAD_MISMATCH',
      'Thread ID does not match the authenticated user.',
      {
        retryable: false,
        status: 403,
      },
    );
  }
}

function getRequiredConfigurableString(
  config: LangGraphRunnableConfig,
  key: string,
  error: {
    code: AuthErrorCode;
    message: string;
    retryable: boolean;
    status: number;
  },
): string {
  const configurable = config.configurable as
    | Record<string, unknown>
    | undefined;
  const value = configurable?.[key];

  if (typeof value !== 'string' || value.trim() === '') {
    throw new AisistAuthError(error.code, error.message, {
      retryable: error.retryable,
      status: error.status,
    });
  }

  return value.trim();
}
