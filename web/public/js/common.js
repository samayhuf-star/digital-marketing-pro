(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) { const err = new Error((data && data.error) || 'Something went wrong'); err.status = res.status; throw err; }
    return data;
  }
  function toast(msg, bad) {
    const t = document.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : '');
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }
  const ICONS = { 'agency-operations': '🏢', 'analytics-analyst': '📊', 'brand-guardian': '🛡️', 'competitive-intel': '🔭', 'content-creator': '✍️', 'crm-manager': '🤝', 'cro-specialist': '🎯', 'email-specialist': '✉️', 'execution-coordinator': '🚦', 'growth-engineer': '🚀', 'influencer-manager': '🌟', 'intelligence-curator': '🧠', 'journey-orchestrator': '🧭', 'localization-specialist': '🌍', 'market-intelligence': '📈', 'marketing-scientist': '🧪', 'marketing-strategist': '♟️', 'media-buyer': '💸', 'memory-manager': '🗂️', 'performance-monitor-agent': '📡', 'pr-outreach': '📣', 'quality-assurance': '✅', 'seo-specialist': '🔎', 'social-media-manager': '📱' };
  function bindCopy(root) {
    (root || document).querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = () => {
        if (navigator.clipboard) navigator.clipboard.writeText(b.dataset.copy.replace(/&#10;/g, '\n'));
        const old = b.textContent; b.textContent = 'Copied'; setTimeout(() => (b.textContent = old), 1400);
      };
    });
  }
  let catalogP;
  const catalog = () => (catalogP = catalogP || fetch('/catalog.json').then((r) => r.json()));
  window.MC = { esc, api, toast, ICONS, bindCopy, catalog };
})();
