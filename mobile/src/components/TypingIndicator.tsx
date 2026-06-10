import { Animated, StyleSheet, View } from 'react-native';
import { useEffect, useRef } from 'react';

export function TypingIndicator() {
  const dots = useRef(
    Array.from({ length: 3 }, () => new Animated.Value(0.28)),
  ).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.stagger(
        120,
        dots.map((dot) =>
          Animated.sequence([
            Animated.timing(dot, {
              duration: 220,
              toValue: 1,
              useNativeDriver: true,
            }),
            Animated.timing(dot, {
              duration: 220,
              toValue: 0.28,
              useNativeDriver: true,
            }),
          ]),
        ),
      ),
    );

    animation.start();

    return () => {
      animation.stop();
    };
  }, [dots]);

  return (
    <View style={styles.row}>
      <View style={styles.bubble}>
        {dots.map((dot, index) => (
          <Animated.View
            key={index}
            style={[
              styles.dot,
              {
                opacity: dot,
                transform: [
                  {
                    scale: dot.interpolate({
                      inputRange: [0.28, 1],
                      outputRange: [0.92, 1.14],
                    }),
                  },
                ],
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    alignItems: 'center',
    backgroundColor: '#fffdf8',
    borderColor: '#d8cec0',
    borderRadius: 22,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  dot: {
    backgroundColor: '#8d8377',
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  row: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    marginTop: 4,
  },
});
