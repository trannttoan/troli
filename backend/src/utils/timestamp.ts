import {
  BaseMessage,
  HumanMessage,
  mapStoredMessageToChatMessage,
} from "@langchain/core/messages";

export const MESSAGE_TIMESTAMP_KEY = "timestamp";

export function getMessageTimestamp(message: BaseMessage): number | null {
  const timestamp = message.additional_kwargs[MESSAGE_TIMESTAMP_KEY];

  return typeof timestamp === "number" && Number.isFinite(timestamp)
    ? timestamp
    : null;
}

export function stampMessage(
  message: BaseMessage,
  timestamp: number = Date.now(),
): BaseMessage {
  const stored = message.toDict();

  stored.data.additional_kwargs = {
    ...(stored.data.additional_kwargs ?? {}),
    [MESSAGE_TIMESTAMP_KEY]: timestamp,
  };

  return mapStoredMessageToChatMessage(stored);
}

export function stampLatestHumanMessage(
  messages: BaseMessage[],
  timestamp: number = Date.now(),
): BaseMessage[] {
  let messageIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (
      HumanMessage.isInstance(message) &&
      getMessageTimestamp(message) === null
    ) {
      messageIndex = index;
      break;
    }
  }

  if (messageIndex === -1) {
    return messages;
  }

  return messages.map((message, index) =>
    index === messageIndex ? stampMessage(message, timestamp) : message,
  );
}
