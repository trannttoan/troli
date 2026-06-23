import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TroliAuthError } from "../utils/auth.js";
import { generateThreadId } from "../utils/thread.js";
import { getMessageTimestamp, stampMessage } from "../utils/timestamp.js";

const modelInvokeSpy = vi.fn();

vi.mock("@langchain/google-genai", () => {
  return {
    ChatGoogleGenerativeAI: class MockChatGoogleGenerativeAI {
      invoke = modelInvokeSpy;
    },
  };
});

vi.mock("../utils/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/auth.js")>();

  return {
    ...actual,
    validateGoogleToken: vi.fn(),
    verifyThreadAuthorization: vi.fn(),
  };
});

import { graph } from "../agent.js";
import {
  validateGoogleToken,
  verifyThreadAuthorization,
} from "../utils/auth.js";

const FIXED_TIMESTAMP = Date.UTC(2026, 0, 15, 10, 0, 0);
const TEST_EMAIL = "test@example.com";
const TEST_THREAD_ID = generateThreadId(TEST_EMAIL);

function buildConfig(overrides: Record<string, unknown> = {}) {
  return {
    configurable: {
      access_token: "test-access-token",
      thread_id: TEST_THREAD_ID,
      timezone: "America/New_York",
      ...overrides,
    },
  };
}

