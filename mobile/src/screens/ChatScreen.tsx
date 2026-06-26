import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { ChatInput } from '../components/ChatInput';
import { MessageBubble } from '../components/MessageBubble';
import { TypingIndicator } from '../components/TypingIndicator';
import {
  getMissingLangGraphConfig,
  isLangGraphConfigured,
} from '../services/langgraph';
import { useAuthStore } from '../store/auth';
import { useChatStore } from '../store/chat';

export function ChatScreen() {
  const bootstrapThread = useChatStore((state) => state.bootstrapThread);
  const clearError = useChatStore((state) => state.clearError);
  const errorMessage = useChatStore((state) => state.errorMessage);
  const isBootstrapping = useChatStore((state) => state.isBootstrapping);
  const isSending = useChatStore((state) => state.isSending);
  const messages = useChatStore((state) => state.messages);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const signOut = useAuthStore((state) => state.signOut);
  const hasBootstrappedRef = useRef(false);
  const insets = useSafeAreaInsets();
  const isConfigured = isLangGraphConfigured();
  const missingConfig = useMemo(() => getMissingLangGraphConfig(), []);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const keyboardVerticalOffset = Platform.OS === 'ios' ? insets.top + 56 : 0;

  useEffect(() => {
    const showEvent =
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent =
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSubscription = Keyboard.addListener(showEvent, () => {
      setIsKeyboardVisible(true);
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setIsKeyboardVisible(false);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!isConfigured || hasBootstrappedRef.current) {
      return;
    }

    hasBootstrappedRef.current = true;
    void bootstrapThread();
  }, [bootstrapThread, isConfigured]);

  if (!isConfigured) {
    return (
      <SafeAreaView edges={['bottom']} style={styles.screen}>
        <View style={styles.centerCard}>
          <Text style={styles.eyebrow}>Chat backend not configured</Text>
          <Text style={styles.title}>Troli</Text>
          <Text style={styles.body}>
            Add the LangGraph Cloud URL and API key before testing the mobile
            chat flow.
          </Text>
          <Text style={styles.missingConfig}>{missingConfig.join('\n')}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void signOut();
            }}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed ? styles.buttonPressed : null,
            ]}
          >
            <Text style={styles.secondaryButtonText}>Sign out</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={styles.screen}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={keyboardVerticalOffset}
        style={styles.flex}
      >
        {isBootstrapping && messages.length === 0 ? (
          <View style={styles.loadingState}>
            <ActivityIndicator color="#1f5c4a" size="large" />
            <Text style={styles.loadingTitle}>Bootstrapping your thread</Text>
            <Text style={styles.loadingBody}>
              Troli is creating or reconnecting to your single persistent chat.
            </Text>
          </View>
        ) : (
          <>
            {errorMessage ? (
              <Pressable
                accessibilityRole="button"
                onPress={clearError}
                style={({ pressed }) => [
                  styles.errorBanner,
                  pressed ? styles.buttonPressed : null,
                ]}
              >
                <Text style={styles.errorTitle}>Connection issue</Text>
                <Text style={styles.errorBody}>{errorMessage}</Text>
                <Text style={styles.errorHint}>Tap to dismiss</Text>
              </Pressable>
            ) : null}

            <FlatList
              automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
              contentContainerStyle={styles.listContent}
              data={messages}
              keyExtractor={(item) => item.id}
              keyboardDismissMode={
                Platform.OS === 'ios' ? 'interactive' : 'on-drag'
              }
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <View style={styles.emptyState}>
                  <Text style={styles.emptyTitle}>
                    Walking skeleton is live
                  </Text>
                  <Text style={styles.emptyBody}>
                    Send a message to create the first turn in your thread.
                  </Text>
                </View>
              }
              ListFooterComponent={isSending ? <TypingIndicator /> : null}
              onScrollBeginDrag={() => {
                Keyboard.dismiss();
              }}
              renderItem={({ item }) => <MessageBubble message={item} />}
            />

            {isKeyboardVisible ? (
              <View style={styles.keyboardAccessory}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    Keyboard.dismiss();
                  }}
                  style={({ pressed }) => [
                    styles.keyboardDismissButton,
                    pressed ? styles.buttonPressed : null,
                  ]}
                >
                  <Text style={styles.keyboardDismissText}>Done</Text>
                </Pressable>
              </View>
            ) : null}

            <View style={styles.inputWrap}>
              <ChatInput
                disabled={isBootstrapping || isSending}
                onSend={(text) => sendMessage(text)}
              />
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: {
    color: '#51483f',
    fontSize: 16,
    lineHeight: 23,
  },
  buttonPressed: {
    opacity: 0.92,
  },
  centerCard: {
    backgroundColor: '#fffdf8',
    borderColor: '#d8cec0',
    borderRadius: 28,
    borderWidth: 1,
    gap: 14,
    margin: 24,
    padding: 28,
  },
  emptyBody: {
    color: '#61584d',
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'center',
  },
  emptyState: {
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 48,
  },
  emptyTitle: {
    color: '#1f2a24',
    fontSize: 22,
    fontWeight: '800',
  },
  errorBanner: {
    backgroundColor: '#f8e8e1',
    borderColor: '#dfc1b5',
    borderRadius: 20,
    borderWidth: 1,
    gap: 4,
    marginHorizontal: 16,
    marginTop: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  errorBody: {
    color: '#7c2d1c',
    fontSize: 14,
    lineHeight: 20,
  },
  errorHint: {
    color: '#9a5d4a',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  errorTitle: {
    color: '#7c2d1c',
    fontSize: 14,
    fontWeight: '800',
  },
  eyebrow: {
    color: '#7a6f63',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  flex: {
    flex: 1,
  },
  inputWrap: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    paddingTop: 10,
  },
  keyboardAccessory: {
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  keyboardDismissButton: {
    backgroundColor: '#e4efe8',
    borderColor: '#b9d0c4',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  keyboardDismissText: {
    color: '#1f5c4a',
    fontSize: 13,
    fontWeight: '700',
  },
  listContent: {
    flexGrow: 1,
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 18,
  },
  loadingBody: {
    color: '#61584d',
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 280,
    textAlign: 'center',
  },
  loadingState: {
    alignItems: 'center',
    flex: 1,
    gap: 12,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  loadingTitle: {
    color: '#1f2a24',
    fontSize: 24,
    fontWeight: '800',
  },
  missingConfig: {
    color: '#7c2d1c',
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 13,
    lineHeight: 19,
  },
  screen: {
    backgroundColor: '#f4f1ea',
    flex: 1,
  },
  secondaryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: '#1f5c4a',
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 18,
  },
  secondaryButtonText: {
    color: '#1f5c4a',
    fontSize: 15,
    fontWeight: '700',
  },
  title: {
    color: '#1f2a24',
    fontSize: 32,
    fontWeight: '800',
  },
});
