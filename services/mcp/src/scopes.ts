export const readScopes = ['habits:read', 'habits:notes:read', 'coins:read'] as const;
export const writeScopes = ['checkins:write', 'rewards:claim'] as const;
export const scopes = [...readScopes, ...writeScopes] as const;
export type Scope = typeof scopes[number];
