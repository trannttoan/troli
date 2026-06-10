import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type ChatInputProps = {
  disabled?: boolean;
  onSend: (text: string) => Promise<void> | void;
};

export function ChatInput({ disabled = false, onSend }: ChatInputProps) {
  const [text, setText] = useState('');

  const trimmedText = text.trim();
  const canSend = !disabled && trimmedText.length > 0;

  async function handleSend() {
    if (!canSend) {
      return;
    }

    const nextText = trimmedText;
    setText('');

    try {
      await onSend(nextText);
    } catch {
      setText(nextText);
    }
  }

  return (
    <View style={styles.container}>
      <TextInput
        editable={!disabled}
        multiline
        onChangeText={setText}
        onSubmitEditing={() => {
          void handleSend();
        }}
        placeholder="Ask Troli anything about your day."
        placeholderTextColor="#8d8377"
        returnKeyType="send"
        style={[
          styles.input,
          disabled ? styles.inputDisabled : null,
        ]}
        value={text}
      />
      <Pressable
        accessibilityRole="button"
        disabled={!canSend}
        onPress={() => {
          void handleSend();
        }}
        style={({ pressed }) => [
          styles.button,
          !canSend ? styles.buttonDisabled : null,
          pressed && canSend ? styles.buttonPressed : null,
        ]}>
        <Text style={styles.buttonText}>Send</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: '#1f5c4a',
    borderRadius: 18,
    height: 52,
    justifyContent: 'center',
    minWidth: 74,
    paddingHorizontal: 18,
  },
  buttonDisabled: {
    backgroundColor: '#9daf9f',
  },
  buttonPressed: {
    opacity: 0.92,
  },
  buttonText: {
    color: '#f7f4ee',
    fontSize: 15,
    fontWeight: '700',
  },
  container: {
    alignItems: 'flex-end',
    backgroundColor: '#fffdf8',
    borderColor: '#d8cec0',
    borderRadius: 24,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 12,
  },
  input: {
    color: '#1f2a24',
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    maxHeight: 132,
    minHeight: 52,
    paddingHorizontal: 2,
    paddingTop: 14,
  },
  inputDisabled: {
    color: '#756b60',
  },
});
