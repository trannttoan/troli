declare module 'expo' {
  import type { ComponentType } from 'react';

  export function registerRootComponent(
    component: ComponentType<unknown>,
  ): void;
}

declare module 'expo-status-bar' {
  import type { ReactElement } from 'react';

  export type StatusBarStyle = 'auto' | 'dark' | 'inverted' | 'light';

  export function StatusBar(props: {
    style?: StatusBarStyle;
  }): ReactElement | null;
}

declare module 'expo-auth-session' {
  export type AuthSessionResult =
    | {
        type: 'cancel' | 'dismiss' | 'locked' | 'opened';
      }
    | {
        type: 'error';
        error?: {
          description?: string;
        };
        params: {
          error?: string;
          error_description?: string;
        };
      }
    | {
        type: 'success';
        authentication?: {
          accessToken?: string;
          expiresIn?: number;
          issuedAt?: number;
          refreshToken?: string;
          scope?: string;
        };
        params: Record<string, string | undefined>;
      };
}

declare module 'expo-auth-session/providers/google' {
  import type { AuthSessionResult } from 'expo-auth-session';

  export type GoogleAuthRequestConfig = {
    extraParams?: Record<string, string>;
    iosClientId?: string;
    scopes?: string[];
  };

  export function useAuthRequest(
    config: GoogleAuthRequestConfig,
  ): [
    request: object | null,
    response: AuthSessionResult | null,
    promptAsync: () => Promise<AuthSessionResult>,
  ];
}
