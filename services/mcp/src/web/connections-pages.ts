import { escapeHtml, renderOwnerLayout } from './owner-pages';

export type ConnectionPageItem = Readonly<{ grantId: string; clientId: string; scopes: readonly string[];
  active: boolean; credentialScope: 'read' | 'full'; expiresAt: number; revokeCsrf: string; resumeCsrf: string }>;

const permissionNames: Record<string, string> = {
  'habits:read': 'Habits and check-ins', 'habits:notes:read': 'Habit notes', 'coins:read': 'Coins and rewards',
  'checkins:write': 'Create and undo check-ins', 'rewards:claim': 'Claim rewards',
  openid: 'Account identity', offline_access: 'Keep this connection',
};
const pageStyle = `<style>
  .connection-intro{color:var(--muted);margin-bottom:1.5rem}.connection-list{list-style:none;padding:0;margin:0}.connection-card{border-top:1px solid var(--line);padding:1.5rem 0}.connection-card:first-child{border-top:0;padding-top:0}.connection-card h2{margin:.25rem 0}.connection-id{font-size:.875rem;overflow-wrap:anywhere;word-break:break-word}.connection-status{font-weight:650}.connection-expiry{font-size:.875rem;color:var(--muted)}.connection-permissions{padding-left:1.25rem;margin:.5rem 0 1rem}.connection-permissions li{padding:.1rem 0}.connection-consent{display:flex;gap:.75rem;align-items:flex-start;min-height:44px;padding:.75rem 0;cursor:pointer}.connection-consent input{width:1.25rem;height:1.25rem;flex:none;margin:.15rem 0 0;accent-color:var(--accent)}.connection-danger{margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--line)}.connection-danger button{background:transparent;color:var(--error);border:1px solid var(--error)}.connection-help{font-size:.875rem;color:var(--muted)}@media(max-width:420px){.connection-card{padding:1.25rem 0}}
</style>`;

function permissionList(scopes: readonly string[]): string {
  const names = [...new Set(scopes.map(scope => permissionNames[scope] ?? 'Unknown permission'))];
  return `<ul class="connection-permissions">${names.map(name => `<li>${escapeHtml(name)}</li>`).join('')}</ul>`;
}

export function renderConnectionsPage(items: readonly ConnectionPageItem[], nowUtcMs = Date.now()): string {
  const e = escapeHtml;
  const cards = items.map(item => {
    const validExpiry = Number.isFinite(item.expiresAt) && item.expiresAt > 0 && item.expiresAt <= 8.64e15;
    const expired = !validExpiry || item.expiresAt <= nowUtcMs;
    const status = expired ? 'Expired' : item.active ? 'Active' : 'Disconnected';
    const expiry = validExpiry
      ? new Date(item.expiresAt).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : 'Unknown';
    const mayResume = item.active && !expired && item.credentialScope === 'full' &&
      (item.scopes.includes('checkins:write') || item.scopes.includes('rewards:claim'));
    return `<li class="connection-card"><h2>${item.credentialScope === 'full' ? 'Write connection' : 'Read connection'}</h2>
      <p class="connection-status">${status}</p><p class="connection-help">Requesting app ID</p><p class="connection-id">${e(item.clientId)}</p>
      <p class="connection-expiry">Expires ${e(expiry)}</p><p class="connection-help">Permissions</p>${permissionList(item.scopes)}
      ${!item.active || expired ? '<p class="notice">Reconnect from the requesting app with this same account. This page cannot refresh an ended or expired session.</p>' : ''}
      ${mayResume ? `<form method="post" action="/mcp/connections" data-action="resume" data-grant-id="${e(item.grantId)}">
        <input type="hidden" name="action" value="resume"><input type="hidden" name="grant_id" value="${e(item.grantId)}"><input type="hidden" name="csrf" value="${e(item.resumeCsrf)}">
        <label class="connection-consent"><input type="checkbox" name="consent" value="all_pending" required><span>I authorize this connection to deliver all accepted pending work for this account, including work from disconnected apps and related account updates.</span></label>
        <button type="submit">Resume pending delivery</button></form>` : ''}
      <div class="connection-danger"><form method="post" action="/mcp/connections" data-action="revoke" data-grant-id="${e(item.grantId)}">
        <input type="hidden" name="action" value="revoke"><input type="hidden" name="grant_id" value="${e(item.grantId)}"><input type="hidden" name="csrf" value="${e(item.revokeCsrf)}">
        <button type="submit">Disconnect connection</button></form></div></li>`;
  }).join('');
  return renderOwnerLayout('Connections', `${pageStyle}<p class="connection-intro">Review the apps connected to this account. Disconnecting one can pause pending delivery for the whole account.</p>
    ${cards ? `<ul class="connection-list">${cards}</ul>` : '<p class="notice">No connections yet. Connect from a supported app to get started.</p>'}
    <footer>Resume authorizes a delivery attempt. Some work may remain pending if the backend is unavailable or account recovery is required.</footer>`);
}

export function renderConnectionState(state: 'revoked' | 'resumed' | 'forbidden' | 'reconnect' | 'recovery' | 'unavailable' | 'invalid'): string {
  const content = {
    revoked: ['Connection disconnected', 'This connection can no longer use its grant. Pending account delivery may need an owner-authorized resume.'],
    resumed: ['Resume authorized', 'The account attempted pending delivery. Some work may still be queued; review the connection status again later.'],
    forbidden: ['Account verification required', 'This action needs a current owner browser session and a valid form for this connection.'],
    reconnect: ['Reconnect required', 'Reconnect from the requesting app with this same account. An expired or read-only connection cannot resume delivery.'],
    recovery: ['Account needs recovery', 'Delivery remains paused. Account history needs trusted recovery before pending work can continue.'],
    unavailable: ['Connections unavailable', 'The action could not finish. Check connection status before trying again.'],
    invalid: ['Form unavailable', 'Open the connections page again and review the current connection before submitting.'],
  }[state];
  return renderOwnerLayout(content[0], `<p class="notice" role="status">${content[1]}</p><a class="button secondary" href="/mcp/connections">Back to connections</a>`);
}
