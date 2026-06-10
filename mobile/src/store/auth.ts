import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import {
  getGoogleIosClientId,
  isForceReauthError,
  isRefreshTimeoutError,
  refreshGoogleAccessToken,
  type AuthSessionData,
} from '../utils/auth';
import { resetChatState } from './chat';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const STORAGE_KEYS = {
  accessToken: 'auth_access_token',
  email: 'auth_user_email',
  expiryAt: 'auth_token_expiry',
  refreshToken: 'auth_refresh_token',
} as const;

const STORAGE_OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
} as const;

type AuthStatus = 'loading' | 'signed_in' | 'signed_out';

type AuthState = {
  accessToken: string | null;
  clearError: () => void;
  email: string | null;
  errorMessage: string | null;
  expiryAt: string | null;
  getValidToken: () => Promise<string>;
  initialize: () => Promise<void>;
  refreshToken: string | null;
  signIn: (session: AuthSessionData) => Promise<void>;
  signOut: (reason?: string | null) => Promise<void>;
  status: AuthStatus;
};

const signedOutState = {
  accessToken: null,
  email: null,
  errorMessage: null,
  expiryAt: null,
  refreshToken: null,
  status: 'signed_out' as const,
};

let refreshPromise: Promise<string> | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  ...signedOutState,
  status: 'loading',
  clearError: () => {
    set({ errorMessage: null });
  },
  getValidToken: async () => {
    const currentState = get();

    if (
      currentState.status !== 'signed_in' ||
      !currentState.accessToken ||
      !currentState.refreshToken ||
      !currentState.expiryAt
    ) {
      throw new Error('User is not authenticated.');
    }

    if (!shouldRefresh(currentState.expiryAt)) {
      return currentState.accessToken;
    }

    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = (async () => {
      const latestState = get();

      if (
        latestState.status !== 'signed_in' ||
        !latestState.accessToken ||
        !latestState.refreshToken ||
        !latestState.expiryAt ||
        !latestState.email
      ) {
        throw new Error('User is not authenticated.');
      }

      if (!shouldRefresh(latestState.expiryAt)) {
        return latestState.accessToken;
      }

      const clientId = getGoogleIosClientId();

      if (!clientId) {
        throw new Error('Missing EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID.');
      }

      try {
        const refreshedTokens = await refreshWithRetry({
          clientId,
          refreshToken: latestState.refreshToken,
        });

        const nextSession: AuthSessionData = {
          accessToken: refreshedTokens.accessToken,
          email: latestState.email,
          expiryAt: refreshedTokens.expiryAt,
          refreshToken: refreshedTokens.refreshToken,
        };

        await persistSession(nextSession);

        set({
          accessToken: nextSession.accessToken,
          email: nextSession.email,
          errorMessage: null,
          expiryAt: nextSession.expiryAt,
          refreshToken: nextSession.refreshToken,
          status: 'signed_in',
        });

        return nextSession.accessToken;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Unable to refresh your Google session.';

        if (isForceReauthError(error) || isRefreshTimeoutError(error)) {
          await get().signOut(message);
        } else {
          set({ errorMessage: message });
        }

        throw error;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  },
  initialize: async () => {
    const storedSession = await loadStoredSession();

    if (!storedSession) {
      set({ ...signedOutState, status: 'signed_out' });
      return;
    }

    set({
      accessToken: storedSession.accessToken,
      email: storedSession.email,
      errorMessage: null,
      expiryAt: storedSession.expiryAt,
      refreshToken: storedSession.refreshToken,
      status: 'signed_in',
    });
  },
  refreshToken: null,
  signIn: async (session) => {
    refreshPromise = null;
    await persistSession(session);

    set({
      accessToken: session.accessToken,
      email: session.email,
      errorMessage: null,
      expiryAt: session.expiryAt,
      refreshToken: session.refreshToken,
      status: 'signed_in',
    });
  },
  signOut: async (reason = null) => {
    refreshPromise = null;
    await clearStoredSession();
    resetChatState();

    set({
      ...signedOutState,
      errorMessage: reason,
      status: 'signed_out',
    });
  },
}));

async function clearStoredSession() {
  await Promise.all([
    SecureStore.deleteItemAsync(STORAGE_KEYS.accessToken, STORAGE_OPTIONS),
    SecureStore.deleteItemAsync(STORAGE_KEYS.refreshToken, STORAGE_OPTIONS),
    SecureStore.deleteItemAsync(STORAGE_KEYS.expiryAt, STORAGE_OPTIONS),
    SecureStore.deleteItemAsync(STORAGE_KEYS.email, STORAGE_OPTIONS),
  ]);
}

async function loadStoredSession(): Promise<AuthSessionData | null> {
  const [accessToken, refreshToken, expiryAt, email] = await Promise.all([
    SecureStore.getItemAsync(STORAGE_KEYS.accessToken, STORAGE_OPTIONS),
    SecureStore.getItemAsync(STORAGE_KEYS.refreshToken, STORAGE_OPTIONS),
    SecureStore.getItemAsync(STORAGE_KEYS.expiryAt, STORAGE_OPTIONS),
    SecureStore.getItemAsync(STORAGE_KEYS.email, STORAGE_OPTIONS),
  ]);

  if (accessToken && refreshToken && expiryAt && email) {
    return {
      accessToken,
      email,
      expiryAt,
      refreshToken,
    };
  }

  if (accessToken || refreshToken || expiryAt || email) {
    await clearStoredSession();
  }

  return null;
}

async function persistSession(session: AuthSessionData) {
  await Promise.all([
    SecureStore.setItemAsync(
      STORAGE_KEYS.accessToken,
      session.accessToken,
      STORAGE_OPTIONS,
    ),
    SecureStore.setItemAsync(
      STORAGE_KEYS.refreshToken,
      session.refreshToken,
      STORAGE_OPTIONS,
    ),
    SecureStore.setItemAsync(STORAGE_KEYS.expiryAt, session.expiryAt, STORAGE_OPTIONS),
    SecureStore.setItemAsync(STORAGE_KEYS.email, session.email, STORAGE_OPTIONS),
  ]);
}

async function refreshWithRetry(input: {
  clientId: string;
  refreshToken: string;
}) {
  try {
    return await refreshGoogleAccessToken(input);
  } catch (error) {
    if (!isRefreshTimeoutError(error)) {
      throw error;
    }

    return refreshGoogleAccessToken(input);
  }
}

function shouldRefresh(expiryAt: string): boolean {
  return new Date(expiryAt).getTime() - Date.now() <= REFRESH_BUFFER_MS;
}
