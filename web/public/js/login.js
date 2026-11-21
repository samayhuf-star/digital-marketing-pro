(function () {
  const { api } = window.MC;
  const $ = (id) => document.getElementById(id);
  let email = '', timer = null;
  api('GET', '/api/me').then(() => { location.replace('/app'); }).catch(() => {});

  const otp = $('otp');
  for (let i = 0; i < 6; i++) {
    const inp = document.createElement('input');
    inp.inputMode = 'numeric'; inp.maxLength = 1; inp.autocomplete = i === 0 ? 'one-time-code' : 'off';
    inp.setAttribute('aria-label', 'Digit ' + (i + 1));
    otp.appendChild(inp);
  }
  const boxes = [...otp.children];
  const code = () => boxes.map((b) => b.value).join('');
  boxes.forEach((b, i) => {
    b.addEventListener('input', () => {
      b.value = b.value.replace(/\D/g, '').slice(-1);
      if (b.value && i < 5) boxes[i + 1].focus();
      if (code().length === 6) $('f2').requestSubmit();
    });
    b.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !b.value && i > 0) boxes[i - 1].focus(); });
    b.addEventListener('paste', (e) => {
      const d = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      if (!d) return; e.preventDefault();
      d.split('').forEach((ch, k) => (boxes[k].value = ch));
      boxes[Math.min(d.length, 5)].focus();
      if (d.length === 6) $('f2').requestSubmit();
    });
  });

  function cooldown(s) {
    clearInterval(timer);
    const r = $('resend'); r.disabled = true;
    const tick = () => { r.textContent = s > 0 ? `Resend code in ${s}s` : 'Resend code'; if (s <= 0) { r.disabled = false; clearInterval(timer); } s--; };
    tick(); timer = setInterval(tick, 1000);
  }
  async function send() {
    const r = await api('POST', '/api/auth/request', { email });
    cooldown(r.cooldownSeconds || 30);
  }

  $('f1').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('e1').textContent = '';
    email = $('email').value.trim().toLowerCase();
    $('b1').disabled = true; $('b1').textContent = 'Sending…';
    try {
      await send();
      $('shown').textContent = email;
      $('f1').hidden = true; $('f2').hidden = false;
      boxes.forEach((b) => (b.value = '')); boxes[0].focus();
    } catch (err) { $('e1').textContent = err.message; }
    $('b1').disabled = false; $('b1').textContent = 'Email me a code';
  });

  $('f2').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (code().length !== 6) { $('e2').textContent = 'Enter all 6 digits'; return; }
    $('e2').textContent = '';
    $('b2').disabled = true; $('b2').textContent = 'Checking…';
    try {
      await api('POST', '/api/auth/verify', { email, code: code() });
      location.replace('/app');
    } catch (err) {
      $('e2').textContent = err.message;
      boxes.forEach((b) => (b.value = '')); boxes[0].focus();
      $('b2').disabled = false; $('b2').textContent = 'Verify and continue';
    }
  });
  $('back').onclick = () => { $('f2').hidden = true; $('f1').hidden = false; $('e2').textContent = ''; clearInterval(timer); $('email').focus(); };
  $('resend').onclick = async () => {
    $('e2').textContent = '';
    try { await send(); window.MC.toast('New code sent'); } catch (err) { $('e2').textContent = err.message; }
  };
})();
