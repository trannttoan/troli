import {
  Annotation,
  LangGraphRunnableConfig,
  StateGraph,
  messagesStateReducer,
} from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import {
  BaseMessage,
  RemoveMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';

import { buildSystemPrompt, normalizeTimezone } from './prompt.js';
import {
  validateGoogleToken,
  verifyThreadAuthorization,
} from './utils/auth.js';
import { stampLatestHumanMessage, stampMessage } from './utils/timestamp.js';
import { windowMessages } from './utils/window-messages.js';
import { calendarTools } from './tools/calendar.js';

const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

function getModel(): ChatGoogleGenerativeAI {
  const apiKey = process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY is required');
  }

  return new ChatGoogleGenerativeAI({
    apiKey,
    model: 'gemini-3.1-flash-lite',
    temperature: 0,
  });
}

function getTimezoneFromConfig(config: LangGraphRunnableConfig): string {
  const configurable = config.configurable as
    | Record<string, unknown>
    | undefined;
  const timezone =
    typeof configurable?.timezone === 'string'
      ? configurable.timezone
      : undefined;

  return normalizeTimezone(timezone);
}

function preprocessMessages(messages: BaseMessage[]): {
  messages: BaseMessage[];
} {
  const now = Date.now();
  const stampedMessages = stampLatestHumanMessage(messages, now);
  const windowedMessages = windowMessages(stampedMessages, { now });

  return {
    messages: [
      new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
      ...windowedMessages,
    ],
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

const toolNode = new ToolNode(calendarTools);

async function toolsNode(
  state: typeof AgentState.State,
  config: LangGraphRunnableConfig,
) {
  const result = (await toolNode.invoke(
    state,
    config,
  )) as typeof AgentState.State;

  return {
    messages: result.messages.map((m) => stampMessage(m)),
  };
}

export const workflow = new StateGraph(AgentState)
  .addNode('preprocess', preprocessNode)
  .addNode('agent', async (state, config) => {
    const response = await getModel()
      .bindTools(calendarTools)
      .invoke([
        new SystemMessage(
          buildSystemPrompt({ timezone: getTimezoneFromConfig(config) }),
        ),
        ...state.messages,
      ]);

    return { messages: [stampMessage(response)] };
  })
  .addNode('tools', toolsNode)
  .addEdge('__start__', 'preprocess')
  .addEdge('preprocess', 'agent')
  .addConditionalEdges('agent', toolsCondition, ['tools', '__end__'])
  .addEdge('tools', 'agent');

export const graph = workflow.compile();
