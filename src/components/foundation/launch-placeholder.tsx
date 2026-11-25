import { Image } from 'expo-image';
import { StyleSheet, useColorScheme, View } from 'react-native';

export function LaunchPlaceholder({ testID }: { testID: string }) {
  const dark = useColorScheme() === 'dark';

  return (
    <View
      accessible
      accessibilityLabel="Loading Flint"
      accessibilityRole="progressbar"
      accessibilityState={{ busy: true }}
      style={[styles.container, { backgroundColor: dark ? '#000000' : '#ffffff' }]}
      testID={testID}
    >
      <Image
        accessible={false}
        contentFit="contain"
        source={require('../../../assets/images/splash-icon.png')}
        style={styles.flame}
        testID="launch-flame"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  flame: { width: 180, height: 180 },
});
