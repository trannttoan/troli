import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enableScreens } from 'react-native-screens';

import { RootNavigator } from './src/navigation/RootNavigator';
import { useAuthStore } from './src/store/auth';

enableScreens();

const navigationTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: '#f4f1ea',
    card: '#f4f1ea',
    border: '#d8cec0',
    primary: '#1f5c4a',
    text: '#1f2a24',
  },
};

function LoadingScreen() {
  return (
    <View style={styles.loadingScreen}>
      <ActivityIndicator color="#1f5c4a" size="large" />
    </View>
  );
}

export default function App() {
  const initialize = useAuthStore((state) => state.initialize);
  const status = useAuthStore((state) => state.status);
  const hasInitialized = useRef(false);

  useEffect(() => {
    if (hasInitialized.current) {
      return;
    }

    hasInitialized.current = true;
    void initialize();
  }, [initialize]);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {status === 'loading' ? (
        <LoadingScreen />
      ) : (
        <NavigationContainer theme={navigationTheme}>
          <RootNavigator />
        </NavigationContainer>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loadingScreen: {
    alignItems: 'center',
    backgroundColor: '#f4f1ea',
    flex: 1,
    justifyContent: 'center',
  },
});
