'use strict';
const { createDb } = require('./db');
const { createApp } = require('./app');
const { createResendMailer, createConsoleMailer } = require('./mailer');

async function main() {
  const production = process.env.NODE_ENV === 'production';
  const secret = process.env.SESSION_SECRET || '';
  if (production && secret.length < 32) throw new Error('SESSION_SECRET must be set to a random string of 32+ characters in production.');
  if (production && !process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in production.');

  let mailer;
  if (process.env.RESEND_API_KEY) {
    if (!process.env.MAIL_FROM) throw new Error('MAIL_FROM is required when RESEND_API_KEY is set (e.g. "Marketing Crew <login@yourdomain.com>").');
    mailer = createResendMailer({ apiKey: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM });
  } else if (production) {
    throw new Error('RESEND_API_KEY and MAIL_FROM are required in production so login codes can be emailed.');
  } else {
    console.log('[mail] RESEND_API_KEY not set: login codes will be printed in this console (dev only).');
    mailer = createConsoleMailer();
  }

  const db = await createDb({ url: process.env.DATABASE_URL, dataDir: process.env.DEV_DATA_DIR });
  const app = createApp({
    db, mailer,
    config: {
      appName: process.env.APP_NAME || 'Marketing Crew',
      secret: secret || 'dev-only-secret-change-me',
      production,
      baseUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
    },
  });
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, '0.0.0.0', () => console.log(`Listening on :${port} (${db.kind})`));
  const shutdown = () => { server.close(() => db.close().finally(() => process.exit(0))); setTimeout(() => process.exit(1), 8000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
