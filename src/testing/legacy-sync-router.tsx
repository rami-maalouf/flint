import { Stack } from 'expo-router';

import { ProductProvider } from '../features/product-store';
import { ICloudScreen } from '../features/settings/icloud-screen';
import { cloudKitTransport } from '../platform/sync';

// the retained icloud screen is reference code; exercise it with its own transport.
export const legacySyncContext = {
  appDir: 'src/app',
  overrides: {
    '(product)/settings/sync': ICloudScreen,
    '(product)/_layout': function LegacySyncLayout() {
      return <ProductProvider syncTransportOverride={cloudKitTransport}><Stack /></ProductProvider>;
    },
  },
};
