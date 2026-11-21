'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const { createOutboxMailer } = require('../server/mailer');

let db, server, base, mailer;
before(async () => {
  db = await createDb({ url: process.env.TEST_DATABASE_URL });
  mailer = createOutboxMailer();
  const app = createApp({ db, mailer, config: { secret: 'test-secret', appName: 'Test', otpPerIpHour: 100000 } });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); });

class Client {
  constructor() { this.cookie = ''; }
  async call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    let json = null; try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, body: json };
  }
}
const lastCode = (email) => {
  const m = [...mailer.outbox].reverse().find((x) => x.to === email && /sign-in code/.test(x.subject));
  return m.text.match(/code is (\d{6})/)[1];
};
async function login(email) {
  const c = new Client();
  await db.query("UPDATE otps SET created_at = created_at - interval '2 minutes' WHERE email = $1", [email]);
  assert.equal((await c.call('POST', '/api/auth/request', { email })).status, 200);
  const r = await c.call('POST', '/api/auth/verify', { email, code: lastCode(email) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const me = await c.call('GET', '/api/me');
  return { c, me: me.body, r: r.body };
}

test('health and catalog are public', async () => {
  const h = await fetch(base + '/healthz'); assert.equal(h.status, 200);
  const cat = await (await fetch(base + '/catalog.json')).json();
  assert.equal(cat.agents.length, 24); assert.equal(cat.skills.length, 164);
});

test('new email: OTP creates account and a personal workspace owned by the user', async () => {
  const { me, r } = await login('new.user@example.com');
  assert.equal(r.isNew, true);
  assert.equal(me.user.email, 'new.user@example.com');
  assert.equal(me.orgs.length, 1);
  assert.equal(me.orgs[0].role, 'owner');
});

test('existing email: second login reuses account, no extra workspace', async () => {
  await login('again@example.com');
  const { me, r } = await login('again@example.com');
  assert.equal(r.isNew, false);
  assert.equal(me.orgs.length, 1);
});

test('email is case-insensitive and trimmed', async () => {
  const c = new Client();
  await c.call('POST', '/api/auth/request', { email: '  Mixed.Case@Example.com ' });
  const r = await c.call('POST', '/api/auth/verify', { email: 'mixed.case@example.com', code: lastCode('mixed.case@example.com') });
  assert.equal(r.status, 200);
});

test('bad emails and malformed codes are rejected', async () => {
  const c = new Client();
  assert.equal((await c.call('POST', '/api/auth/request', { email: 'nope' })).status, 400);
  assert.equal((await c.call('POST', '/api/auth/verify', { email: 'a@b.co', code: '12' })).status, 400);
});

test('wrong code is refused, five misses burn the code, correct code then fails', async () => {
  const email = 'brute@example.com';
  const c = new Client();
  await c.call('POST', '/api/auth/request', { email });
  const good = lastCode(email);
  const wrong = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await c.call('POST', '/api/auth/verify', { email, code: wrong })).status, 400);
  const r = await c.call('POST', '/api/auth/verify', { email, code: good });
  assert.equal(r.status, 400);
  assert.equal((await c.call('GET', '/api/me')).status, 401);
});

test('code is single-use', async () => {
  const email = 'once@example.com';
  const c = new Client();
  await c.call('POST', '/api/auth/request', { email });
  const code = lastCode(email);
  assert.equal((await c.call('POST', '/api/auth/verify', { email, code })).status, 200);
  assert.equal((await new Client().call('POST', '/api/auth/verify', { email, code })).status, 400);
});

test('new request invalidates the previous code; cooldown applies', async () => {
  const email = 'resend@example.com';
  const c = new Client();
  assert.equal((await c.call('POST', '/api/auth/request', { email })).status, 200);
  assert.equal((await c.call('POST', '/api/auth/request', { email })).status, 429);
  // age the first code so the cooldown passes
  await db.query("UPDATE otps SET created_at = now() - interval '2 minutes' WHERE email = $1", [email]);
  const first = lastCode(email);
  assert.equal((await c.call('POST', '/api/auth/request', { email })).status, 200);
  const second = lastCode(email);
  if (first !== second) assert.equal((await c.call('POST', '/api/auth/verify', { email, code: first })).status, 400);
  assert.equal((await c.call('POST', '/api/auth/verify', { email, code: second })).status, 200);
});

test('hourly cap per email', async () => {
  const email = 'cap@example.com';
  const c = new Client();
  for (let i = 0; i < 6; i++) {
    await db.query("UPDATE otps SET created_at = now() - interval '5 minutes' WHERE email = $1", [email]);
    assert.equal((await c.call('POST', '/api/auth/request', { email })).status, 200);
  }
  await db.query("UPDATE otps SET created_at = now() - interval '5 minutes' WHERE email = $1", [email]);
  assert.equal((await c.call('POST', '/api/auth/request', { email })).status, 429);
});

