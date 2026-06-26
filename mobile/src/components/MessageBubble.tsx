import { StyleSheet, Text, View } from 'react-native';

import type { ChatMessage } from '../store/chat';

type MessageBubbleProps = {
  message: ChatMessage;
};

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <View style={[styles.row, isUser ? styles.userRow : styles.assistantRow]}>
      <View
        style={[
          styles.bubble,
          isUser ? styles.userBubble : styles.assistantBubble,
        ]}
      >
        <Text
          style={[styles.text, isUser ? styles.userText : styles.assistantText]}
        >
          {message.text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  assistantBubble: {
    backgroundColor: '#fffdf8',
    borderColor: '#d8cec0',
  },
  assistantRow: {
    justifyContent: 'flex-start',
  },
  assistantText: {
    color: '#1f2a24',
  },
  bubble: {
    borderRadius: 22,
    borderWidth: 1,
    maxWidth: '88%',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  row: {
    flexDirection: 'row',
    width: '100%',
  },
  text: {
    fontSize: 16,
    lineHeight: 23,
  },
  userBubble: {
    backgroundColor: '#1f5c4a',
    borderColor: '#1f5c4a',
  },
  userRow: {
    justifyContent: 'flex-end',
  },
  userText: {
    color: '#f7f4ee',
  },
});
