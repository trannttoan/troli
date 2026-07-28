import { create } from 'zustand';

import {
  bootstrapThread as bootstrapRemoteThread,
  extractInterruptPayload,
  type HydratedChatMessage,
  getThreadState,
  type InterruptPayload,
  resumeRun,
  type ResumeRunInput,
  streamRun,
} from '../services/langgraph';
import { generateThreadId } from '../utils/thread';
import { useAuthStore } from './auth';

export type ChatMessage = {
  id: string;
  interrupt?: InterruptPayload;
  role: 'user' | 'assistant';
  status?: 'approved' | 'pending_approval' | 'rejected' | 'streaming';
  text: string;
  timestamp?: number | null;
};

type ChatState = {
  bootstrapThread: () => Promise<void>;
  clearError: () => void;
  errorMessage: string | null;
  hasPendingApproval: () => boolean;
  hydrateMessages: (messages: HydratedChatMessage[]) => void;
  isBootstrapping: boolean;
  isSending: boolean;
  messages: ChatMessage[];
  resumeApproval: (
    messageId: string,
    decision: ResumeRunInput['decision'],
  ) => Promise<void>;
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

export const useChatStore = create<ChatState>((set, get) => ({
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
      let messages = normalizeMessages(result.messages);

      if (result.status === 'interrupted') {
        const interrupt = extractInterruptPayload(
          await getThreadState(threadId),
        );

        if (interrupt) {
          messages = upsertInterruptMessage(messages, interrupt);
        }
      }

      set({
        errorMessage:
          result.status === 'error'
            ? 'The previous run did not settle cleanly. Conversation history was reloaded and you can send another message.'
            : null,
        isBootstrapping: false,
        messages,
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
  hasPendingApproval: () =>
    get().messages.some((message) => message.status === 'pending_approval'),
  hydrateMessages: (messages) => {
    set({
      errorMessage: null,
      messages: normalizeMessages(messages),
    });
  },
  isBootstrapping: false,
  isSending: false,
  resumeApproval: async (messageId, decision) => {
    const state = useChatStore.getState();
    const approvalMessage = state.messages.find(
      (message) => message.id === messageId,
    );

    if (approvalMessage?.status !== 'pending_approval') {
      return;
    }

    const threadId = state.threadId;

    if (!threadId) {
      throw new Error('Thread is unavailable.');
    }

    const authState = useAuthStore.getState();
    const accessToken = await authState.getValidToken();
    const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
    const streamingAssistantId = createLocalMessageId('assistant');

    set((currentState) => ({
      errorMessage: null,
      isSending: true,
      messages: currentState.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              status: nextStatus,
            }
          : message,
      ),
    }));

    try {
      await resumeRun({
        accessToken,
        decision,
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

      const hydratedState = await hydrateMessagesForThread(threadId);

      set({
        ...hydratedState,
        isSending: false,
        threadId,
      });
    } catch (error) {
      try {
        const hydratedState = await hydrateMessagesForThread(threadId);

        set({
          ...hydratedState,
          isSending: false,
          threadId,
        });
        return;
      } catch {
        set((currentState) => ({
          errorMessage:
            'Your approval may have been received. Reopen the app once you are back online to reload the conversation.',
          isSending: false,
          messages: currentState.messages
            .filter((message) => message.id !== streamingAssistantId)
            .map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    status: 'pending_approval',
                  }
                : message,
            ),
        }));
      }

      throw error;
    }
  },
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

      set({
        isSending: false,
        ...(await hydrateMessagesForThread(threadId)),
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
        set({
          ...(await hydrateMessagesForThread(threadId)),
          threadId,
        });
        return;
      } catch {
        set((currentState) => ({
          errorMessage:
            'Your message may have been received. Reopen the app once you are back online to reload the conversation.',
          messages: currentState.messages.filter(
            (m) => m.id !== streamingAssistantId && m.id !== userMessage.id,
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

async function hydrateMessagesForThread(
  threadId: string,
): Promise<Pick<ChatState, 'errorMessage' | 'messages'>> {
  const hydratedMessages = await bootstrapRemoteThread(threadId);
  let messages = normalizeMessages(hydratedMessages.messages);

  if (hydratedMessages.status === 'interrupted') {
    const interrupt = extractInterruptPayload(await getThreadState(threadId));

    if (interrupt) {
      messages = upsertInterruptMessage(messages, interrupt);
    }
  }

  return {
    errorMessage:
      hydratedMessages.status === 'error'
        ? 'The thread reported an error after streaming. Conversation history was reloaded and you can send another message.'
        : null,
    messages,
  };
}

function normalizeMessages(messages: HydratedChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
  }));
}

function upsertInterruptMessage(
  messages: ChatMessage[],
  interrupt: InterruptPayload,
): ChatMessage[] {
  const interruptMessage: ChatMessage = {
    id: interrupt.id,
    interrupt,
    role: 'assistant',
    status: 'pending_approval',
    text: interrupt.description,
    timestamp: null,
  };

  if (!messages.some((message) => message.id === interrupt.id)) {
    return [...messages, interruptMessage];
  }

  return messages.map((message) =>
    message.id === interrupt.id ? interruptMessage : message,
  );
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

function createLocalMessageId(role: ChatMessage['role']): string {
  return `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getDeviceTimezone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone || 'UTC';
}
