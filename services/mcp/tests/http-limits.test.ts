import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceLimits } from '../src/limits';
import type { DiagnosticEvent } from '../src/diagnostics';
import { fullService } from './helpers/full-service';

test('real OAuth HTTP admission limits calls and public registration without logging private input', { timeout: 120_000 }, async t => {
  const events: DiagnosticEvent[] = [];
  const h = await fullService(t, { limits: new ServiceLimits({ limits: {
    mcpPerGrantPerMinute: 2, loginPerMinute: 2, registrationPerHour: 2,
  } }), diagnostics: event => { events.push(event); } });
  const account = await h.account();
  await account.authorize();
  const client = await account.connect();
  const invalid = await client.callTool({ name: 'get_coin_balance', arguments: { private: 'private diagnostic sentinel' } });
  assert.equal((invalid.structuredContent as { error: { code: string } }).error.code, 'INVALID_INPUT');
  assert.ok(!(await client.callTool({ name: 'get_coin_balance', arguments: {} })).isError);
  const limited = await client.callTool({ name: 'get_coin_balance', arguments: {} });
  assert.equal((limited.structuredContent as { error?: { code: string } }).error?.code, 'RATE_LIMITED');
  assert.equal(limited.isError, true);
  assert.equal(events.length, 3);
  assert.equal(events[0].errorCode, 'INVALID_INPUT'); assert.equal(events[2].errorCode, 'RATE_LIMITED');
  assert.ok(events.every(event => event.tool === 'get_coin_balance' && event.durationMs >= 0));
  const serialized = JSON.stringify(events);
  for (const secret of ['private diagnostic sentinel', account.credentials.email, account.credentials.password,
    account.signed.session.token, account.provider.tokens()!.access_token]) assert.ok(!serialized.includes(secret));
  const exhaustedLogin = await fetch(h.publicOrigin + '/mcp/account/sign-in', { method: 'POST',
    headers: { origin: h.publicOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=private+sentinel' });
  assert.equal(exhaustedLogin.status, 429); assert.ok(Number(exhaustedLogin.headers.get('retry-after')) > 0);
  const metadata = { client_name: 'synthetic bounded client', redirect_uris: ['https://client.synthetic.test/callback'],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
  const register = () => fetch(h.publicOrigin + '/mcp/auth/oauth2/register', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(metadata) });
  const registered = await register();
  assert.equal(registered.status, 201, await registered.clone().text());
  const limitedRegistration = await register();
  assert.equal(limitedRegistration.status, 429);
  assert.ok(Number(limitedRegistration.headers.get('retry-after')) > 0);
  assert.ok(!(await limitedRegistration.text()).includes('synthetic bounded client'));
});
