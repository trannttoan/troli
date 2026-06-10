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

function HeaderAccount() {
  const email = useAuthStore((state) => state.email);
  const signOut = useAuthStore((state) => state.signOut);

  return (
    <View style={styles.headerAccount}>
      <Text numberOfLines={1} style={styles.headerEmail}>
        {email ?? 'Unknown account'}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void signOut();
        }}
        style={({ pressed }) => [
          styles.headerSignOut,
          pressed ? styles.buttonPressed : null,
        ]}>
        <Text style={styles.headerSignOutText}>Sign out</Text>
      </Pressable>
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
          component={ChatScreen}
          name="Chat"
          options={{
            headerBackVisible: false,
            headerRight: HeaderAccount,
            headerTitle: 'Troli',
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
  headerAccount: {
    alignItems: 'flex-end',
    gap: 6,
    maxWidth: 180,
  },
  headerEmail: {
    color: '#61584d',
    fontSize: 11,
    fontWeight: '600',
  },
  headerSignOut: {
    borderColor: '#1f5c4a',
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  headerSignOutText: {
    color: '#1f5c4a',
    fontSize: 12,
    fontWeight: '700',
  },
  navigatorContent: {
    backgroundColor: '#f4f1ea',
  },
});
