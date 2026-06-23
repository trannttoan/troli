import { TroliAuthError } from "./auth.js";

type GoogleApiErrorCode =
  | "GOOGLE_API_INSUFFICIENT_SCOPE"
  | "GOOGLE_API_RATE_LIMITED"
  | "GOOGLE_API_REQUEST_FAILED";

export class GoogleApiError extends Error {
  readonly code: GoogleApiErrorCode;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    code: GoogleApiErrorCode,
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
    this.name = "GoogleApiError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export function isGoogleApiError(error: unknown): error is GoogleApiError {
  return error instanceof GoogleApiError;
}

export async function fetchWithAuth<T>(
  url: string,
  init: RequestInit = {},
  accessToken: string,
): Promise<T> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: buildHeaders(init.headers, accessToken),
    });

    if (response.status === 401) {
      throw new TroliAuthError(
        "AUTH_INVALID_TOKEN",
        "Google access token is invalid or expired. Sign in again.",
        {
          retryable: false,
          status: 401,
        },
      );
    }

    if (response.status === 403) {
      throw new GoogleApiError(
        "GOOGLE_API_INSUFFICIENT_SCOPE",
        "Google calendar access is missing required permissions. Sign in again to grant calendar access.",
        {
          retryable: false,
          status: 403,
        },
      );
    }

    if (response.status === 429) {
      throw new GoogleApiError(
        "GOOGLE_API_RATE_LIMITED",
        "Google API rate limit reached. Retry the request shortly.",
        {
          retryable: true,
          status: 429,
        },
      );
    }

    if (!response.ok) {
      throw new GoogleApiError(
        "GOOGLE_API_REQUEST_FAILED",
        `Google API request failed with status ${response.status}.`,
        {
          retryable: response.status >= 500,
          status: response.status,
        },
      );
    }

    return parseJsonResponse<T>(response);
  } catch (error) {
    if (error instanceof TroliAuthError || error instanceof GoogleApiError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      throw new GoogleApiError(
        "GOOGLE_API_REQUEST_FAILED",
        "Google API request timed out. Retry the request.",
        {
          retryable: true,
          status: 503,
        },
      );
    }

    if (error instanceof TypeError) {
      throw new GoogleApiError(
        "GOOGLE_API_REQUEST_FAILED",
        "Google API request failed due to a network error. Retry the request.",
        {
          retryable: true,
          status: 503,
        },
      );
    }

    throw error;
  }
}

function buildHeaders(
  headersInit: HeadersInit | undefined,
  accessToken: string,
): Headers {
  const headers = new Headers(headersInit);

  headers.set("Authorization", `Bearer ${accessToken}`);

  return headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return null as T;
  }

  const responseText = await response.text();

  if (responseText.trim() === "") {
    return null as T;
  }

  try {
    return JSON.parse(responseText) as T;
  } catch {
    throw new GoogleApiError(
      "GOOGLE_API_REQUEST_FAILED",
      "Google API returned an invalid JSON response.",
      {
        retryable: true,
        status: 502,
      },
    );
  }
}
