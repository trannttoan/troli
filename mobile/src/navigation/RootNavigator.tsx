import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SignInScreen } from '../screens/SignInScreen';
import { useAuthStore } from '../store/auth';

type RootStackParamList = {
  Home: undefined;
  SignIn: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function SessionScreen() {
  const email = useAuthStore((state) => state.email);
  const signOut = useAuthStore((state) => state.signOut);

  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.title}>Signed in</Text>
        <Text style={styles.bodyText}>
          {email ?? 'Unknown account'}
        </Text>
        <Text style={styles.helperText}>
          Auth is active, tokens are persisted in SecureStore, and Subtask 3 can replace this screen with the chat UI.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void signOut();
          }}
          style={({ pressed }) => [
            styles.secondaryButton,
            pressed ? styles.buttonPressed : null,
          ]}>
          <Text style={styles.secondaryButtonText}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function RootNavigator() {
  const status = useAuthStore((state) => state.status);

  return (
    <Stack.Navigator
      screenOptions={{
        animation: 'fade',
        contentStyle: styles.navigatorContent,
        headerShadowVisible: false,
      }}>
      {status === 'signed_in' ? (
        <Stack.Screen
          component={SessionScreen}
          name="Home"
          options={{ headerTitle: 'Troli' }}
        />
      ) : (
        <Stack.Screen
          component={SignInScreen}
          name="SignIn"
          options={{ headerShown: false }}
        />
      )}
    </Stack.Navigator>
  );
}

const styles = StyleSheet.create({
  bodyText: {
    color: '#1f2a24',
    fontSize: 18,
    fontWeight: '600',
  },
  buttonPressed: {
    opacity: 0.9,
  },
  card: {
    backgroundColor: '#fffdf8',
    borderColor: '#d8cec0',
    borderRadius: 28,
    borderWidth: 1,
    gap: 14,
    maxWidth: 420,
    padding: 28,
    width: '100%',
  },
  helperText: {
    color: '#61584d',
    fontSize: 15,
    lineHeight: 22,
  },
  navigatorContent: {
    backgroundColor: '#f4f1ea',
  },
  screen: {
    alignItems: 'center',
    backgroundColor: '#f4f1ea',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  secondaryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: '#1f5c4a',
    borderRadius: 16,
    borderWidth: 1,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  secondaryButtonText: {
    color: '#1f5c4a',
    fontSize: 15,
    fontWeight: '700',
  },
  title: {
    color: '#1f2a24',
    fontSize: 28,
    fontWeight: '800',
  },
});
