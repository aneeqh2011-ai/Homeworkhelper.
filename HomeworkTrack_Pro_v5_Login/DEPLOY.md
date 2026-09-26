# Deploy HomeworkTrack Pro v5

This version does not require Cloudflare Access for the application login.

## GitHub / Workers Builds

- Keep `package.json` and `wrangler.jsonc` at the repository root.
- Deploy command: `npx wrangler deploy`
- Root directory: `/`
- Build command can be left empty.

## D1

The project expects the existing `homeworktrack` D1 database to be bound as `DB`.

If the database is new, apply `schema.sql` once using the Cloudflare D1 dashboard's query/console or your normal migration workflow.

## First login

Open the deployed Worker URL. The first visitor will see **First-time setup** and can create the first administrator account. After that, normal visitors see the teacher sign-in screen.

For a real school deployment, use approved school authentication and complete the school's safeguarding, UK GDPR/data-protection, retention and security review before entering real pupil data.
