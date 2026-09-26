# HomeworkTrack Pro v5 — Teacher Login

This version removes the Cloudflare Access requirement and uses an application-level teacher login backed by D1.

## First launch

1. Deploy the project through Cloudflare Workers Builds.
2. Open the Worker URL.
3. On the first visit, create the first administrator account.
4. Sign in with that account.

Passwords are stored as PBKDF2-SHA-256 derived hashes with unique salts. Sessions use HttpOnly, Secure cookies and expire after 7 days.

## Important

This is suitable for testing/development. For a real school deployment with pupil data, use the school's approved identity provider/SSO and complete safeguarding, UK GDPR, retention, access-control and security review before production use.
