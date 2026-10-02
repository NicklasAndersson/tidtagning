## Git & deploy workflow
- Integration: push directly to `main` (no PRs, no CI).
- Commits: short Swedish messages, imperative/descriptive, as in `git log`.
- Before committing: run `npx playwright test`.
- Deploy (manual, after the push has succeeded): run any new schema migrations from README "Schemaändringar" with `--remote` first (`npx wrangler d1 execute tidtagning --remote --command "..."`), then `npm run deploy`.
