import { escapeHtml as escape } from './owner-pages';

export type AuthPage = { kind: 'sign-in' | 'consent'; clientName: string; scopes: readonly string[];
  oauthQuery: string; csrf: string; error?: string };
const permissions: Record<string, string> = {
  'habits:read': 'Read your habits, check-ins and stacks',
  'habits:notes:read': 'Read the personal notes on your check-ins',
  'coins:read': 'Read your coin balance, rewards and coin history',
  'checkins:write': 'Create check-ins and undo check-ins made through this connection',
  'rewards:claim': 'Confirm and claim rewards after showing their cost',
  openid: 'Identify your connected account', offline_access: 'Keep this connection until it expires or you disconnect it',
};
export function renderAuthPage(page: AuthPage): string {
  const consent = page.kind === 'consent';
  const writeConsent = consent && page.scopes.some(scope => scope === 'checkins:write' || scope === 'rewards:claim');
  const hidden = `<input type="hidden" name="oauth_query" value="${escape(page.oauthQuery)}"><input type="hidden" name="csrf" value="${escape(page.csrf)}">`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${consent ? 'Connect' : 'Sign in'} | Habit System</title><style>
  :root{font:100%/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark;--bg:#f5f5f7;--surface:#fff;--ink:#1c1c1e;--muted:#636366;--line:#d1d1d6;--accent:#146c50;--error:#b42318}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}main{width:min(100% - 2rem,28rem);margin:clamp(2rem,8vh,6rem) auto;padding:1.75rem;background:var(--surface);border:1px solid var(--line);border-radius:1rem}header{border-bottom:1px solid var(--line);padding-bottom:1rem;margin-bottom:1rem}.brand{font-size:.875rem;font-weight:600;letter-spacing:.025em;color:var(--muted);margin:0 0 .75rem}h1{font-size:1.625rem;line-height:1.2;letter-spacing:-.025em;margin:0 0 .5rem}p{margin:.375rem 0 0}.client{font-size:1.125rem;font-weight:600;overflow-wrap:anywhere}.muted,footer{color:var(--muted);font-size:.875rem}ul{padding-left:1.25rem;margin:.75rem 0 1rem}li+li{margin-top:.5rem}label{display:block;font-weight:600;font-size:.875rem;margin:.875rem 0 .375rem}input{width:100%;font:inherit;padding:.625rem;border:1px solid var(--line);border-radius:.5rem;background:var(--surface);color:var(--ink)}input:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}button{width:100%;font:inherit;font-weight:600;padding:.75rem 1rem;border:0;border-radius:.5rem;cursor:pointer;background:var(--accent);color:#fff;margin-top:1rem;min-height:2.75rem}.secondary{background:transparent;color:var(--muted);margin-top:.25rem}footer{margin-top:1rem}.error{color:var(--error);padding:.75rem 0;margin-bottom:.5rem}form{margin:0}@media(max-width:420px){main{padding:1.25rem;margin-top:1rem}}@media(prefers-color-scheme:dark){:root{--bg:#111113;--surface:#1c1c1e;--ink:#f2f2f7;--muted:#aeaeb2;--line:#48484a;--accent:#287e61;--error:#ffb4ab}}
  </style></head><body><main><header><p class="brand">Habit System</p><h1>${consent ? 'Connect your account' : 'Sign in to connect'}</h1><p class="client">${escape(page.clientName)}</p><p class="muted">${consent ? 'This app is asking for permission to:' : 'Use your existing Habit System account to continue.'}</p></header>
  ${page.error ? `<p class="error" role="alert">${escape(page.error)}</p>` : ''}
  <form method="post" action="/mcp/${page.kind}">${hidden}${consent
    ? `<ul>${page.scopes.map(scope => `<li>${escape(permissions[scope] ?? scope)}</li>`).join('')}</ul>${writeConsent
      ? '<p class="muted">Write access can deliver this account\'s accepted check-ins and their reconciliation changes. Confirm your password to approve this connection.</p><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" maxlength="320" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="4096" required>'
      : '<p class="muted">Only approve apps you trust. You can disconnect this app later.</p>'}<button name="decision" value="allow">${writeConsent ? 'Confirm and allow' : 'Allow connection'}</button><button class="secondary" name="decision" value="deny" formnovalidate>Cancel</button>`
    : '<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" maxlength="320" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="4096" required><button type="submit">Continue</button>'}
  </form><footer>${consent ? 'Your password is used only to verify this approval. It is never shared with the requesting app.' : 'Sign in with the account you already use in Habit System.'}</footer></main></body></html>`;
}
