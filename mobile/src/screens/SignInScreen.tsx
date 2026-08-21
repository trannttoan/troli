import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Google from 'expo-auth-session/providers/google';

import { useAuthStore } from '../store/auth';
import {
  buildSessionFromAuthResponse,
  getGoogleAuthRequestConfig,
} from '../utils/auth';

export function SignInScreen() {
  const authConfig = getGoogleAuthRequestConfig();

  if (!authConfig) {
    return (
      <View style={styles.screen}>
        <View style={styles.card}>
          <Text style={styles.title}>Aisist</Text>
          <Text style={styles.subtitle}>
            Add `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` to `mobile/.env` before
            testing sign-in.
          </Text>
        </View>
      </View>
    );
  }

  return <ConfiguredSignInScreen />;
}

function ConfiguredSignInScreen() {
  const signIn = useAuthStore((state) => state.signIn);
  const clearError = useAuthStore((state) => state.clearError);
  const errorMessage = useAuthStore((state) => state.errorMessage);
  const [isPrompting, setIsPrompting] = useState(false);
  const [isProcessingResponse, setIsProcessingResponse] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const authConfig = getGoogleAuthRequestConfig();

  if (!authConfig) {
    throw new Error('Missing EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID.');
  }

  const [request, response, promptAsync] = Google.useAuthRequest(authConfig);

  useEffect(() => {
    if (!response || response.type === 'opened' || response.type === 'locked') {
      return;
    }

    let cancelled = false;

    void (async () => {
      setIsPrompting(false);
      setIsProcessingResponse(true);

      try {
        const session = await buildSessionFromAuthResponse(response);

        if (cancelled) {
          return;
        }

        await signIn(session);
        setLocalError(null);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setLocalError(
          error instanceof Error
            ? error.message
            : 'Unable to sign in with Google.',
        );
      } finally {
        if (!cancelled) {
          setIsProcessingResponse(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [response, signIn]);

  const isBusy = isPrompting || isProcessingResponse;
  const visibleError = localError ?? errorMessage;

  async function handleSignIn() {
    clearError();
    setLocalError(null);
    setIsPrompting(true);

    try {
      const result = await promptAsync();

      if (result.type !== 'opened') {
        setIsPrompting(false);
      }
    } catch (error) {
      setIsPrompting(false);
      setLocalError(
        error instanceof Error
          ? error.message
          : 'Unable to open Google sign-in.',
      );
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>Phase 1</Text>
        <Text style={styles.title}>Aisist</Text>
        <Text style={styles.subtitle}>
          Sign in with Google to unlock your single persistent chat thread.
        </Text>
        {visibleError ? (
          <Text style={styles.errorText}>{visibleError}</Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={!request || isBusy}
          onPress={() => {
            void handleSignIn();
          }}
          style={({ pressed }) => [
            styles.button,
            (!request || isBusy) && styles.buttonDisabled,
            pressed && !isBusy ? styles.buttonPressed : null,
          ]}
        >
          <Text style={styles.buttonText}>
            {isBusy ? 'Signing in…' : 'Sign in with Google'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: '#1f5c4a',
    borderRadius: 18,
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  buttonDisabled: {
    backgroundColor: '#7ea292',
  },
  buttonPressed: {
    opacity: 0.9,
  },
  buttonText: {
    color: '#f7f4ee',
    fontSize: 16,
    fontWeight: '700',
  },
  card: {
    backgroundColor: '#fffdf8',
    borderColor: '#d8cec0',
    borderRadius: 28,
    borderWidth: 1,
    gap: 16,
    maxWidth: 420,
    padding: 28,
    width: '100%',
  },
  eyebrow: {
    color: '#7a6f63',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  errorText: {
    color: '#8a2d2d',
    fontSize: 14,
    lineHeight: 20,
  },
  screen: {
    alignItems: 'center',
    backgroundColor: '#f4f1ea',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  subtitle: {
    color: '#51483f',
    fontSize: 16,
    lineHeight: 23,
  },
  title: {
    color: '#1f2a24',
    fontSize: 32,
    fontWeight: '800',
  },
});
