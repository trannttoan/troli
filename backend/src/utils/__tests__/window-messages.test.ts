import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { stampMessage } from "../timestamp.js";
import { windowMessages } from "../window-messages.js";

const DAY_IN_MS = 24 * 60 * 60 * 1000;

describe("windowMessages", () => {
  it("keeps only messages within the seven-day window", () => {
    const now = Date.UTC(2026, 5, 11, 16, 0, 0);
    const messages = [
      stampMessage(new HumanMessage("recent"), now - DAY_IN_MS),
      stampMessage(new AIMessage("at-cutoff"), now - 7 * DAY_IN_MS),
      stampMessage(new HumanMessage("stale"), now - 8 * DAY_IN_MS),
    ];

    const result = windowMessages(messages, { now });

    expect(result.map((message) => message.content)).toEqual([
      "recent",
      "at-cutoff",
    ]);
  });

  it("caps the window to the most recent 200 timestamped messages", () => {
    const now = Date.UTC(2026, 5, 11, 16, 0, 0);
    const messages = Array.from({ length: 205 }, (_, index) =>
      stampMessage(
        new HumanMessage(`message-${index}`),
        now - (205 - index) * 1000,
      ),
    );

    const result = windowMessages(messages, {
      maxMessages: 200,
      now,
      windowDays: 30,
    });

    expect(result).toHaveLength(200);
    expect(result[0]?.content).toBe("message-5");
    expect(result.at(-1)?.content).toBe("message-204");
  });

  it("drops messages that do not carry a timestamp", () => {
    const now = Date.UTC(2026, 5, 11, 16, 0, 0);
    const messages = [
      stampMessage(new HumanMessage("timestamped"), now - 1_000),
      new AIMessage("missing-timestamp"),
    ];

    const result = windowMessages(messages, { now, windowDays: 30 });

    expect(result.map((message) => message.content)).toEqual(["timestamped"]);
  });
});
