export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

// body is composed only by the trusted renderers, which escape every stored or request-derived value.
export function renderOwnerLayout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} | Flint</title><style>
  :root{font:100%/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark;--bg:#f5f5f7;--surface:#fff;--ink:#1c1c1e;--muted:#636366;--line:#d1d1d6;--accent:#1c1c1e;--on-accent:#fff;--error:#b42318}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}main{width:min(100% - 2rem,32rem);margin:clamp(1rem,6vh,4rem) auto;padding:1.75rem;background:var(--surface);border:1px solid var(--line);border-radius:1rem}header{margin-bottom:1.5rem}.brand{font-size:.875rem;font-weight:600;letter-spacing:.025em;color:var(--muted);margin:0 0 .75rem}h1{font-size:1.75rem;line-height:1.2;letter-spacing:-.025em;margin:0 0 .75rem}h2{font-size:1.125rem;line-height:1.4;margin:0;overflow-wrap:anywhere}p{margin:.5rem 0}.muted,footer,dt{color:var(--muted);font-size:.875rem}.cost{font-size:clamp(1.75rem,6vw,2.25rem);font-weight:650;letter-spacing:-.035em;margin:.5rem 0 1rem;overflow-wrap:anywhere}.summary{border-block:1px solid var(--line);padding:1rem 0;margin:1rem 0}dl{margin:0}dl>div{display:flex;justify-content:space-between;gap:1rem;padding:.25rem 0}dt,dd{margin:0}dd{text-align:right;overflow-wrap:anywhere;min-width:0}.identity{font-size:.8125rem;overflow-wrap:anywhere}button,.button{display:block;width:100%;font:inherit;font-weight:600;text-align:center;padding:.75rem 1rem;border:0;border-radius:.5rem;cursor:pointer;background:var(--accent);color:var(--on-accent);margin-top:1rem;min-height:2.75rem;text-decoration:none}.secondary{background:transparent;color:var(--muted);margin-top:.25rem}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:3px}footer{margin-top:1.25rem}form{margin:0}.notice{border-left:3px solid var(--accent);padding-left:1rem}.error{color:var(--error)}@media(max-width:420px){main{padding:1.25rem}dl>div{flex-wrap:wrap}dd{margin-left:auto}}@media(prefers-color-scheme:dark){:root{--bg:#111113;--surface:#1c1c1e;--ink:#f2f2f7;--muted:#aeaeb2;--line:#48484a;--accent:#f2f2f7;--on-accent:#1c1c1e;--error:#ffb4ab}}
  </style></head><body><main><header><p class="brand">Flint</p><h1>${escapeHtml(title)}</h1></header>${body}</main></body></html>`;
}

export type ConfirmationPage = {
  rewardTitle: string; costCoins: number; balance: number; balanceAfterClaim: number | null;
  clientId: string; timeZone: string; expiresAtUtc: number; token: string; csrf: string;
};
export function renderRewardConfirmation(page: ConfirmationPage): string {
  const e = escapeHtml;
  return renderOwnerLayout('Approve this reward?', `<h2>${e(page.rewardTitle)}</h2><p class="cost">${page.costCoins} coins</p>
  <div class="summary"><dl><div><dt>Quoted balance</dt><dd>${page.balance} coins</dd></div><div><dt>After this claim</dt><dd>${page.balanceAfterClaim === null ? 'Insufficient coins' : `${page.balanceAfterClaim} coins`}</dd></div></dl></div>
  <p class="muted">Requesting app</p><p class="identity">${e(page.clientId)}</p><p class="muted">Claim time zone: ${e(page.timeZone)}</p>
  <form method="post" action="/mcp/reward-confirmation"><input type="hidden" name="token" value="${e(page.token)}"><input type="hidden" name="csrf" value="${e(page.csrf)}">
  ${page.balanceAfterClaim === null ? '<p class="notice">There are not enough coins in this quote. Ask the app for a new preview when your balance changes.</p>' : `<button name="decision" value="approve">Approve ${page.costCoins} coins</button>`}<button class="secondary" name="decision" value="deny">Cancel</button></form>
  <footer>Approval lets this app submit this one claim. Coins are checked when it submits; activity on other devices can change your balance. Quote expires at ${e(new Date(page.expiresAtUtc).toISOString())}.</footer>`);
}

export function renderConfirmationState(state: 'approved' | 'cancelled' | 'expired' | 'forbidden' | 'invalid'): string {
  const content = {
    approved: ['Reward approved', 'Return to the requesting app to finish the claim. Approval itself does not spend coins.'],
    cancelled: ['Approval cancelled', 'This request did not approve a reward. You can close this page.'],
    expired: ['Quote expired', 'Ask the requesting app for a new preview, then check the cost again.'],
    forbidden: ['Account verification required', 'This quote cannot be approved with the current account or form. Open the original link and sign in with the account that requested it.'],
    invalid: ['Confirmation unavailable', 'Open the original confirmation link or ask the requesting app for a new preview.'],
  }[state];
  return renderOwnerLayout(content[0], `<p class="notice" role="status">${content[1]}</p><a class="button secondary" href="/mcp/connections">Manage connections</a>`);
}
