# Marketing Crew web app

Multi-tenant SaaS front end for the `digital-marketing-pro` agent pack (24 agents, 164 skills).

- **Login:** email + 6-digit one-time code only. Unknown emails get an account and a private workspace automatically.
- **Workspaces:** each user can belong to many; every query is scoped to the workspace the caller is a member of (non-members get 404).
- **Roles:** owner, admin, member, viewer. Admins invite members/viewers; owners also grant admin/owner. The last owner cannot leave. Invites turn into memberships the next time that email signs in.
- **Data:** briefs board per workspace, audit log (admin+).
- **Security:** hashed OTPs (HMAC), 10 min expiry, 5 tries, 30 s resend cooldown, per-email and per-IP hourly caps, DB-backed HttpOnly sessions, CSRF header + origin check, CSP.

## Run locally
```
cd web && npm install && npm run dev   # uses an in-process Postgres; login codes print in the console
npm test
```

## Deploy (Docker, repo root `Dockerfile`)
Set the variables in `.env.example`, expose port 3000, health check `/healthz`.
