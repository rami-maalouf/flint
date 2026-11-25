// keep the rating action hidden until the app's store listing is public.

export type ReleaseLinkKey =
  | 'feedback'
  | 'appStoreReview'
  | 'moreProducts'
  | 'privacyPolicy'
  | 'termsOfUse';

const RELEASE_LINKS: Record<ReleaseLinkKey, string | null> = {
  feedback: null,
  appStoreReview: null,
  moreProducts: 'https://apps.apple.com/developer/rami-maalouf/id1783932552',
  privacyPolicy: null,
  termsOfUse: null,
};

export function releaseLink(
  key: ReleaseLinkKey,
  links: Record<ReleaseLinkKey, string | null> = RELEASE_LINKS,
): string | null {
  const value = links[key];
  if (value !== null && !value.startsWith('https://')) {
    return null;
  }
  return value;
}
