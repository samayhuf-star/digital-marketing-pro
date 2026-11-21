'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const helmet = require('helmet');
const { otpEmail, inviteEmail } = require('./mailer');

const RANK = { viewer: 1, member: 2, admin: 3, owner: 4 };
const ROLES = Object.keys(RANK);
const STATUSES = ['todo', 'doing', 'done'];
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_COOLDOWN_MS = 30 * 1000;
const OTP_PER_EMAIL_HOUR = 6;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const EMAIL_RE = /^[^\s@<>()",;:\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const httpError = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createApp({ db, mailer, config }) {
  const cfg = {
    appName: 'Marketing Crew',
    secret: 'dev-only-secret',
    production: false,
    baseUrl: '',
    otpPerIpHour: 30,
    ...config,
  };
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  const catalogPath = path.join(__dirname, '..', 'public', 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const agentNames = new Set(catalog.agents.map((a) => a.name));

  const hashCode = (email, code) => crypto.createHmac('sha256', cfg.secret).update(`${email}:${code}`).digest('hex');
  const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
    hsts: cfg.production ? undefined : false,
  }));
  app.use(express.json({ limit: '32kb' }));

  // --- CSRF: mutating calls must come from our own pages -------------------
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('x-requested-with') !== 'fetch') return next(httpError(403, 'Blocked request'));
    const origin = req.get('origin');
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === req.get('host'); } catch { /* bad origin */ }
      if (!ok) return next(httpError(403, 'Blocked request'));
    }
    next();
  });

  // --- sessions -------------------------------------------------------------
  const cookieName = 'sid';
  function readCookie(req, name) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  }
  function setSessionCookie(res, token) {
    const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${SESSION_TTL_MS / 1000}`];
    if (cfg.production) flags.push('Secure');
    res.setHeader('Set-Cookie', `${cookieName}=${encodeURIComponent(token)}; ${flags.join('; ')}`);
  }
  function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${cfg.production ? '; Secure' : ''}`);
  }
  async function loadSession(req, res, next) {
    try {
      const token = readCookie(req, cookieName);
      if (!token) return next();
      const rows = await db.query(
        `SELECT s.id AS sid, s.active_org_id, u.id, u.email, u.name
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
      if (rows[0]) req.auth = { sessionId: rows[0].sid, activeOrgId: rows[0].active_org_id, user: { id: rows[0].id, email: rows[0].email, name: rows[0].name } };
      next();
    } catch (e) { next(e); }
  }
  const requireAuth = (req, res, next) => (req.auth ? next() : next(httpError(401, 'Please sign in')));
  app.use('/api', loadSession);

  async function audit(orgId, userId, action, detail = {}) {
    await db.query('INSERT INTO audit (org_id, user_id, action, detail) VALUES ($1,$2,$3,$4)', [orgId, userId, action, JSON.stringify(detail)]);
  }

  async function listOrgs(userId) {
    return db.query(
      `SELECT o.id, o.name, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id
        WHERE m.user_id = $1 ORDER BY o.created_at ASC`, [userId]);
  }

  // Loads the caller's membership for :orgId. Non-members get a 404 so org ids cannot be probed.
  const orgScope = (minRole = 'viewer') => wrap(async (req, res, next) => {
    const orgId = req.params.orgId;
    if (!UUID_RE.test(orgId)) throw httpError(404, 'Not found');
    const rows = await db.query('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, req.auth.user.id]);
    if (!rows[0]) throw httpError(404, 'Not found');
    if (RANK[rows[0].role] < RANK[minRole]) throw httpError(403, 'Your role does not allow this');
    req.orgId = orgId;
    req.role = rows[0].role;
    next();
  });

  // --- auth: request code ---------------------------------------------------
  app.post('/api/auth/request', wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) throw httpError(400, 'Enter a valid email address');
    const ip = req.ip || '';

    const [perEmail] = await db.query(
      `SELECT count(*)::int AS n, max(created_at) AS last FROM otps WHERE email = $1 AND created_at > now() - interval '1 hour'`, [email]);
    const [perIp] = await db.query(
      `SELECT count(*)::int AS n FROM otps WHERE ip = $1 AND created_at > now() - interval '1 hour'`, [ip]);
    if (perEmail.last && Date.now() - new Date(perEmail.last).getTime() < OTP_COOLDOWN_MS) {
      throw httpError(429, 'Please wait a few seconds before asking for another code');
    }
    if (perEmail.n >= OTP_PER_EMAIL_HOUR || perIp.n >= cfg.otpPerIpHour) {
      throw httpError(429, 'Too many codes requested. Try again in an hour');
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await db.query('UPDATE otps SET used = true WHERE email = $1 AND used = false', [email]);
    await db.query('INSERT INTO otps (email, code_hash, ip, expires_at) VALUES ($1,$2,$3,$4)',
      [email, hashCode(email, code), ip, new Date(Date.now() + OTP_TTL_MS)]);
    try {
      await mailer.send({ to: email, ...otpEmail(code, cfg.appName) });
    } catch (e) {
      console.error('[auth] could not send code:', e.message);
      throw httpError(503, 'We could not send the email right now. Please try again shortly');
    }
    res.json({ ok: true, cooldownSeconds: OTP_COOLDOWN_MS / 1000 });
  }));

  // --- auth: verify code (signs in existing users, creates new ones) ----------
  app.post('/api/auth/verify', wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').replace(/\s/g, '');
    if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) throw httpError(400, 'Enter the 6-digit code');

    const rows = await db.query(
      `SELECT id, code_hash, attempts FROM otps
        WHERE email = $1 AND used = false AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [email]);
    const otp = rows[0];
    if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) throw httpError(400, 'That code has expired. Ask for a new one');
    const [{ attempts }] = await db.query('UPDATE otps SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [otp.id]);
    if (!safeEq(otp.code_hash, hashCode(email, code))) {
      const left = OTP_MAX_ATTEMPTS - attempts;
      throw httpError(400, left > 0 ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left` : 'Too many wrong codes. Ask for a new one');
    }
    // single use: only one concurrent verify can flip this
    const used = await db.query('UPDATE otps SET used = true WHERE id = $1 AND used = false RETURNING id', [otp.id]);
    if (!used[0]) throw httpError(400, 'That code was already used');

    let isNew = false;
    let [user] = await db.query('SELECT id, email, name FROM users WHERE email = $1', [email]);
    if (!user) {
      [user] = await db.query('INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id, email, name', [email]);
      isNew = true;
    }
    // any pending invites for this email become memberships
    const invites = await db.query('SELECT id, org_id, role FROM invites WHERE email = $1', [email]);
    for (const inv of invites) {
      await db.query('INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [inv.org_id, user.id, inv.role]);
      await db.query('DELETE FROM invites WHERE id = $1', [inv.id]);
      await audit(inv.org_id, user.id, 'invite.accepted', { email, role: inv.role });
    }
    let orgs = await listOrgs(user.id);
    if (!orgs.length) {
      const base = email.split('@')[0].slice(0, 40);
      const [org] = await db.query('INSERT INTO orgs (name, created_by) VALUES ($1,$2) RETURNING id', [`${base}'s workspace`, user.id]);
      await db.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'owner')", [org.id, user.id]);
      await audit(org.id, user.id, 'workspace.created', { personal: true });
      orgs = await listOrgs(user.id);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    await db.query('INSERT INTO sessions (token_hash, user_id, active_org_id, expires_at) VALUES ($1,$2,$3,$4)',
      [sha256(token), user.id, orgs[0].id, new Date(Date.now() + SESSION_TTL_MS)]);
    setSessionCookie(res, token);
    res.json({ ok: true, isNew, user });
  }));

  app.post('/api/auth/logout', wrap(async (req, res) => {
    const token = readCookie(req, cookieName);
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
    clearSessionCookie(res);
    res.json({ ok: true });
  }));

  // --- me / workspaces --------------------------------------------------------
  app.get('/api/me', requireAuth, wrap(async (req, res) => {
    let orgs = await listOrgs(req.auth.user.id);
    if (!orgs.length) {
      // e.g. the user deleted their last workspace or was removed from the only one they had
      const base = req.auth.user.email.split('@')[0].slice(0, 40);
      const [org] = await db.query('INSERT INTO orgs (name, created_by) VALUES ($1,$2) RETURNING id', [`${base}'s workspace`, req.auth.user.id]);
      await db.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'owner')", [org.id, req.auth.user.id]);
      await db.query('UPDATE sessions SET active_org_id = $1 WHERE id = $2', [org.id, req.auth.sessionId]);
      await audit(org.id, req.auth.user.id, 'workspace.created', { personal: true });
      orgs = await listOrgs(req.auth.user.id);
      req.auth.activeOrgId = org.id;
    }
    const active = orgs.find((o) => o.id === req.auth.activeOrgId) || orgs[0] || null;
    res.json({ user: req.auth.user, orgs, activeOrgId: active ? active.id : null, roles: ROLES });
  }));

  app.patch('/api/me', requireAuth, wrap(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (name.length > 80) throw httpError(400, 'Name is too long');
    await db.query('UPDATE users SET name = $1 WHERE id = $2', [name, req.auth.user.id]);
    res.json({ ok: true, name });
  }));

  app.post('/api/orgs', requireAuth, wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (name.length < 2 || name.length > 60) throw httpError(400, 'Workspace name must be 2 to 60 characters');
    const [{ n }] = await db.query("SELECT count(*)::int AS n FROM memberships WHERE user_id = $1 AND role = 'owner'", [req.auth.user.id]);
    if (n >= 10) throw httpError(400, 'You own the maximum of 10 workspaces');
    const [org] = await db.query('INSERT INTO orgs (name, created_by) VALUES ($1,$2) RETURNING id, name', [name, req.auth.user.id]);
    await db.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'owner')", [org.id, req.auth.user.id]);
    await db.query('UPDATE sessions SET active_org_id = $1 WHERE id = $2', [org.id, req.auth.sessionId]);
    await audit(org.id, req.auth.user.id, 'workspace.created', { name });
    res.status(201).json({ ...org, role: 'owner' });
  }));

  app.post('/api/orgs/:orgId/switch', requireAuth, orgScope('viewer'), wrap(async (req, res) => {
    await db.query('UPDATE sessions SET active_org_id = $1 WHERE id = $2', [req.orgId, req.auth.sessionId]);
    res.json({ ok: true });
  }));

  app.patch('/api/orgs/:orgId', requireAuth, orgScope('admin'), wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (name.length < 2 || name.length > 60) throw httpError(400, 'Workspace name must be 2 to 60 characters');
    await db.query('UPDATE orgs SET name = $1 WHERE id = $2', [name, req.orgId]);
    await audit(req.orgId, req.auth.user.id, 'workspace.renamed', { name });
    res.json({ ok: true, name });
  }));

  app.delete('/api/orgs/:orgId', requireAuth, orgScope('owner'), wrap(async (req, res) => {
    await db.query('DELETE FROM orgs WHERE id = $1', [req.orgId]);
    res.json({ ok: true });
  }));

  // --- team -------------------------------------------------------------------
  app.get('/api/orgs/:orgId/members', requireAuth, orgScope('viewer'), wrap(async (req, res) => {
    const members = await db.query(
      `SELECT u.id, u.email, u.name, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 ORDER BY m.created_at ASC`, [req.orgId]);
    const invites = RANK[req.role] >= RANK.admin
      ? await db.query('SELECT id, email, role, created_at FROM invites WHERE org_id = $1 ORDER BY created_at DESC', [req.orgId])
      : [];
    res.json({ members, invites, you: { id: req.auth.user.id, role: req.role } });
  }));

  async function ownerCount(orgId) {
    const [{ n }] = await db.query("SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'owner'", [orgId]);
    return n;
  }
  // Which roles may the caller hand out, and whose role may they touch?
  const canAssign = (actor, role) => (actor === 'owner' ? ROLES.includes(role) : actor === 'admin' && (role === 'member' || role === 'viewer'));
  const canManage = (actor, targetRole) => (actor === 'owner' ? true : actor === 'admin' && RANK[targetRole] <= RANK.member);

  app.post('/api/orgs/:orgId/invites', requireAuth, orgScope('admin'), wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = String(req.body?.role || 'member');
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address');
    if (!['admin', 'member', 'viewer'].includes(role)) throw httpError(400, 'Choose admin, member or viewer');
    if (!canAssign(req.role, role)) throw httpError(403, 'Your role cannot grant that access');
    const existing = await db.query(
      'SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND u.email = $2', [req.orgId, email]);
    if (existing[0]) throw httpError(409, 'That person is already on the team');
    const [{ n }] = await db.query('SELECT count(*)::int AS n FROM invites WHERE org_id = $1', [req.orgId]);
    if (n >= 100) throw httpError(400, 'Too many pending invites');
    const [inv] = await db.query(
      `INSERT INTO invites (org_id, email, role, invited_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id, email) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by
       RETURNING id, email, role, created_at`, [req.orgId, email, role, req.auth.user.id]);
    const [org] = await db.query('SELECT name FROM orgs WHERE id = $1', [req.orgId]);
    await audit(req.orgId, req.auth.user.id, 'invite.created', { email, role });
    let emailed = true;
    try {
      const base = cfg.baseUrl || `${req.protocol}://${req.get('host')}`;
      await mailer.send({ to: email, ...inviteEmail({ appName: cfg.appName, orgName: org.name, inviter: req.auth.user.name || req.auth.user.email, role, url: `${base}/login` }) });
    } catch (e) {
      emailed = false;
      console.error('[invite] email failed:', e.message);
    }
    res.status(201).json({ ...inv, emailed });
  }));

  app.delete('/api/orgs/:orgId/invites/:inviteId', requireAuth, orgScope('admin'), wrap(async (req, res) => {
    if (!UUID_RE.test(req.params.inviteId)) throw httpError(404, 'Not found');
    const rows = await db.query('DELETE FROM invites WHERE id = $1 AND org_id = $2 RETURNING email', [req.params.inviteId, req.orgId]);
    if (!rows[0]) throw httpError(404, 'Not found');
    await audit(req.orgId, req.auth.user.id, 'invite.revoked', { email: rows[0].email });
    res.json({ ok: true });
  }));

  app.patch('/api/orgs/:orgId/members/:userId', requireAuth, orgScope('admin'), wrap(async (req, res) => {
    const { userId } = req.params;
    const role = String(req.body?.role || '');
    if (!UUID_RE.test(userId)) throw httpError(404, 'Not found');
    if (!ROLES.includes(role)) throw httpError(400, 'Unknown role');
    const [target] = await db.query('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [req.orgId, userId]);
    if (!target) throw httpError(404, 'Not found');
    if (!canManage(req.role, target.role) || !canAssign(req.role, role)) throw httpError(403, 'Your role cannot make this change');
    if (target.role === 'owner' && role !== 'owner' && (await ownerCount(req.orgId)) <= 1) {
      throw httpError(409, 'A workspace needs at least one owner. Make someone else an owner first');
    }
    await db.query('UPDATE memberships SET role = $1 WHERE org_id = $2 AND user_id = $3', [role, req.orgId, userId]);
    await audit(req.orgId, req.auth.user.id, 'member.role_changed', { userId, from: target.role, to: role });
    res.json({ ok: true, role });
  }));

  app.delete('/api/orgs/:orgId/members/:userId', requireAuth, orgScope('viewer'), wrap(async (req, res) => {
    const { userId } = req.params;
    if (!UUID_RE.test(userId)) throw httpError(404, 'Not found');
    const self = userId === req.auth.user.id;
    const [target] = await db.query('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [req.orgId, userId]);
    if (!target) throw httpError(404, 'Not found');
    if (!self && !canManage(req.role, target.role)) throw httpError(403, 'Your role cannot remove this person');
    if (target.role === 'owner' && (await ownerCount(req.orgId)) <= 1) throw httpError(409, 'The last owner cannot leave. Make someone else an owner or delete the workspace');
    await db.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [req.orgId, userId]);
    await db.query('UPDATE briefs SET assignee_id = NULL WHERE org_id = $1 AND assignee_id = $2', [req.orgId, userId]);
    await db.query('UPDATE sessions SET active_org_id = NULL WHERE user_id = $1 AND active_org_id = $2', [userId, req.orgId]);
    await audit(req.orgId, req.auth.user.id, self ? 'member.left' : 'member.removed', { userId });
    res.json({ ok: true });
  }));

  // --- briefs (the per-workspace data) ----------------------------------------
  function cleanBrief(body, partial) {
    const out = {};
    if (!partial || body.title !== undefined) {
      const t = String(body.title || '').trim();
      if (t.length < 1 || t.length > 140) throw httpError(400, 'Title must be 1 to 140 characters');
      out.title = t;
    }
    if (body.agent !== undefined) {
      const a = String(body.agent || '');
      if (a && !agentNames.has(a)) throw httpError(400, 'Unknown agent');
      out.agent = a;
    }
    if (body.notes !== undefined) {
      const n = String(body.notes || '');
      if (n.length > 4000) throw httpError(400, 'Notes are too long');
      out.notes = n;
    }
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) throw httpError(400, 'Unknown status');
      out.status = body.status;
    }
    if (body.assigneeId !== undefined) out.assigneeId = body.assigneeId || null;
    return out;
  }
  async function checkAssignee(orgId, assigneeId) {
    if (!assigneeId) return;
    if (!UUID_RE.test(assigneeId)) throw httpError(400, 'Unknown assignee');
    const r = await db.query('SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, assigneeId]);
    if (!r[0]) throw httpError(400, 'Assignee is not on this team');
  }
  const BRIEF_COLS = 'id, title, agent, notes, status, assignee_id AS "assigneeId", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"';

  app.get('/api/orgs/:orgId/briefs', requireAuth, orgScope('viewer'), wrap(async (req, res) => {
    res.json({ briefs: await db.query(`SELECT ${BRIEF_COLS} FROM briefs WHERE org_id = $1 ORDER BY created_at DESC LIMIT 500`, [req.orgId]) });
  }));

  app.post('/api/orgs/:orgId/briefs', requireAuth, orgScope('member'), wrap(async (req, res) => {
    const b = cleanBrief(req.body || {}, false);
    await checkAssignee(req.orgId, b.assigneeId);
    const [row] = await db.query(
      `INSERT INTO briefs (org_id, title, agent, notes, status, assignee_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${BRIEF_COLS}`,
      [req.orgId, b.title, b.agent || '', b.notes || '', b.status || 'todo', b.assigneeId || null, req.auth.user.id]);
    await audit(req.orgId, req.auth.user.id, 'brief.created', { id: row.id, title: row.title });
    res.status(201).json(row);
  }));

  app.patch('/api/orgs/:orgId/briefs/:id', requireAuth, orgScope('member'), wrap(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) throw httpError(404, 'Not found');
    const b = cleanBrief(req.body || {}, true);
    if (b.assigneeId !== undefined) await checkAssignee(req.orgId, b.assigneeId);
    const sets = []; const vals = [];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.title !== undefined) add('title', b.title);
    if (b.agent !== undefined) add('agent', b.agent);
    if (b.notes !== undefined) add('notes', b.notes);
    if (b.status !== undefined) add('status', b.status);
    if (b.assigneeId !== undefined) add('assignee_id', b.assigneeId);
    if (!sets.length) throw httpError(400, 'Nothing to change');
    sets.push('updated_at = now()');
    vals.push(req.params.id, req.orgId);
    const rows = await db.query(`UPDATE briefs SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND org_id = $${vals.length} RETURNING ${BRIEF_COLS}`, vals);
    if (!rows[0]) throw httpError(404, 'Not found');
    await audit(req.orgId, req.auth.user.id, 'brief.updated', { id: rows[0].id, fields: Object.keys(b) });
    res.json(rows[0]);
  }));

  app.delete('/api/orgs/:orgId/briefs/:id', requireAuth, orgScope('member'), wrap(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) throw httpError(404, 'Not found');
    const [brief] = await db.query('SELECT created_by FROM briefs WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]);
    if (!brief) throw httpError(404, 'Not found');
    if (RANK[req.role] < RANK.admin && brief.created_by !== req.auth.user.id) throw httpError(403, 'Only admins or the author can delete a brief');
    await db.query('DELETE FROM briefs WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]);
    await audit(req.orgId, req.auth.user.id, 'brief.deleted', { id: req.params.id });
    res.json({ ok: true });
  }));

  app.get('/api/orgs/:orgId/audit', requireAuth, orgScope('admin'), wrap(async (req, res) => {
    const rows = await db.query(
      `SELECT a.id, a.action, a.detail, a.created_at AS "createdAt", u.email AS "actor"
         FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.org_id = $1 ORDER BY a.created_at DESC LIMIT 100`, [req.orgId]);
    res.json({ events: rows });
  }));

  // --- public ------------------------------------------------------------------
  app.get('/healthz', wrap(async (req, res) => {
    await db.query('SELECT 1');
    res.json({ ok: true });
  }));

  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, { extensions: ['html'], maxAge: cfg.production ? '1h' : 0, index: 'index.html' }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((req, res) => res.status(404).sendFile(path.join(pub, '404.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') err = httpError(400, 'Invalid request');
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  // housekeeping: purge expired codes and sessions
  const timer = setInterval(() => {
    db.query("DELETE FROM otps WHERE created_at < now() - interval '1 day'").catch(() => {});
    db.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
  }, 3600 * 1000);
  timer.unref();
  app.locals.stop = () => clearInterval(timer);
  return app;
}

module.exports = { createApp, RANK };
