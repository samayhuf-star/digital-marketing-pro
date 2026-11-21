(function () {
  const { esc, api, toast, ICONS, bindCopy, catalog } = window.MC;
  const $ = (s, r) => (r || document).querySelector(s);
  const RANK = { viewer: 1, member: 2, admin: 3, owner: 4 };
  const ROLE_HELP = {
    owner: 'Everything, including deleting the workspace and making other owners.',
    admin: 'Invite people, manage members and viewers, rename the workspace, see the activity log.',
    member: 'Create and edit briefs, assign work.',
    viewer: 'Read-only access to briefs and the team.',
  };
  const S = { me: null, org: null, role: null, cat: null, members: null, briefs: null };
  const can = (min) => RANK[S.role] >= RANK[min];
  const fmt = (d) => new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const label = (u) => esc(u.name || u.email);

  async function boot() {
    try { S.cat = await catalog(); await loadMe(); }
    catch (e) { if (e.status === 401) return location.replace('/login'); toast(e.message, true); return; }
    $('#logout').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch (e) { /* ignore */ } location.replace('/login'); };
    $('#wsel').onchange = async (e) => {
      if (e.target.value === '__new') { e.target.value = S.org.id; return newWorkspace(); }
      await api('POST', `/api/orgs/${e.target.value}/switch`); await loadMe(); S.members = S.briefs = null; route();
    };
    window.addEventListener('hashchange', route);
    route();
  }
  async function loadMe() {
    S.me = await api('GET', '/api/me');
    S.org = S.me.orgs.find((o) => o.id === S.me.activeOrgId) || S.me.orgs[0];
    S.role = S.org.role;
    $('#wsel').innerHTML = S.me.orgs.map((o) => `<option value="${esc(o.id)}"${o.id === S.org.id ? ' selected' : ''}>${esc(o.name)}</option>`).join('') + '<option value="__new">+ New workspace…</option>';
    $('#meEmail').textContent = S.me.user.name || S.me.user.email;
    const t = $('#meRole'); t.textContent = S.role; t.className = 'tag ' + S.role;
  }
  async function loadBriefs() { S.briefs = (await api('GET', `/api/orgs/${S.org.id}/briefs`)).briefs; }
  async function loadTeam() { S.members = await api('GET', `/api/orgs/${S.org.id}/members`); }

  const views = { overview, briefs, catalog: catalogView, team, settings };
  async function route() {
    const r = (location.hash.replace('#/', '') || 'overview').split('?')[0];
    const name = views[r] ? r : 'overview';
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.r === name));
    $('#view').innerHTML = '<p class="mut">Loading…</p>';
    try { await views[name](); } catch (e) {
      if (e.status === 401) return location.replace('/login');
      if (e.status === 404) { await loadMe(); return route(); }
      $('#view').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  // ---------- modal helper ----------
  function modal(title, bodyHtml, { okText = 'Save', onOk, danger } = {}) {
    const scrim = document.createElement('div'); scrim.className = 'scrim';
    scrim.innerHTML = `<form class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h2>${esc(title)}</h2>${bodyHtml}<div class="err" data-err role="alert"></div><div class="foot"><button type="button" class="btn" data-x>Cancel</button>${onOk ? `<button class="btn ${danger ? 'danger' : 'pri'}" type="submit">${esc(okText)}</button>` : ''}</div></form>`;
    document.body.appendChild(scrim);
    const form = scrim.firstChild; const close = () => scrim.remove();
    scrim.onmousedown = (e) => { if (e.target === scrim) close(); };
    form.querySelector('[data-x]').onclick = close;
    document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
    form.onsubmit = async (e) => {
      e.preventDefault(); if (!onOk) return;
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      try { await onOk(form, close); } catch (err) { form.querySelector('[data-err]').textContent = err.message; btn.disabled = false; }
    };
    const first = form.querySelector('input,select,textarea'); if (first) first.focus();
    return form;
  }
  async function newWorkspace() {
    modal('New workspace', '<div class="fld"><label class="f">Workspace name</label><input class="in" name="name" maxlength="60" placeholder="Acme Marketing" required></div>', {
      okText: 'Create', onOk: async (f, close) => { await api('POST', '/api/orgs', { name: f.name.value }); close(); await loadMe(); S.members = S.briefs = null; location.hash = '#/overview'; route(); toast('Workspace created'); },
    });
  }

  // ---------- overview ----------
  async function overview() {
    await loadBriefs(); await loadTeam();
    const b = S.briefs; const n = (s) => b.filter((x) => x.status === s).length;
    const byAgent = {}; b.forEach((x) => { const k = x.agent || 'unassigned'; byAgent[k] = (byAgent[k] || 0) + 1; });
    const rows = Object.entries(byAgent).sort((a, c) => c[1] - a[1]).slice(0, 6);
    const mx = Math.max(1, ...rows.map((r) => r[1]));
    $('#view').innerHTML = `
      <div class="hd"><div><h1>${esc(S.org.name)}</h1><p>Your shared marketing workspace. You are ${esc(S.role)}.</p></div>${can('member') ? '<button class="btn pri" id="nb">New brief</button>' : ''}</div>
      <div class="kpis">
        <div class="card kpi"><b>${n('todo')}</b><span>To do</span></div>
        <div class="card kpi"><b>${n('doing')}</b><span>In progress</span></div>
        <div class="card kpi"><b>${n('done')}</b><span>Done</span></div>
        <div class="card kpi"><b>${S.members.members.length}</b><span>Team members</span></div>
      </div>
      <div class="two" style="margin-bottom:18px">
        <div class="card"><h3 style="margin-bottom:14px;font-size:16px">Briefs by agent</h3>${rows.length ? `<div class="bars">${rows.map(([k, v]) => `<div class="bar"><span>${esc(k.replace(/-/g, ' '))}</span><div><i style="width:${(v / mx) * 100}%"></i></div><em>${v}</em></div>`).join('')}</div>` : '<div class="empty">No briefs yet. Create the first one.</div>'}</div>
        <div class="card"><h3 style="margin-bottom:6px;font-size:16px">Run the crew in your AI app</h3><p class="mut" style="font-size:14px">The workspace tracks briefs. Agents run inside Claude Code, Codex, Cursor and more.</p>
<pre><button class="btn sm copy" data-copy="/plugin marketplace add indranilbanerjee/neels-plugins&#10;/plugin install digital-marketing-pro">Copy</button>/plugin marketplace add indranilbanerjee/neels-plugins
/plugin install digital-marketing-pro</pre></div>
      </div>
      <div class="card"><h3 style="margin-bottom:10px;font-size:16px">Recent briefs</h3>${b.length ? `<div class="log">${b.slice(0, 6).map((x) => `<div><span>${esc(x.title)} <span class="tag">${esc(x.status)}</span></span><span>${esc(x.agent || '')}</span></div>`).join('')}</div>` : '<div class="empty">Nothing here yet.</div>'}</div>`;
    bindCopy($('#view'));
    const nb = $('#nb'); if (nb) nb.onclick = () => briefModal();
  }

  // ---------- briefs ----------
  async function briefs() {
    await Promise.all([loadBriefs(), loadTeam()]);
    const cols = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']];
    $('#view').innerHTML = `<div class="hd"><div><h1>Briefs</h1><p>What the crew should work on. ${can('member') ? 'Click a card to edit it.' : 'You have read-only access.'}</p></div>${can('member') ? '<button class="btn pri" id="nb">New brief</button>' : ''}</div>
      <div class="cols3">${cols.map(([k, t]) => { const items = S.briefs.filter((x) => x.status === k); return `<div class="col"><h3><span>${t}</span><span>${items.length}</span></h3><div class="stack">${items.length ? items.map(card).join('') : '<div class="empty" style="padding:16px">Empty</div>'}</div></div>`; }).join('')}</div>`;
    const nb = $('#nb'); if (nb) nb.onclick = () => briefModal();
    document.querySelectorAll('.bcard').forEach((el) => (el.onclick = () => briefModal(S.briefs.find((x) => x.id === el.dataset.id))));
  }
  function card(x) {
    const who = S.members.members.find((m) => m.id === x.assigneeId);
    return `<div class="bcard" data-id="${esc(x.id)}" tabindex="0"><b>${esc(x.title)}</b><div class="meta">${x.agent ? `<span class="mono">${ICONS[x.agent] || ''} ${esc(x.agent)}</span>` : ''}${who ? `<span>→ ${label(who)}</span>` : ''}</div></div>`;
  }
  function briefModal(b, prefill) {
    const edit = !!b; b = b || prefill || {};
    const ro = !can('member');
    const agents = ['<option value="">No agent yet</option>'].concat(S.cat.agents.map((a) => `<option value="${esc(a.name)}"${a.name === b.agent ? ' selected' : ''}>${esc(a.name)}</option>`)).join('');
    const people = ['<option value="">Unassigned</option>'].concat((S.members ? S.members.members : []).map((m) => `<option value="${esc(m.id)}"${m.id === b.assigneeId ? ' selected' : ''}>${label(m)}</option>`)).join('');
    const stat = ['todo', 'doing', 'done'].map((s) => `<option value="${s}"${s === (b.status || 'todo') ? ' selected' : ''}>${{ todo: 'To do', doing: 'In progress', done: 'Done' }[s]}</option>`).join('');
    const dis = ro ? 'disabled' : '';
    const f = modal(edit ? 'Brief' : 'New brief',
      `<div class="fld"><label class="f">Title</label><input class="in" name="title" maxlength="140" value="${esc(b.title || '')}" required ${dis}></div>
       <div class="row fld"><div><label class="f">Agent</label><select class="in" name="agent" ${dis}>${agents}</select></div><div><label class="f">Status</label><select class="in" name="status" ${dis}>${stat}</select></div></div>
       <div class="fld"><label class="f">Assignee</label><select class="in" name="assignee" ${dis}>${people}</select></div>
       <div class="fld"><label class="f">Notes</label><textarea class="in" name="notes" maxlength="4000" ${dis}>${esc(b.notes || '')}</textarea></div>
       ${edit && (can('admin') || b.createdBy === S.me.user.id) ? '<button type="button" class="btn sm danger" data-del>Delete brief</button>' : ''}`,
      ro ? {} : { okText: edit ? 'Save' : 'Create brief', onOk: async (form, close) => {
        const body = { title: form.title.value, agent: form.agent.value, status: form.status.value, assigneeId: form.assignee.value || null, notes: form.notes.value };
        if (edit) await api('PATCH', `/api/orgs/${S.org.id}/briefs/${b.id}`, body); else await api('POST', `/api/orgs/${S.org.id}/briefs`, body);
        close(); toast(edit ? 'Brief saved' : 'Brief created'); route();
      } });
    const del = f.querySelector('[data-del]');
    if (del) del.onclick = async () => { if (!confirm('Delete this brief?')) return; try { await api('DELETE', `/api/orgs/${S.org.id}/briefs/${b.id}`); f.closest('.scrim').remove(); toast('Brief deleted'); route(); } catch (e) { f.querySelector('[data-err]').textContent = e.message; } };
  }

  // ---------- catalog ----------
  function catalogView() {
    let tab = 'agents', q = '', cat = 'All';
    const cats = ['All', ...new Set(S.cat.skills.map((s) => s.cat))];
    $('#view').innerHTML = `<div class="hd"><div><h1>Agents &amp; skills</h1><p>${S.cat.agents.length} agents and ${S.cat.skills.length} skills in the crew.${can('member') ? ' Use "Create brief" to queue work.' : ''}</p></div></div>
      <div class="chips" id="tabs"><button class="chip on" data-t="agents">Agents</button><button class="chip" data-t="skills">Skills</button></div>
      <input class="in" id="cq" placeholder="Search" style="margin-bottom:14px"><div class="chips" id="cc" hidden></div><div id="cl"></div>`;
    const draw = () => {
      $('#cc').hidden = tab !== 'skills';
      $('#cc').innerHTML = cats.map((c) => `<button class="chip${c === cat ? ' on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
      const btn = (k, n) => (can('member') ? `<div class="acts"><button class="btn sm" data-brief="${k}:${esc(n)}">Create brief</button></div>` : '');
      if (tab === 'agents') {
        const r = S.cat.agents.filter((a) => (a.name + a.description).toLowerCase().includes(q));
        $('#cl').innerHTML = `<div class="grid">${r.map((a) => `<div class="agent"><div class="ic">${ICONS[a.name] || '🤖'}</div><h3>${esc(a.name.replace(/-/g, ' '))}</h3><p>${esc(a.description)}</p>${btn('a', a.name)}</div>`).join('')}</div>`;
      } else {
        const r = S.cat.skills.filter((s) => (cat === 'All' || s.cat === cat) && (s.name + s.description).toLowerCase().includes(q));
        $('#cl').innerHTML = `<div class="skills">${r.map((s) => `<div class="skill"><b>${esc(s.name)}</b><p>${esc(s.description)}</p>${btn('s', s.name)}</div>`).join('')}</div><p class="mut" style="font-size:13px;margin-top:12px">${r.length} skills</p>`;
      }
      document.querySelectorAll('[data-brief]').forEach((el) => (el.onclick = async () => {
        const [k, n] = el.dataset.brief.split(':'); if (!S.members) await loadTeam();
        briefModal(null, k === 'a' ? { title: `Brief for ${n}`, agent: n } : { title: `Run skill: ${n}`, notes: `Skill: ${n}` });
      }));
    };
    $('#tabs').onclick = (e) => { if (!e.target.dataset.t) return; tab = e.target.dataset.t; [...$('#tabs').children].forEach((x) => x.classList.toggle('on', x.dataset.t === tab)); draw(); };
    $('#cq').oninput = (e) => { q = e.target.value.toLowerCase(); draw(); };
    $('#cc').onclick = (e) => { if (e.target.dataset.c) { cat = e.target.dataset.c; draw(); } };
    draw();
  }

  // ---------- team ----------
  async function team() {
    await loadTeam();
    const T = S.members; const me = T.you;
    const owners = T.members.filter((m) => m.role === 'owner').length;
    const assignable = me.role === 'owner' ? ['owner', 'admin', 'member', 'viewer'] : me.role === 'admin' ? ['member', 'viewer'] : [];
    const manageable = (m) => me.role === 'owner' || (me.role === 'admin' && RANK[m.role] <= RANK.member);
    const inviteRoles = me.role === 'owner' ? ['admin', 'member', 'viewer'] : ['member', 'viewer'];
    $('#view').innerHTML = `<div class="hd"><div><h1>Team &amp; roles</h1><p>Everyone here shares this workspace. Roles control what each person can do.</p></div></div>
      <div class="stackgap">
      ${can('admin') ? `<div class="card"><h3 style="margin-bottom:12px;font-size:16px">Invite someone</h3><form id="inv" class="row"><div style="flex:2"><label class="f">Email</label><input class="in" name="email" type="email" placeholder="teammate@company.com" required></div><div><label class="f">Role</label><select class="in" name="role">${inviteRoles.map((r) => `<option value="${r}"${r === 'member' ? ' selected' : ''}>${r}</option>`).join('')}</select></div><button class="btn pri" type="submit">Send invite</button></form><div class="err" id="ie"></div><p class="mut" style="font-size:13px">They sign in with this email and a one-time code. No account setup needed.</p></div>` : ''}
      <div class="card"><h3 style="margin-bottom:12px;font-size:16px">Members (${T.members.length})</h3><table class="tbl"><thead><tr><th>Person</th><th>Role</th><th></th></tr></thead><tbody>
      ${T.members.map((m) => {
        const self = m.id === me.id; const canEdit = manageable(m) && !(self && me.role !== 'owner');
        const roleCell = canEdit ? `<select class="in" data-role="${esc(m.id)}">${assignable.map((r) => `<option value="${r}"${r === m.role ? ' selected' : ''}>${r}</option>`).join('')}</select>` : `<span class="tag ${m.role}">${m.role}</span>`;
        const canRemove = (manageable(m) && !self) || self;
        const lastOwner = m.role === 'owner' && owners <= 1;
        return `<tr><td>${esc(m.name || m.email)}${m.name ? `<div class="mut" style="font-size:12.5px">${esc(m.email)}</div>` : ''}${self ? ' <span class="mut">(you)</span>' : ''}</td><td>${roleCell}</td><td style="text-align:right">${canRemove && !lastOwner ? `<button class="btn sm danger" data-rm="${esc(m.id)}">${self ? 'Leave' : 'Remove'}</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div>
      ${can('admin') && T.invites.length ? `<div class="card"><h3 style="margin-bottom:12px;font-size:16px">Pending invites</h3><table class="tbl"><tbody>${T.invites.map((i) => `<tr><td>${esc(i.email)}</td><td><span class="tag ${i.role}">${i.role}</span></td><td style="text-align:right"><button class="btn sm danger" data-rv="${esc(i.id)}">Revoke</button></td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="card"><h3 style="margin-bottom:12px;font-size:16px">What each role can do</h3><table class="tbl"><tbody>${['owner', 'admin', 'member', 'viewer'].map((r) => `<tr><td style="width:110px"><span class="tag ${r}">${r}</span></td><td class="mut">${ROLE_HELP[r]}</td></tr>`).join('')}</tbody></table></div>
      <div id="auditBox"></div></div>`;
    const inv = $('#inv');
    if (inv) inv.onsubmit = async (e) => { e.preventDefault(); $('#ie').textContent = ''; try { const r = await api('POST', `/api/orgs/${S.org.id}/invites`, { email: inv.email.value, role: inv.role.value }); toast(r.emailed ? 'Invite sent' : 'Invite saved. The email could not be sent, ask them to sign in', !r.emailed); team(); } catch (err) { $('#ie').textContent = err.message; } };
    document.querySelectorAll('[data-role]').forEach((s) => (s.onchange = async () => { try { await api('PATCH', `/api/orgs/${S.org.id}/members/${s.dataset.role}`, { role: s.value }); toast('Role updated'); if (s.dataset.role === me.id) { await loadMe(); } team(); } catch (err) { toast(err.message, true); team(); } }));
    document.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
      const self = b.dataset.rm === me.id;
      if (!confirm(self ? 'Leave this workspace?' : 'Remove this person from the workspace?')) return;
      try { await api('DELETE', `/api/orgs/${S.org.id}/members/${b.dataset.rm}`); toast(self ? 'You left the workspace' : 'Member removed'); if (self) { await loadMe(); location.hash = '#/overview'; } route(); } catch (err) { toast(err.message, true); }
    }));
    document.querySelectorAll('[data-rv]').forEach((b) => (b.onclick = async () => { try { await api('DELETE', `/api/orgs/${S.org.id}/invites/${b.dataset.rv}`); toast('Invite revoked'); team(); } catch (err) { toast(err.message, true); } }));
    if (can('admin')) {
      const ev = (await api('GET', `/api/orgs/${S.org.id}/audit`)).events;
      $('#auditBox').innerHTML = `<div class="card"><h3 style="margin-bottom:10px;font-size:16px">Activity log</h3><div class="log">${ev.length ? ev.slice(0, 25).map((e) => `<div><span>${esc(e.actor || 'someone')} · ${esc(e.action.replace('.', ' '))}</span><span>${fmt(e.createdAt)}</span></div>`).join('') : '<span class="mut">No activity yet.</span>'}</div></div>`;
    }
  }

  // ---------- settings ----------
  async function settings() {
    $('#view').innerHTML = `<div class="hd"><div><h1>Settings</h1><p>Your profile and this workspace.</p></div></div><div class="stackgap">
      <div class="card"><h3 style="margin-bottom:12px;font-size:16px">Your profile</h3><form id="pf" class="row"><div style="flex:2"><label class="f">Display name</label><input class="in" name="name" maxlength="80" value="${esc(S.me.user.name)}" placeholder="Your name"></div><button class="btn pri" type="submit">Save</button></form><p class="mut" style="font-size:13px;margin-top:8px">Signed in as ${esc(S.me.user.email)}</p></div>
      <div class="card"><h3 style="margin-bottom:12px;font-size:16px">Workspace</h3>${can('admin') ? `<form id="wf" class="row"><div style="flex:2"><label class="f">Workspace name</label><input class="in" name="name" maxlength="60" value="${esc(S.org.name)}" required></div><button class="btn pri" type="submit">Rename</button></form>` : `<p class="mut">Only admins can rename the workspace.</p>`}
        <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap"><button class="btn" id="nw">New workspace</button>${can('owner') ? '<button class="btn danger" id="dw">Delete this workspace</button>' : ''}</div></div></div>`;
    $('#pf').onsubmit = async (e) => { e.preventDefault(); try { await api('PATCH', '/api/me', { name: e.target.name.value }); await loadMe(); toast('Profile saved'); } catch (err) { toast(err.message, true); } };
    const wf = $('#wf'); if (wf) wf.onsubmit = async (e) => { e.preventDefault(); try { await api('PATCH', `/api/orgs/${S.org.id}`, { name: wf.name.value }); await loadMe(); toast('Workspace renamed'); } catch (err) { toast(err.message, true); } };
    $('#nw').onclick = newWorkspace;
    const dw = $('#dw');
    if (dw) dw.onclick = () => modal('Delete workspace', `<p class="mut" style="margin-bottom:12px">This permanently deletes <b>${esc(S.org.name)}</b>, its briefs and its team. Type the workspace name to confirm.</p><input class="in" name="c" autocomplete="off">`, {
      okText: 'Delete forever', danger: true,
      onOk: async (f, close) => { if (f.c.value !== S.org.name) throw new Error('The name does not match'); await api('DELETE', `/api/orgs/${S.org.id}`); close(); await loadMe(); S.members = S.briefs = null; location.hash = '#/overview'; route(); toast('Workspace deleted'); },
    });
  }

  boot();
})();