test('expired code is refused', async () => {
  const email = 'expired@example.com';
  const c = new Client();
  await c.call('POST', '/api/auth/request', { email });
  await db.query("UPDATE otps SET expires_at = now() - interval '1 minute' WHERE email = $1", [email]);
  assert.equal((await c.call('POST', '/api/auth/verify', { email, code: lastCode(email) })).status, 400);
});

test('CSRF: mutating calls without the custom header or from another origin are blocked', async () => {
  const noHeader = await fetch(base + '/api/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"x@example.com"}' });
  assert.equal(noHeader.status, 403);
  const c = new Client();
  const evil = await c.call('POST', '/api/auth/request', { email: 'x@example.com' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
});

test('protected routes need a session; logout kills it', async () => {
  assert.equal((await new Client().call('GET', '/api/me')).status, 401);
  const { c } = await login('logout@example.com');
  assert.equal((await c.call('POST', '/api/auth/logout')).status, 200);
  assert.equal((await c.call('GET', '/api/me')).status, 401);
});

test('session cookie is HttpOnly and SameSite', async () => {
  const email = 'cookie@example.com';
  await new Client().call('POST', '/api/auth/request', { email });
  const res = await fetch(base + '/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ email, code: lastCode(email) }) });
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/);
  assert.ok(!sc.includes(lastCode(email)));
});

test('tenant isolation: another workspace is invisible (404), briefs do not leak', async () => {
  const a = await login('tenant.a@example.com');
  const b = await login('tenant.b@example.com');
  const orgA = a.me.orgs[0].id, orgB = b.me.orgs[0].id;
  const made = await a.c.call('POST', `/api/orgs/${orgA}/briefs`, { title: 'Secret plan', agent: 'seo-specialist' });
  assert.equal(made.status, 201);
  assert.equal((await b.c.call('GET', `/api/orgs/${orgA}/briefs`)).status, 404);
  assert.equal((await b.c.call('POST', `/api/orgs/${orgA}/briefs`, { title: 'hack' })).status, 404);
  assert.equal((await b.c.call('PATCH', `/api/orgs/${orgA}/briefs/${made.body.id}`, { title: 'hack' })).status, 404);
  assert.equal((await b.c.call('DELETE', `/api/orgs/${orgA}/briefs/${made.body.id}`)).status, 404);
  assert.equal((await b.c.call('GET', `/api/orgs/${orgA}/members`)).status, 404);
  // even inside B's own org, A's brief id cannot be touched
  assert.equal((await b.c.call('PATCH', `/api/orgs/${orgB}/briefs/${made.body.id}`, { title: 'hack' })).status, 404);
  assert.equal((await b.c.call('GET', `/api/orgs/${orgB}/briefs`)).body.briefs.length, 0);
});

test('brief validation', async () => {
  const { c, me } = await login('briefs@example.com');
  const org = me.orgs[0].id;
  assert.equal((await c.call('POST', `/api/orgs/${org}/briefs`, { title: '' })).status, 400);
  assert.equal((await c.call('POST', `/api/orgs/${org}/briefs`, { title: 'ok', agent: 'not-an-agent' })).status, 400);
  assert.equal((await c.call('POST', `/api/orgs/${org}/briefs`, { title: 'ok', status: 'weird' })).status, 400);
  assert.equal((await c.call('POST', `/api/orgs/${org}/briefs`, { title: 'ok', assigneeId: '11111111-1111-4111-8111-111111111111' })).status, 400);
  const ok = await c.call('POST', `/api/orgs/${org}/briefs`, { title: 'Q3 plan', agent: 'marketing-strategist', notes: 'n' });
  assert.equal(ok.status, 201);
  const upd = await c.call('PATCH', `/api/orgs/${org}/briefs/${ok.body.id}`, { status: 'doing' });
  assert.equal(upd.body.status, 'doing');
  assert.equal((await c.call('DELETE', `/api/orgs/${org}/briefs/${ok.body.id}`)).status, 200);
});

test('team: invite -> invitee logs in with OTP and lands in the workspace with that role', async () => {
  const owner = await login('boss@example.com');
  const org = owner.me.orgs[0].id;
  const inv = await owner.c.call('POST', `/api/orgs/${org}/invites`, { email: 'Mate@Example.com', role: 'member' });
  assert.equal(inv.status, 201);
  assert.ok(mailer.outbox.some((m) => m.to === 'mate@example.com' && /added you/.test(m.subject)));
  assert.equal((await owner.c.call('POST', `/api/orgs/${org}/invites`, { email: 'mate@example.com', role: 'nope' })).status, 400);
  const mate = await login('mate@example.com');
  const names = mate.me.orgs.map((o) => o.id);
  assert.ok(names.includes(org));
  assert.equal(mate.me.orgs.find((o) => o.id === org).role, 'member');
  const team = await owner.c.call('GET', `/api/orgs/${org}/members`);
  assert.equal(team.body.members.length, 2);
  assert.equal(team.body.invites.length, 0);
  assert.equal((await owner.c.call('POST', `/api/orgs/${org}/invites`, { email: 'mate@example.com', role: 'viewer' })).status, 409);
});

test('roles: viewer is read-only, member cannot manage team, admin limited, owner full', async () => {
  const owner = await login('own@example.com');
  const org = owner.me.orgs[0].id;
  for (const [email, role] of [['v@example.com', 'viewer'], ['m@example.com', 'member'], ['ad@example.com', 'admin']]) {
    assert.equal((await owner.c.call('POST', `/api/orgs/${org}/invites`, { email, role })).status, 201);
  }
  const v = await login('v@example.com'), m = await login('m@example.com'), ad = await login('ad@example.com');
  // viewer
  assert.equal((await v.c.call('GET', `/api/orgs/${org}/briefs`)).status, 200);
  assert.equal((await v.c.call('POST', `/api/orgs/${org}/briefs`, { title: 'x' })).status, 403);
  assert.equal((await v.c.call('GET', `/api/orgs/${org}/audit`)).status, 403);
  // member
  const brief = await m.c.call('POST', `/api/orgs/${org}/briefs`, { title: 'mine' });
  assert.equal(brief.status, 201);
  assert.equal((await m.c.call('POST', `/api/orgs/${org}/invites`, { email: 'z@example.com', role: 'viewer' })).status, 403);
  assert.equal((await m.c.call('PATCH', `/api/orgs/${org}/members/${v.me.user.id}`, { role: 'member' })).status, 403);
  assert.equal((await m.c.call('PATCH', `/api/orgs/${org}`, { name: 'Hijack' })).status, 403);
  // member cannot delete someone else's brief
  const ob = await owner.c.call('POST', `/api/orgs/${org}/briefs`, { title: 'owners' });
  assert.equal((await m.c.call('DELETE', `/api/orgs/${org}/briefs/${ob.body.id}`)).status, 403);
  // admin: can invite viewer, cannot grant admin/owner, cannot touch owner or other admins
  assert.equal((await ad.c.call('POST', `/api/orgs/${org}/invites`, { email: 'n@example.com', role: 'viewer' })).status, 201);
  assert.equal((await ad.c.call('POST', `/api/orgs/${org}/invites`, { email: 'n2@example.com', role: 'admin' })).status, 403);
  assert.equal((await ad.c.call('PATCH', `/api/orgs/${org}/members/${owner.me.user.id}`, { role: 'viewer' })).status, 403);
  assert.equal((await ad.c.call('PATCH', `/api/orgs/${org}/members/${v.me.user.id}`, { role: 'owner' })).status, 403);
  assert.equal((await ad.c.call('PATCH', `/api/orgs/${org}/members/${v.me.user.id}`, { role: 'member' })).status, 200);
  assert.equal((await ad.c.call('DELETE', `/api/orgs/${org}/members/${owner.me.user.id}`)).status, 403);
  assert.equal((await ad.c.call('GET', `/api/orgs/${org}/audit`)).status, 200);
  // owner
  assert.equal((await owner.c.call('PATCH', `/api/orgs/${org}/members/${ad.me.user.id}`, { role: 'owner' })).status, 200);
  assert.equal((await owner.c.call('PATCH', `/api/orgs/${org}`, { name: 'Renamed' })).status, 200);
  // role change takes effect on the next request
  assert.equal((await v.c.call('POST', `/api/orgs/${org}/briefs`, { title: 'now allowed' })).status, 201);
});

test('last owner cannot be demoted, removed, or leave', async () => {
  const o = await login('solo@example.com');
  const org = o.me.orgs[0].id;
  assert.equal((await o.c.call('PATCH', `/api/orgs/${org}/members/${o.me.user.id}`, { role: 'admin' })).status, 409);
  assert.equal((await o.c.call('DELETE', `/api/orgs/${org}/members/${o.me.user.id}`)).status, 409);
});

test('removing a member revokes access immediately; members can leave', async () => {
  const o = await login('rm.owner@example.com');
  const org = o.me.orgs[0].id;
  await o.c.call('POST', `/api/orgs/${org}/invites`, { email: 'rm.member@example.com', role: 'member' });
  await o.c.call('POST', `/api/orgs/${org}/invites`, { email: 'rm.leaver@example.com', role: 'viewer' });
  const m = await login('rm.member@example.com'); const l = await login('rm.leaver@example.com');
  assert.equal((await m.c.call('GET', `/api/orgs/${org}/briefs`)).status, 200);
  assert.equal((await o.c.call('DELETE', `/api/orgs/${org}/members/${m.me.user.id}`)).status, 200);
  assert.equal((await m.c.call('GET', `/api/orgs/${org}/briefs`)).status, 404);
  assert.equal((await l.c.call('DELETE', `/api/orgs/${org}/members/${l.me.user.id}`)).status, 200);
  assert.equal((await l.c.call('GET', `/api/orgs/${org}/briefs`)).status, 404);
});

test('revoking an invite stops the invitee joining', async () => {
  const o = await login('rv.owner@example.com');
  const org = o.me.orgs[0].id;
  const inv = await o.c.call('POST', `/api/orgs/${org}/invites`, { email: 'rv.guest@example.com', role: 'member' });
  assert.equal((await o.c.call('DELETE', `/api/orgs/${org}/invites/${inv.body.id}`)).status, 200);
  const g = await login('rv.guest@example.com');
  assert.ok(!g.me.orgs.some((x) => x.id === org));
});

test('create and switch workspaces; delete is owner-only', async () => {
  const o = await login('multi@example.com');
  const created = await o.c.call('POST', '/api/orgs', { name: 'Client Acme' });
  assert.equal(created.status, 201);
  const me = (await o.c.call('GET', '/api/me')).body;
  assert.equal(me.orgs.length, 2);
  assert.equal(me.activeOrgId, created.body.id);
  assert.equal((await o.c.call('POST', `/api/orgs/${me.orgs[0].id}/switch`)).status, 200);
  assert.equal((await o.c.call('GET', '/api/me')).body.activeOrgId, me.orgs[0].id);
  assert.equal((await o.c.call('POST', '/api/orgs', { name: 'x' })).status, 400);
  assert.equal((await o.c.call('DELETE', `/api/orgs/${created.body.id}`)).status, 200);
  assert.equal((await o.c.call('GET', '/api/me')).body.orgs.length, 1);
});

test('audit log records team actions and is not visible to members', async () => {
  const o = await login('aud@example.com');
  const org = o.me.orgs[0].id;
  await o.c.call('POST', `/api/orgs/${org}/invites`, { email: 'aud2@example.com', role: 'member' });
  const ev = (await o.c.call('GET', `/api/orgs/${org}/audit`)).body.events;
  assert.ok(ev.some((e) => e.action === 'invite.created'));
});

test('SQL-ish and HTML input is stored as data, not executed', async () => {
  const { c, me } = await login('inj@example.com');
  const org = me.orgs[0].id;
  const t = `'); DROP TABLE briefs; -- <img src=x onerror=alert(1)>`;
  const r = await c.call('POST', `/api/orgs/${org}/briefs`, { title: t });
  assert.equal(r.status, 201); assert.equal(r.body.title, t);
  assert.equal((await c.call('GET', `/api/orgs/${org}/briefs`)).status, 200);
  assert.equal((await c.call('GET', '/api/orgs/not-a-uuid/briefs')).status, 404);
});

test('unknown routes: JSON 404 for api, HTML 404 for pages; security headers present', async () => {
  const a = await fetch(base + '/api/nothing'); assert.equal(a.status, 404);
  const p = await fetch(base + '/no-such-page'); assert.equal(p.status, 404);
  assert.match(p.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(p.headers.get('x-powered-by'), null);
});

test('hourly cap per IP', async () => {
  const app2 = createApp({ db, mailer, config: { secret: 'test-secret', otpPerIpHour: 3 } });
  const s2 = app2.listen(0);
  const url = `http://127.0.0.1:${s2.address().port}/api/auth/request`;
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify({ email: `ipcap${i}@example.com` }) });
    codes.push(res.status);
  }
  s2.close(); app2.locals.stop();
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
});

test('a user with no workspace left gets a fresh personal one on next load', async () => {
  const o = await login('lonely@example.com');
  const org = o.me.orgs[0].id;
  assert.equal((await o.c.call('DELETE', `/api/orgs/${org}`)).status, 200);
  const me = (await o.c.call('GET', '/api/me')).body;
  assert.equal(me.orgs.length, 1);
  assert.notEqual(me.orgs[0].id, org);
  assert.equal(me.orgs[0].role, 'owner');
});
