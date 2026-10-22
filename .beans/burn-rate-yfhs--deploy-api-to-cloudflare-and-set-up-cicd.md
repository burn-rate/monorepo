---
# burn-rate-yfhs
title: Deploy API to Cloudflare and set up CI/CD
status: in-progress
type: feature
tags:
    - deploy
    - cicd
created_at: 2026-10-22T15:52:16Z
updated_at: 2026-10-22T15:52:16Z
---

## Goal
Get the API deployed to Cloudflare Workers (real HTTPS URL for the /hook test endpoint) and set up the CI/CD flow in GitHub Actions.

## Plan
1. Authenticate wrangler with Cloudflare (wrangler login or API token)
2. Create real D1 database, replace placeholder database_id in apps/api/wrangler.jsonc
3. Apply D1 migrations (apps/api/migrations) remotely
4. Deploy worker, verify /hook over HTTPS
5. Add GitHub Actions workflows: CI (install, turbo check + build) on PRs; CD (D1 migrations + wrangler deploy) on push to main
6. Set CLOUDFLARE_API_TOKEN as GitHub repo secret
7. Commit changes, push to main, watch the pipeline run green

## Findings / notes
- Repo: github.com/burn-rate/monorepo (main), gh CLI authenticated (workflow scope OK)
- wrangler 4.151.3, not authenticated yet
- wrangler.jsonc D1 database_id is a placeholder (00000000-...)
- Turbo tasks available: check, build; root scripts: pnpm check / pnpm build
- No existing .github/workflows
