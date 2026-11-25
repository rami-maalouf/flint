import { isRunningInExpoGo } from 'expo';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { SampleSessionProvider } from '@/features/sample/session-context';

if (!isRunningInExpoGo()) SplashScreen.setOptions({ duration: 350, fade: true });

export default function RootLayout() {
  const scheme = useColorScheme();
  return <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
    <SampleSessionProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(product)" />
        <Stack.Screen name="sample" options={{ presentation: 'fullScreenModal' }} />
      </Stack>
    </SampleSessionProvider>
  </ThemeProvider>;
}
