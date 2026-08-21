import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ChatScreen } from '../screens/ChatScreen';
import { SignInScreen } from '../screens/SignInScreen';
import { useAuthStore } from '../store/auth';

type RootStackParamList = {
  Chat: undefined;
  SignIn: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function HeaderTitle() {
  const email = useAuthStore((state) => state.email);

  return (
    <View style={styles.headerTitleWrap}>
      <Text style={styles.headerTitle}>Aisist</Text>
      <Text numberOfLines={1} style={styles.headerEmail}>
        {email ?? 'Unknown account'}
      </Text>
    </View>
  );
}

function HeaderSignOut() {
  const signOut = useAuthStore((state) => state.signOut);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        void signOut();
      }}
      style={({ pressed }) => [
        styles.headerSignOut,
        pressed ? styles.buttonPressed : null,
      ]}
    >
      <Text style={styles.headerSignOutText}>Sign out</Text>
    </Pressable>
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
      }}
    >
      {status === 'signed_in' ? (
        <Stack.Screen
          component={ChatScreen}
          name="Chat"
          options={{
            headerBackVisible: false,
            headerRight: HeaderSignOut,
            headerTitle: HeaderTitle,
            headerTitleAlign: 'left',
          }}
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
  buttonPressed: {
    opacity: 0.9,
  },
  headerEmail: {
    color: '#61584d',
    fontSize: 12,
    fontWeight: '500',
  },
  headerTitle: {
    color: '#1f2a24',
    fontSize: 18,
    fontWeight: '800',
  },
  headerTitleWrap: {
    gap: 2,
    maxWidth: 220,
  },
  headerSignOut: {
    backgroundColor: '#1f5c4a',
    borderColor: '#1f5c4a',
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  headerSignOutText: {
    color: '#f7f4ee',
    fontSize: 12,
    fontWeight: '700',
  },
  navigatorContent: {
    backgroundColor: '#f4f1ea',
  },
});
