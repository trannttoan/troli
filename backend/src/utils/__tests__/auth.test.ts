import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TroliAuthError,
  validateGoogleToken,
  verifyThreadAuthorization,
} from "../auth.js";
import { generateThreadId } from "../thread.js";

describe("validateGoogleToken", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("normalizes the validated Google email address", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ email: "Person@Example.com" }), {
        headers: {
          "content-type": "application/json",
        },
        status: 200,
      }),
    );

    const result = await validateGoogleToken({
      configurable: {
        access_token: "google-access-token",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/tokeninfo?access_token=google-access-token",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toEqual({ email: "person@example.com" });
  });

  it("returns an auth error when Google rejects the token", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_token" }), {
        headers: {
          "content-type": "application/json",
        },
        status: 401,
      }),
    );

    await expect(
      validateGoogleToken({
        configurable: {
          access_token: "expired-token",
        },
      }),
    ).rejects.toMatchObject<TroliAuthError>({
      code: "AUTH_INVALID_TOKEN",
      retryable: false,
      status: 401,
    });
  });

  it("returns an auth error when the tokeninfo payload has no valid email", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ sub: "123" }), {
        headers: {
          "content-type": "application/json",
        },
        status: 200,
      }),
    );

    await expect(
      validateGoogleToken({
        configurable: {
          access_token: "bad-payload",
        },
      }),
    ).rejects.toMatchObject<TroliAuthError>({
      code: "AUTH_INVALID_TOKEN",
      retryable: false,
      status: 401,
    });
  });
});

describe("verifyThreadAuthorization", () => {
  it("accepts the expected deterministic thread id", () => {
    const email = "person@example.com";

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

  it("rejects a mismatched thread id", () => {
    expect(() =>
      verifyThreadAuthorization(
        {
          configurable: {
            thread_id: generateThreadId("other@example.com"),
          },
        },
        "person@example.com",
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "AUTH_THREAD_MISMATCH",
        retryable: false,
        status: 403,
      }),
    );
  });
});
