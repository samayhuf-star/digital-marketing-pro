(async function () {
  const { esc, ICONS, bindCopy, catalog } = window.MC;
  const D = await catalog();
  document.getElementById('nAgents').textContent = D.agents.length;
  document.getElementById('nSkills').textContent = D.skills.length;
  document.getElementById('agentGrid').innerHTML = D.agents.map((a) =>
    `<div class="agent"><div class="ic">${ICONS[a.name] || '🤖'}</div><h3>${esc(a.name.replace(/-/g, ' '))}</h3><p>${esc(a.description)}</p><code>agents/${esc(a.name)}.md</code></div>`).join('');
  const cats = [...new Set(D.skills.map((s) => s.cat))];
  const count = (c) => D.skills.filter((s) => s.cat === c).length;
  cats.sort((a, b) => count(b) - count(a));
  const mx = Math.max(...cats.map(count));
  document.getElementById('bars').innerHTML = cats.map((c) => `<div class="bar"><span>${esc(c)}</span><div><i style="width:${(count(c) / mx) * 100}%"></i></div><em>${count(c)}</em></div>`).join('');
  let cur = 'All';
  const chips = document.getElementById('chips');
  chips.innerHTML = ['All', ...cats].map((c) => `<button class="chip${c === 'All' ? ' on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
  chips.onclick = (e) => { const c = e.target.dataset.c; if (!c) return; cur = c; [...chips.children].forEach((x) => x.classList.toggle('on', x.dataset.c === c)); render(); };
  document.getElementById('q').oninput = render;
  function render() {
    const q = document.getElementById('q').value.toLowerCase();
    const r = D.skills.filter((s) => (cur === 'All' || s.cat === cur) && (s.name + ' ' + s.description).toLowerCase().includes(q));
    document.getElementById('skillGrid').innerHTML = r.map((s) => `<div class="skill"><b>${esc(s.name)}</b><p>${esc(s.description)}</p></div>`).join('');
    document.getElementById('count').textContent = `Showing ${r.length} of ${D.skills.length} skills`;
  }
  render();
  bindCopy();
})();
