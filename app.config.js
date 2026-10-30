const developmentBundleIdentifier = 'studio.orbitlabs.habitsystem.fullstack.dev';
const sharedIdentifier = 'studio.orbitlabs.habitsystem.fullstack';

module.exports = ({ config }) => {
  if (process.env.APP_VARIANT !== 'development') return config;

  const iosBuild = config.extra.eas.build.experimental.ios;
  return {
    ...config,
    icon: './assets/images/icon-development.png',
    ios: {
      ...config.ios,
      bundleIdentifier: developmentBundleIdentifier,
    },
    extra: {
      ...config.extra,
      ripplesSharedIdentifier: sharedIdentifier,
      eas: {
        ...config.extra.eas,
        build: {
          ...config.extra.eas.build,
          experimental: {
            ...config.extra.eas.build.experimental,
            ios: {
              ...iosBuild,
              appExtensions: iosBuild.appExtensions.map((extension) => ({
                ...extension,
                bundleIdentifier: `${developmentBundleIdentifier}.${extension.targetName}`,
              })),
            },
          },
        },
      },
    },
  };
};
