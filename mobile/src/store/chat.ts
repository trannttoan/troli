import { create } from 'zustand';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

type ChatState = {
  messages: ChatMessage[];
  threadId: string | null;
  reset: () => void;
  setMessages: (messages: ChatMessage[]) => void;
  setThreadId: (threadId: string | null) => void;
};

const initialChatState = {
  messages: [] as ChatMessage[],
  threadId: null as string | null,
};

export const useChatStore = create<ChatState>((set) => ({
  ...initialChatState,
  reset: () => {
    set(initialChatState);
  },
  setMessages: (messages) => {
    set({ messages });
  },
  setThreadId: (threadId) => {
    set({ threadId });
  },
}));

export function resetChatState() {
  useChatStore.getState().reset();
}
