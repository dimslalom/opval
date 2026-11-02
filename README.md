# OpVAL

The call game at [opval.dimas.works](https://opval.dimas.works). This repo also owns the match feed and the D1 database.

- `apps/call/`: the app and its Worker
- `worker/feed/`, `scripts/feed/`, `tools/vlrggapi/`, `.github/workflows/feed.yml`: the vlr.gg feed. It polls every 30 minutes and posts to `/internal/ingest`
- `migrations/`: the D1 schema, shared with [VFL](https://github.com/dimslalom/vfl), which uses `daily_scores`
- `shared/`: the [cards-val](https://github.com/dimslalom/cards-val) submodule with cards, art and card UI. `public/assets` is a symlink into it

## Setup

```bash
git clone --recurse-submodules https://github.com/dimslalom/opval.git
npm ci
npm run call:dev
npm run call:api
```

Edit shared code in cards-val, not in `shared/`. To pick up new cards:

```bash
git submodule update --remote shared
```

## Worker secrets

Set with `npx wrangler secret put <NAME> --config apps/call/wrangler.jsonc`:

- `FEED_INGEST_TOKEN`: must match the GitHub Actions secret of the same name
- `GITHUB_DISPATCH_TOKEN`: lets the Cloudflare cron start `feed.yml` on time
