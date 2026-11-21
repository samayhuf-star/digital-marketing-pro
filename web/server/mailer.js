'use strict';
// Sends transactional email through Resend's HTTP API.
// In tests an in-memory outbox replaces this module's output.

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function createResendMailer({ apiKey, from }) {
  return {
    async send({ to, subject, text, html }) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Resend responded ${res.status}: ${body.slice(0, 200)}`);
      }
    },
  };
}

function createConsoleMailer() {
  return {
    async send({ to, subject, text }) {
      console.log(`\n[mail:dev] to=${to} subject="${subject}"\n${text}\n`);
    },
  };
}

function createOutboxMailer() {
  const outbox = [];
  return { outbox, async send(m) { outbox.push(m); } };
}

function otpEmail(code, appName) {
  const subject = `${code} is your ${appName} sign-in code`;
  const text = `Your ${appName} sign-in code is ${code}.\n\nIt expires in 10 minutes. If you did not ask for it, you can ignore this email.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;background:#07080a;color:#f4f2ec;border-radius:14px">
<p style="color:#8a8f99;margin:0 0 8px">${esc(appName)}</p>
<p style="margin:0 0 16px">Your sign-in code</p>
<p style="font-size:34px;letter-spacing:8px;font-weight:700;color:#c6ff3d;margin:0 0 16px">${esc(code)}</p>
<p style="color:#8a8f99;font-size:13px;margin:0">Expires in 10 minutes. If you did not ask for it, ignore this email.</p></div>`;
  return { subject, text, html };
}

function inviteEmail({ appName, orgName, inviter, role, url }) {
  const subject = `${inviter} added you to ${orgName} on ${appName}`;
  const text = `${inviter} gave you ${role} access to the "${orgName}" workspace on ${appName}.\n\nSign in with this email address to join: ${url}\n`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:460px;margin:auto;padding:24px;background:#07080a;color:#f4f2ec;border-radius:14px">
<p style="margin:0 0 12px">${esc(inviter)} gave you <b>${esc(role)}</b> access to <b>${esc(orgName)}</b> on ${esc(appName)}.</p>
<p style="margin:16px 0"><a href="${esc(url)}" style="background:#c6ff3d;color:#0a0c06;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700">Sign in to join</a></p>
<p style="color:#8a8f99;font-size:13px;margin:0">Use this email address to sign in. No password needed.</p></div>`;
  return { subject, text, html };
}

module.exports = { createResendMailer, createConsoleMailer, createOutboxMailer, otpEmail, inviteEmail };
