import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MESSAGE_TIMESTAMP_KEY,
  getMessageTimestamp,
  stampLatestHumanMessage,
  stampMessage,
} from "../timestamp.js";

describe("getMessageTimestamp", () => {
  it("returns the timestamp from additional_kwargs", () => {
    const message = new HumanMessage({
      content: "hello",
      additional_kwargs: { [MESSAGE_TIMESTAMP_KEY]: 1000 },
    });

    expect(getMessageTimestamp(message)).toBe(1000);
  });

  it("returns null when additional_kwargs has no timestamp key", () => {
    expect(getMessageTimestamp(new HumanMessage("hello"))).toBeNull();
  });

  it("returns null for NaN", () => {
    const message = new HumanMessage({
      content: "hello",
      additional_kwargs: { [MESSAGE_TIMESTAMP_KEY]: NaN },
    });

    expect(getMessageTimestamp(message)).toBeNull();
  });

  it("returns null for Infinity", () => {
    const message = new HumanMessage({
      content: "hello",
      additional_kwargs: { [MESSAGE_TIMESTAMP_KEY]: Infinity },
    });

    expect(getMessageTimestamp(message)).toBeNull();
  });
});

describe("stampMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets the timestamp on the message", () => {
    const message = new HumanMessage("hello");
    const stamped = stampMessage(message, 42);

    expect(getMessageTimestamp(stamped)).toBe(42);
  });

  it("defaults to Date.now() when no timestamp is provided", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234567890);

    const stamped = stampMessage(new HumanMessage("hello"));

    expect(getMessageTimestamp(stamped)).toBe(1234567890);
  });

  it("preserves existing additional_kwargs", () => {
    const message = new HumanMessage({
      content: "hello",
      additional_kwargs: { custom: "value" },
    });

    const stamped = stampMessage(message, 42);

    expect(stamped.additional_kwargs).toMatchObject({
      custom: "value",
      [MESSAGE_TIMESTAMP_KEY]: 42,
    });
  });

  it("preserves the message content and type", () => {
    const stamped = stampMessage(new AIMessage("response"), 42);

    expect(stamped.content).toBe("response");
    expect(stamped._getType()).toBe("ai");
  });
});

describe("stampLatestHumanMessage", () => {
  it("stamps only the last unstamped HumanMessage", () => {
    const messages = [
      new HumanMessage("first"),
      new AIMessage("reply"),
      new HumanMessage("second"),
    ];

    const result = stampLatestHumanMessage(messages, 100);

    expect(getMessageTimestamp(result[0]!)).toBeNull();
    expect(getMessageTimestamp(result[2]!)).toBe(100);
  });

  it("skips HumanMessages that are already stamped", () => {
    const messages = [
      new HumanMessage("first"),
      stampMessage(new HumanMessage("already-stamped"), 50),
    ];

    const result = stampLatestHumanMessage(messages, 100);

    expect(getMessageTimestamp(result[0]!)).toBe(100);
    expect(getMessageTimestamp(result[1]!)).toBe(50);
  });

  it("returns the original array when no unstamped HumanMessage exists", () => {
    const messages = [
      stampMessage(new HumanMessage("stamped"), 50),
      new AIMessage("reply"),
    ];

    const result = stampLatestHumanMessage(messages, 100);

    expect(result).toBe(messages);
  });

  it("does not stamp AIMessages", () => {
    const messages = [new AIMessage("only ai here")];

    const result = stampLatestHumanMessage(messages, 100);

    expect(result).toBe(messages);
  });

  it("handles an empty array", () => {
    const result = stampLatestHumanMessage([], 100);

    expect(result).toEqual([]);
  });

  it("stamps the correct message when multiple unstamped HumanMessages exist", () => {
    const messages = [
      new HumanMessage("first"),
      new HumanMessage("second"),
      new HumanMessage("third"),
    ];

    const result = stampLatestHumanMessage(messages, 100);

    expect(getMessageTimestamp(result[0]!)).toBeNull();
    expect(getMessageTimestamp(result[1]!)).toBeNull();
    expect(getMessageTimestamp(result[2]!)).toBe(100);
  });
});
