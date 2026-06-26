import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

jest.mock('../../services/langgraph', () => ({
  bootstrapThread: jest.fn(),
  streamRun: jest.fn(),
}));

jest.mock('../../utils/thread', () => ({
  generateThreadId: jest.fn(() => 'deterministic-thread-id'),
}));

jest.mock('../auth', () => ({
  useAuthStore: {
    getState: jest.fn(() => ({
      email: 'test@example.com',
      getValidToken: jest.fn(() => Promise.resolve('access-token')),
    })),
  },
}));

type LoadedChatModule = {
  chatStore: typeof import('../chat');
  langgraph: typeof import('../../services/langgraph');
};

function loadChatModule(): LoadedChatModule {
  jest.resetModules();

  return {
    chatStore: require('../chat') as typeof import('../chat'),
    langgraph:
      require('../../services/langgraph') as typeof import('../../services/langgraph'),
  };
}

describe('useChatStore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-15T10:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('bootstrapThread', () => {
    it('sets threadId and messages on success', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const bootstrapThread = jest.mocked(langgraph.bootstrapThread);

      bootstrapThread.mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
        ],
        status: 'idle',
      });

      await chatStore.useChatStore.getState().bootstrapThread();

      const state = chatStore.useChatStore.getState();

      expect(state.threadId).toBe('deterministic-thread-id');
      expect(state.messages).toEqual([
        { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
      ]);
      expect(state.isBootstrapping).toBe(false);
      expect(state.errorMessage).toBeNull();
    });

    it('sets isBootstrapping to true during the call', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const bootstrapThread = jest.mocked(langgraph.bootstrapThread);
      let capturedIsBootstrapping = false;

      bootstrapThread.mockImplementation(async () => {
        capturedIsBootstrapping =
          chatStore.useChatStore.getState().isBootstrapping;
        return { messages: [], status: 'idle' };
      });

      await chatStore.useChatStore.getState().bootstrapThread();

      expect(capturedIsBootstrapping).toBe(true);
      expect(chatStore.useChatStore.getState().isBootstrapping).toBe(false);
    });

    it('sets errorMessage on failure and rethrows', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest
        .mocked(langgraph.bootstrapThread)
        .mockRejectedValue(new Error('Network error'));

      await expect(
        chatStore.useChatStore.getState().bootstrapThread(),
      ).rejects.toThrow('Network error');

      const state = chatStore.useChatStore.getState();

      expect(state.errorMessage).toBe('Network error');
      expect(state.isBootstrapping).toBe(false);
    });

    it('throws when email is unavailable', async () => {
      const { chatStore } = loadChatModule();
      const authModule = require('../auth') as typeof import('../auth');

      jest.mocked(authModule.useAuthStore.getState).mockReturnValue({
        email: null,
      } as ReturnType<typeof authModule.useAuthStore.getState>);

      await expect(
        chatStore.useChatStore.getState().bootstrapThread(),
      ).rejects.toThrow('User email is unavailable.');
    });

    it('sets errorMessage when bootstrap returns error status', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [],
        status: 'error',
      });

      await chatStore.useChatStore.getState().bootstrapThread();

      expect(chatStore.useChatStore.getState().errorMessage).toMatch(
        /did not settle cleanly/,
      );
    });
  });

  describe('sendMessage', () => {
    it('appends the user message and calls streamRun with correct params', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const streamRun = jest.mocked(langgraph.streamRun);
      const bootstrapThread = jest.mocked(langgraph.bootstrapThread);

      streamRun.mockResolvedValue(undefined);
      bootstrapThread.mockResolvedValue({ messages: [], status: 'idle' });
      chatStore.useChatStore.setState({ threadId: 'thread-1' });

      await chatStore.useChatStore.getState().sendMessage('Hello agent');

      expect(streamRun).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'access-token',
          message: 'Hello agent',
          threadId: 'thread-1',
        }),
      );
    });

    it('upserts streaming snapshots via onAssistantTextSnapshot callback', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const streamRun = jest.mocked(langgraph.streamRun);
      const bootstrapThread = jest.mocked(langgraph.bootstrapThread);
      let capturedMessages: Array<{
        role: string;
        text: string;
        status?: string;
      }> = [];

      streamRun.mockImplementation(async (input) => {
        await input.onAssistantTextSnapshot?.('partial text');
        capturedMessages = chatStore.useChatStore
          .getState()
          .messages.map((m) => ({
            role: m.role,
            text: m.text,
            status: m.status,
          }));
      });
      bootstrapThread.mockResolvedValue({ messages: [], status: 'idle' });
      chatStore.useChatStore.setState({ threadId: 'thread-1' });

      await chatStore.useChatStore.getState().sendMessage('Hello');

      const streamingMsg = capturedMessages.find((m) => m.role === 'assistant');

      expect(streamingMsg).toBeDefined();
      expect(streamingMsg?.text).toBe('partial text');
      expect(streamingMsg?.status).toBe('streaming');
    });

    it('hydrates messages from remote after streaming completes', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest.mocked(langgraph.streamRun).mockResolvedValue(undefined);
      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
          { id: 'msg-2', role: 'assistant', text: 'Hi there', timestamp: 1001 },
        ],
        status: 'idle',
      });
      chatStore.useChatStore.setState({ threadId: 'thread-1' });

      await chatStore.useChatStore.getState().sendMessage('Hello');

      const state = chatStore.useChatStore.getState();

      expect(state.messages).toHaveLength(2);
      expect(state.messages[1]?.text).toBe('Hi there');
      expect(state.isSending).toBe(false);
    });

    it('sets errorMessage and attempts re-hydrate on streamRun failure', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest
        .mocked(langgraph.streamRun)
        .mockRejectedValue(new Error('Stream failed'));
      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
        ],
        status: 'idle',
      });
      chatStore.useChatStore.setState({ threadId: 'thread-1' });

      await expect(
        chatStore.useChatStore.getState().sendMessage('Hello'),
      ).rejects.toThrow('Stream failed');

      const state = chatStore.useChatStore.getState();

      expect(state.errorMessage).toBe('Stream failed');
      expect(state.isSending).toBe(false);
      expect(state.messages).toHaveLength(1);
    });

    it('removes streaming message when re-hydrate also fails', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest.mocked(langgraph.streamRun).mockImplementation(async (input) => {
        await input.onAssistantTextSnapshot?.('partial');
        throw new Error('Stream failed');
      });
      jest
        .mocked(langgraph.bootstrapThread)
        .mockRejectedValue(new Error('Hydrate failed'));
      chatStore.useChatStore.setState({ threadId: 'thread-1' });

      await expect(
        chatStore.useChatStore.getState().sendMessage('Hello'),
      ).rejects.toThrow('Stream failed');

      const assistantMessages = chatStore.useChatStore
        .getState()
        .messages.filter((m) => m.role === 'assistant');

      expect(assistantMessages).toHaveLength(0);
    });

    it('no-ops on empty text', async () => {
      const { chatStore, langgraph } = loadChatModule();

      await chatStore.useChatStore.getState().sendMessage('');

      expect(langgraph.streamRun).not.toHaveBeenCalled();
    });

    it('no-ops on whitespace-only text', async () => {
      const { chatStore, langgraph } = loadChatModule();

      await chatStore.useChatStore.getState().sendMessage('   ');

      expect(langgraph.streamRun).not.toHaveBeenCalled();
    });

    it('no-ops when isSending is already true', async () => {
      const { chatStore, langgraph } = loadChatModule();

      chatStore.useChatStore.setState({
        threadId: 'thread-1',
        isSending: true,
      });

      await chatStore.useChatStore.getState().sendMessage('Hello');

      expect(langgraph.streamRun).not.toHaveBeenCalled();
    });

    it('bootstraps the thread if threadId is null before sending', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const bootstrapThread = jest.mocked(langgraph.bootstrapThread);

      bootstrapThread.mockResolvedValue({ messages: [], status: 'idle' });
      jest.mocked(langgraph.streamRun).mockResolvedValue(undefined);

      await chatStore.useChatStore.getState().sendMessage('Hello');

      expect(bootstrapThread).toHaveBeenCalledTimes(2);
    });
  });

  describe('hydrateMessages', () => {
    it('normalizes and replaces the message list', () => {
      const { chatStore } = loadChatModule();

      chatStore.useChatStore.getState().hydrateMessages([
        { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
        { id: 'msg-2', role: 'assistant', text: 'Hi', timestamp: 1001 },
      ]);

      expect(chatStore.useChatStore.getState().messages).toEqual([
        { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
        { id: 'msg-2', role: 'assistant', text: 'Hi', timestamp: 1001 },
      ]);
    });

    it('clears errorMessage', () => {
      const { chatStore } = loadChatModule();

      chatStore.useChatStore.setState({ errorMessage: 'stale error' });
      chatStore.useChatStore.getState().hydrateMessages([]);

      expect(chatStore.useChatStore.getState().errorMessage).toBeNull();
    });
  });

  describe('reset / resetChatState', () => {
    it('restores initial state', () => {
      const { chatStore } = loadChatModule();

      chatStore.useChatStore.setState({
        errorMessage: 'some error',
        messages: [{ id: 'msg-1', role: 'user', text: 'Hello' }],
        threadId: 'thread-1',
      });

      chatStore.useChatStore.getState().reset();

      const state = chatStore.useChatStore.getState();

      expect(state.errorMessage).toBeNull();
      expect(state.isBootstrapping).toBe(false);
      expect(state.isSending).toBe(false);
      expect(state.messages).toEqual([]);
      expect(state.threadId).toBeNull();
    });

    it('resets state via the exported resetChatState function', () => {
      const { chatStore } = loadChatModule();

      chatStore.useChatStore.setState({
        errorMessage: 'some error',
        threadId: 'thread-1',
      });

      chatStore.resetChatState();

      expect(chatStore.useChatStore.getState().threadId).toBeNull();
      expect(chatStore.useChatStore.getState().errorMessage).toBeNull();
    });
  });
});
