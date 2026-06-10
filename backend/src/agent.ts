import {
  Annotation,
  LangGraphRunnableConfig,
  StateGraph,
  messagesStateReducer,
} from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  BaseMessage,
  RemoveMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";

import { buildSystemPrompt, normalizeTimezone } from "./prompt.js";
import {
  validateGoogleToken,
  verifyThreadAuthorization,
} from "./utils/auth.js";
import { stampLatestHumanMessage, stampMessage } from "./utils/timestamp.js";
import { windowMessages } from "./utils/window-messages.js";

const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  llmInputMessages: Annotation<BaseMessage[]>({
    reducer: (_left, update) => messagesStateReducer([], update),
    default: () => [],
  }),
});

function getModel(): ChatGoogleGenerativeAI {
  const apiKey = process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY is required");
  }

  return new ChatGoogleGenerativeAI({
    apiKey,
    model: "gemini-2.5-flash-lite",
    temperature: 0,
  });
}

function getTimezoneFromConfig(config: LangGraphRunnableConfig): string {
  const configurable = config.configurable as Record<string, unknown> | undefined;
  const timezone =
    typeof configurable?.timezone === "string" ? configurable.timezone : undefined;

  return normalizeTimezone(timezone);
}

function preprocessMessages(messages: BaseMessage[]): {
  messages: BaseMessage[];
  llmInputMessages: BaseMessage[];
} {
  const now = Date.now();
  const stampedMessages = stampLatestHumanMessage(messages, now);

  return {
    messages: [
      new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
      ...stampedMessages,
    ],
    llmInputMessages: windowMessages(stampedMessages, { now }),
  };
}

async function preprocessNode(
  state: typeof AgentState.State,
  config: LangGraphRunnableConfig,
) {
  const { email } = await validateGoogleToken(config);
  verifyThreadAuthorization(config, email);

  return preprocessMessages(state.messages);
}

const workflow = new StateGraph(AgentState)
  .addNode("preprocess", preprocessNode)
  .addNode("agent", async (state, config) => {
    const response = await getModel().invoke([
      new SystemMessage(buildSystemPrompt({ timezone: getTimezoneFromConfig(config) })),
      ...state.llmInputMessages,
    ]);

    return { messages: [stampMessage(response)] };
  })
  .addEdge("__start__", "preprocess")
  .addEdge("preprocess", "agent");

export const graph = workflow.compile();