describe("agent graph", () => {
  beforeEach(() => {
    modelInvokeSpy.mockResolvedValue(new AIMessage("mocked response"));

    process.env.GOOGLE_API_KEY = "test-api-key";

    vi.mocked(validateGoogleToken).mockResolvedValue({ email: TEST_EMAIL });
    vi.mocked(verifyThreadAuthorization).mockImplementation(() => {});

    vi.spyOn(Date, "now").mockReturnValue(FIXED_TIMESTAMP);
  });

  afterEach(() => {
    modelInvokeSpy.mockReset();
    vi.restoreAllMocks();
    delete process.env.GOOGLE_API_KEY;
  });

  describe("auth gating", () => {
    it("calls validateGoogleToken with the run config", async () => {
      await graph.invoke(
        { messages: [new HumanMessage("Hello")] },
        buildConfig(),
      );

      expect(validateGoogleToken).toHaveBeenCalledWith(
        expect.objectContaining({
          configurable: expect.objectContaining({
            access_token: "test-access-token",
          }),
        }),
      );
    });

    it("calls verifyThreadAuthorization with the validated email", async () => {
      await graph.invoke(
        { messages: [new HumanMessage("Hello")] },
        buildConfig(),
      );

      expect(verifyThreadAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          configurable: expect.objectContaining({
            thread_id: TEST_THREAD_ID,
          }),
        }),
        TEST_EMAIL,
      );
    });

    it("rejects when token validation fails", async () => {
      vi.mocked(validateGoogleToken).mockRejectedValue(
        new TroliAuthError("AUTH_INVALID_TOKEN", "bad token", {
          retryable: false,
          status: 401,
        }),
      );

      await expect(
        graph.invoke(
          { messages: [new HumanMessage("Hello")] },
          buildConfig(),
        ),
      ).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    });

    it("rejects when thread authorization fails", async () => {
      vi.mocked(verifyThreadAuthorization).mockImplementation(() => {
        throw new TroliAuthError("AUTH_THREAD_MISMATCH", "wrong thread", {
          retryable: false,
          status: 403,
        });
      });

      await expect(
        graph.invoke(
          { messages: [new HumanMessage("Hello")] },
          buildConfig(),
        ),
      ).rejects.toMatchObject({ code: "AUTH_THREAD_MISMATCH" });
    });
  });

  describe("preprocessing", () => {
    it("stamps the latest human message with the current timestamp", async () => {
      const result = await graph.invoke(
        { messages: [new HumanMessage("Hello")] },
        buildConfig(),
      );

      const humanMessage = result.messages.find(
        (m: { _getType: () => string }) => m._getType() === "human",
      );

      expect(getMessageTimestamp(humanMessage!)).toBe(FIXED_TIMESTAMP);
    });

    it("windows the persisted messages before invoking the model", async () => {
      const staleTimestamp = FIXED_TIMESTAMP - 8 * 24 * 60 * 60 * 1000;

      const result = await graph.invoke(
        {
          messages: [
            stampMessage(new HumanMessage("stale"), staleTimestamp),
            new HumanMessage("recent"),
          ],
        },
        buildConfig(),
      );

      const invokeArgs = modelInvokeSpy.mock.calls[0]![0];
      const humanInputs = invokeArgs.filter(
        (m: { _getType: () => string }) => m._getType() === "human",
      );

      expect(humanInputs).toHaveLength(1);
      expect(humanInputs[0].content).toBe("recent");
      expect(
        result.messages.some(
          (message: { content: unknown }) => message.content === "stale",
        ),
      ).toBe(false);
    });
  });

  describe("agent node", () => {
    it("invokes the model with a SystemMessage and the windowed messages", async () => {
      await graph.invoke(
        { messages: [new HumanMessage("Hello")] },
        buildConfig(),
      );

      const invokeArgs = modelInvokeSpy.mock.calls[0]![0];

      expect(invokeArgs[0]._getType()).toBe("system");
      expect(invokeArgs[1]._getType()).toBe("human");
      expect(invokeArgs[1].content).toBe("Hello");
    });

    it("includes the configured timezone in the system prompt", async () => {
      await graph.invoke(
        { messages: [new HumanMessage("Hello")] },
        buildConfig({ timezone: "America/New_York" }),
      );

      const systemMessage = modelInvokeSpy.mock.calls[0]![0][0];

      expect(systemMessage.content).toContain("America/New_York");
    });

    it("falls back to UTC when timezone is missing", async () => {
      await graph.invoke(
        { messages: [new HumanMessage("Hello")] },
        {
          configurable: {
            access_token: "test-access-token",
            thread_id: TEST_THREAD_ID,
          },
        },
      );

      const systemMessage = modelInvokeSpy.mock.calls[0]![0][0];

      expect(systemMessage.content).toContain("User's timezone: UTC");
    });

    it("stamps the model response with a timestamp", async () => {
      const result = await graph.invoke(
        { messages: [new HumanMessage("Hello")] },
        buildConfig(),
      );

      const aiMessage = result.messages.find(
        (m: { _getType: () => string }) => m._getType() === "ai",
      );

      expect(getMessageTimestamp(aiMessage!)).toBe(FIXED_TIMESTAMP);
    });

    it("returns the model response in the messages array", async () => {
      const result = await graph.invoke(
        { messages: [new HumanMessage("Hello")] },
        buildConfig(),
      );

      const aiMessage = result.messages.find(
        (m: { _getType: () => string }) => m._getType() === "ai",
      );

      expect(aiMessage!.content).toBe("mocked response");
    });
  });

  describe("end-to-end", () => {
    it("returns the stamped input and model response", async () => {
      const result = await graph.invoke(
        { messages: [new HumanMessage("Hello")] },
        buildConfig(),
      );

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]._getType()).toBe("human");
      expect(result.messages[1]._getType()).toBe("ai");
    });

    it("preserves timestamps on earlier messages", async () => {
      const earlierTimestamp = FIXED_TIMESTAMP - 1000;
      const result = await graph.invoke(
        {
          messages: [
            stampMessage(new HumanMessage("first"), earlierTimestamp),
            stampMessage(new AIMessage("reply"), earlierTimestamp + 500),
            new HumanMessage("second"),
          ],
        },
        buildConfig(),
      );

      expect(result.messages).toHaveLength(4);
      expect(getMessageTimestamp(result.messages[0]!)).toBe(earlierTimestamp);
      expect(getMessageTimestamp(result.messages[2]!)).toBe(FIXED_TIMESTAMP);
    });
  });
});
