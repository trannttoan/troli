import { create } from 'zustand';

import {
  bootstrapThread as bootstrapRemoteThread,
  type HydratedChatMessage,
  streamRun,
} from '../services/langgraph';
import { generateThreadId } from '../utils/thread';
import { useAuthStore } from './auth';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  status?: 'streaming';
  text: string;
  timestamp?: number | null;
};

type ChatState = {
  bootstrapThread: () => Promise<void>;
  clearError: () => void;
  errorMessage: string | null;
  hydrateMessages: (messages: HydratedChatMessage[]) => void;
  isBootstrapping: boolean;
  isSending: boolean;
  messages: ChatMessage[];
  threadId: string | null;
  reset: () => void;
  sendMessage: (text: string) => Promise<void>;
};

const initialChatState = {
  errorMessage: null as string | null,
  isBootstrapping: false,
  isSending: false,
  messages: [] as ChatMessage[],
  threadId: null as string | null,
};

export const useChatStore = create<ChatState>((set) => ({
  ...initialChatState,
  bootstrapThread: async () => {
    const email = useAuthStore.getState().email;

    if (!email) {
      throw new Error('User email is unavailable.');
    }

    const threadId = generateThreadId(email);

    set({
      errorMessage: null,
      isBootstrapping: true,
      threadId,
    });

    try {
      const result = await bootstrapRemoteThread(threadId);

      set({
        errorMessage:
          result.status === 'error'
            ? 'The previous run did not settle cleanly. Conversation history was reloaded and you can send another message.'
            : null,
        isBootstrapping: false,
        messages: normalizeMessages(result.messages),
        threadId,
      });
    } catch (error) {
      set({
        errorMessage:
          error instanceof Error
            ? error.message
            : 'Unable to bootstrap the Troli thread.',
        isBootstrapping: false,
        threadId,
      });
      throw error;
    }
  },
  clearError: () => {
    set({ errorMessage: null });
  },
  errorMessage: null,
  hydrateMessages: (messages) => {
    set({
      errorMessage: null,
      messages: normalizeMessages(messages),
    });
  },
  isBootstrapping: false,
  isSending: false,
  reset: () => {
    set(initialChatState);
  },
  sendMessage: async (text) => {
    const trimmedText = text.trim();

    if (!trimmedText) {
      return;
    }

    const state = useChatStore.getState();

    if (state.isSending) {
      return;
    }

    let threadId = state.threadId;

    if (!threadId) {
      await state.bootstrapThread();
      threadId = useChatStore.getState().threadId;
    }

    if (!threadId) {
      throw new Error('Thread bootstrap did not produce a thread ID.');
    }

    const authState = useAuthStore.getState();

    if (!authState.email) {
      throw new Error('User email is unavailable.');
    }

    const accessToken = await authState.getValidToken();
    const userMessage: ChatMessage = {
      id: createLocalMessageId('user'),
      role: 'user',
      text: trimmedText,
      timestamp: Date.now(),
    };
    const streamingAssistantId = createLocalMessageId('assistant');

    set((currentState) => ({
      errorMessage: null,
      isSending: true,
      messages: [...currentState.messages, userMessage],
    }));

    try {
      await streamRun({
        accessToken,
        message: trimmedText,
        onAssistantTextSnapshot: (text) => {
          set((currentState) => ({
            messages: upsertStreamingAssistantSnapshot(
              currentState.messages,
              streamingAssistantId,
              text,
            ),
          }));
        },
        threadId,
        timezone: getDeviceTimezone(),
      });

      const hydratedMessages = await bootstrapRemoteThread(threadId);

      set({
        errorMessage:
          hydratedMessages.status === 'error'
            ? 'The thread reported an error after streaming. Conversation history was reloaded and you can send another message.'
            : null,
        isSending: false,
        messages: normalizeMessages(hydratedMessages.messages),
        threadId,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Unable to send your message to Troli.';

      set({
        errorMessage,
        isSending: false,
      });

      try {
        const hydratedMessages = await bootstrapRemoteThread(threadId);

        set({
          errorMessage:
            hydratedMessages.status === 'error'
              ? 'The thread reported an error after streaming. Conversation history was reloaded and you can send another message.'
              : null,
          messages: normalizeMessages(hydratedMessages.messages),
          threadId,
        });
        return;
      } catch {
        set((currentState) => ({
          messages: removeStreamingAssistantMessage(
            currentState.messages,
            streamingAssistantId,
          ),
        }));
      }

      throw error;
    }
  },
  threadId: null,
}));

export function resetChatState() {
  useChatStore.getState().reset();
}

function normalizeMessages(messages: HydratedChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
  }));
}

function upsertStreamingAssistantSnapshot(
  messages: ChatMessage[],
  messageId: string,
  text: string,
): ChatMessage[] {
  const existingMessage = messages.find((message) => message.id === messageId);

  if (!existingMessage) {
    return [
      ...messages,
      {
        id: messageId,
        role: 'assistant',
        status: 'streaming',
        text,
        timestamp: Date.now(),
      },
    ];
  }

  return messages.map((message) =>
    message.id === messageId
      ? {
          ...message,
          status: 'streaming',
          text,
        }
      : message,
  );
}

function removeStreamingAssistantMessage(
  messages: ChatMessage[],
  messageId: string,
): ChatMessage[] {
  return messages.filter((message) => message.id !== messageId);
}

function createLocalMessageId(role: ChatMessage['role']): string {
  return `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getDeviceTimezone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone || 'UTC';
}
