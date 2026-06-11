import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  deleteItemAsync: jest.fn(() => Promise.resolve()),
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/auth', () => ({
  getGoogleIosClientId: jest.fn(() => 'ios-client-id'),
  isForceReauthError: jest.fn((error: unknown) => (error as { code?: string })?.code === 'force'),
  isRefreshTimeoutError: jest.fn(
    (error: unknown) => (error as { code?: string })?.code === 'refresh_timeout',
  ),
  refreshGoogleAccessToken: jest.fn(),
}));

type LoadedAuthModule = {
  authStore: typeof import('../auth');
  authUtils: typeof import('../../utils/auth');
  secureStore: typeof import('expo-secure-store');
};

const baseSession = {
  accessToken: 'initial-access-token',
  email: 'person@example.com',
  expiryAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  refreshToken: 'initial-refresh-token',
};

async function loadAuthModule(): Promise<LoadedAuthModule> {
  jest.resetModules();

  return {
    authStore: require('../auth') as typeof import('../auth'),
    authUtils: require('../../utils/auth') as typeof import('../../utils/auth'),
    secureStore: require('expo-secure-store') as typeof import('expo-secure-store'),
  };
}

describe('useAuthStore', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('refreshes the token when it expires within five minutes', async () => {
    const { authStore, authUtils } = await loadAuthModule();
    const refreshGoogleAccessToken = jest.mocked(authUtils.refreshGoogleAccessToken);

    refreshGoogleAccessToken.mockResolvedValue({
      accessToken: 'fresh-access-token',
      expiryAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      refreshToken: 'fresh-refresh-token',
    });

    await authStore.useAuthStore.getState().signIn({
      ...baseSession,
      expiryAt: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
    });

    await expect(authStore.useAuthStore.getState().getValidToken()).resolves.toBe(
      'fresh-access-token',
    );
    expect(refreshGoogleAccessToken).toHaveBeenCalledTimes(1);
    expect(refreshGoogleAccessToken).toHaveBeenCalledWith({
      clientId: 'ios-client-id',
      refreshToken: 'initial-refresh-token',
    });
    expect(authStore.useAuthStore.getState()).toMatchObject({
      accessToken: 'fresh-access-token',
      refreshToken: 'fresh-refresh-token',
      status: 'signed_in',
    });
  });

  it('deduplicates concurrent refreshes behind a shared mutex', async () => {
    const { authStore, authUtils } = await loadAuthModule();
    const refreshGoogleAccessToken = jest.mocked(authUtils.refreshGoogleAccessToken);
    let resolveRefresh:
      | ((value: {
          accessToken: string;
          expiryAt: string;
          refreshToken: string;
        }) => void)
      | null = null;

    refreshGoogleAccessToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    await authStore.useAuthStore.getState().signIn({
      ...baseSession,
      expiryAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const firstRefresh = authStore.useAuthStore.getState().getValidToken();
    const secondRefresh = authStore.useAuthStore.getState().getValidToken();

    expect(refreshGoogleAccessToken).toHaveBeenCalledTimes(1);

    resolveRefresh?.({
      accessToken: 'shared-access-token',
      expiryAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      refreshToken: 'shared-refresh-token',
    });

    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual([
      'shared-access-token',
      'shared-access-token',
    ]);
  });

  it('signs out by clearing secure storage and resetting chat state', async () => {
    const { authStore, secureStore } = await loadAuthModule();
    const resetChatState = jest.fn();

    authStore.__setLoadChatStoreModuleForTest(async () => ({ resetChatState }));

    await authStore.useAuthStore.getState().signIn(baseSession);
    await authStore.useAuthStore.getState().signOut('Session expired.');

    expect(jest.mocked(secureStore.deleteItemAsync)).toHaveBeenCalledTimes(4);
    expect(resetChatState).toHaveBeenCalledTimes(1);
    expect(authStore.useAuthStore.getState()).toMatchObject({
      accessToken: null,
      email: null,
      errorMessage: 'Session expired.',
      refreshToken: null,
      status: 'signed_out',
    });
    authStore.__setLoadChatStoreModuleForTest(null);
  });
});
