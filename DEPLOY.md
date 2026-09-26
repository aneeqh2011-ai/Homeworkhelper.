# HomeworkTrack Pro v4

Cloudflare Workers + D1 + Workers AI.

1. Install Node.js LTS.
2. Extract the ZIP.
3. Open Command Prompt/Terminal in this folder.
4. `npm install`
5. `npx wrangler login`
6. `npx wrangler d1 create homeworktrack`
7. Put the returned database ID into `wrangler.jsonc`.
8. `npx wrangler d1 execute homeworktrack --remote --file=./schema.sql`
9. `npx wrangler deploy`
10. Put the deployed site behind Cloudflare Access for authorised school staff.
11. Add an authorised teacher to the `teachers` table matching their Access email.

Example:
INSERT INTO teachers(email,display_name,role) VALUES('teacher@school.example','First Teacher','admin');

The AI endpoint is server-side and uses the Workers AI binding. Sparx/Seneca are connector placeholders: use only official school-authorised integrations, not scraping or pupil passwords.

Do not use real pupil data until school safeguarding, UK GDPR/data protection, retention, access-control and notification requirements have been approved.