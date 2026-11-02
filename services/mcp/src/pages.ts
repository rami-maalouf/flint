// server-rendered pages for sign-in, consent and connection management. no scripts.

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

const style = `:root{font:100%/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark;--bg:#f5f5f7;--surface:#fff;--ink:#1c1c1e;--muted:#636366;--line:#d1d1d6;--accent:#1c1c1e;--on-accent:#fff;--error:#b42318}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}main{width:min(100% - 2rem,28rem);margin:clamp(2rem,8vh,6rem) auto;padding:1.75rem;background:var(--surface);border:1px solid var(--line);border-radius:1rem}
header{border-bottom:1px solid var(--line);padding-bottom:1rem;margin-bottom:1rem}.brand{font-size:.875rem;font-weight:600;letter-spacing:.025em;color:var(--muted);margin:0 0 .75rem}h1{font-size:1.625rem;line-height:1.2;letter-spacing:-.025em;margin:0 0 .5rem}p{margin:.375rem 0 0}
.client{font-size:1.125rem;font-weight:600;overflow-wrap:anywhere}.muted,footer{color:var(--muted);font-size:.875rem}label{display:block;font-weight:600;font-size:.875rem;margin:.875rem 0 .375rem}
input[type=email],input[type=password]{width:100%;font:inherit;padding:.625rem;border:1px solid var(--line);border-radius:.5rem;background:var(--surface);color:var(--ink)}
.choice{display:flex;gap:.75rem;align-items:flex-start;font-weight:400;font-size:1rem;margin:.75rem 0}.choice input{margin-top:.3rem;width:1.125rem;height:1.125rem;accent-color:var(--accent)}.choice small{display:block;color:var(--muted);font-size:.875rem}
input:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}button{width:100%;font:inherit;font-weight:600;padding:.75rem 1rem;border:0;border-radius:.5rem;cursor:pointer;background:var(--accent);color:var(--on-accent);margin-top:1rem;min-height:2.75rem}
.secondary{background:transparent;color:var(--muted);margin-top:.25rem}footer{margin-top:1rem}.error{color:var(--error);margin:0 0 .5rem}form{margin:0}
ul{list-style:none;padding:0;margin:0}li{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.875rem 0;border-bottom:1px solid var(--line)}li:last-child{border-bottom:0}li button{width:auto;margin:0;min-height:2.25rem;padding:.375rem .875rem;background:transparent;color:var(--error);border:1px solid var(--line)}
@media(max-width:420px){main{padding:1.25rem;margin-top:1rem}}@media(prefers-color-scheme:dark){:root{--bg:#111113;--surface:#1c1c1e;--ink:#f2f2f7;--muted:#aeaeb2;--line:#48484a;--accent:#f2f2f7;--on-accent:#1c1c1e;--error:#ffb4ab}}`;

function shell(title: string, heading: string, intro: string, body: string, footer = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} | Flint</title><style>${style}</style></head>` +
    `<body><main><header><p class="brand">Flint</p><h1>${escapeHtml(heading)}</h1>${intro}</header>${body}` +
    `${footer ? `<footer>${footer}</footer>` : ''}</main></body></html>`;
}

const credentials = '<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" maxlength="320" required>' +
  '<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required>';

const hidden = (fields: Record<string, string>) => Object.entries(fields)
  .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join('');

const errorLine = (error?: string) => error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';

export function signInPage(page: { clientName?: string; action: string; fields: Record<string, string>; error?: string }): string {
  const intro = page.clientName
    ? `<p class="client">${escapeHtml(page.clientName)}</p><p class="muted">wants to connect to your Flint account.</p>`
    : '<p class="muted">Sign in to manage the apps connected to your account.</p>';
  return shell('Sign in', 'Sign in to Flint', intro,
    `${errorLine(page.error)}<form method="post" action="${page.action}">${hidden(page.fields)}${credentials}<button type="submit">Continue</button></form>`,
    'Use the account you already use in the Flint app. Your password is sent only to Flint.');
}

export function consentPage(page: { clientName: string; oauthQuery: string; canWrite: boolean; error?: string }): string {
  const write = page.canWrite ? `<label class="choice"><input type="checkbox" name="write" value="1" checked>` +
    `<span>Make changes<small>Record and undo check-ins, and claim rewards after you confirm the cost.</small></span></label>` : '';
  return shell('Connect', 'Connect your account', `<p class="client">${escapeHtml(page.clientName)}</p><p class="muted">is asking to:</p>`,
    `${errorLine(page.error)}<form method="post" action="/mcp/consent">${hidden({ oauth_query: page.oauthQuery })}` +
    `<label class="choice"><input type="checkbox" checked disabled><span>Read your habits<small>Habits, check-ins, stacks, coins and rewards.</small></span></label>` +
    `${write}<button name="decision" value="allow">Allow</button><button class="secondary" name="decision" value="deny" formnovalidate>Cancel</button></form>`,
    'Only connect apps you trust. You can disconnect them at any time from <a href="/mcp/connections">Connected apps</a>.');
}

export type Connection = { id: string; name: string; canWrite: boolean };

export function connectionsPage(connections: Connection[], notice?: string): string {
  const list = connections.length === 0 ? '<p class="muted">No apps are connected.</p>' : `<ul>${connections.map(connection =>
    `<li><span><strong>${escapeHtml(connection.name)}</strong><br><span class="muted">${connection.canWrite ? 'Can read and make changes' : 'Can read'}</span></span>` +
    `<form method="post" action="/mcp/connections">${hidden({ action: 'disconnect', consent: connection.id })}<button>Disconnect</button></form></li>`).join('')}</ul>`;
  return shell('Connected apps', 'Connected apps', '<p class="muted">Apps that can use your Flint account through MCP.</p>',
    `${notice ? `<p class="muted" role="status">${escapeHtml(notice)}</p>` : ''}${list}`);
}

export function messagePage(heading: string, text: string): string {
  return shell(heading, heading, `<p class="muted">${escapeHtml(text)}</p>`, '');
}
