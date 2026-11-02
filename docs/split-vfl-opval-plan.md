# Plan: split VFL and OpVAL into two GitHub projects

Status: split prepared locally on 2026-11-02, nothing pushed. `cards-val/` and `vfl/` sit in this folder, excluded through `.git/info/exclude`. Follow [split-push-guide.md](split-push-guide.md) to publish. Final file counts differ slightly from the plan below: 29 shared code and data files, because the scan had missed `src/styles/{tokens,team-logos}.css`.

## What the two products are today

| | VFL (Gauntlet / Perfect Run / Multiplayer) | OpVAL (the "call" game) |
|---|---|---|
| Code | `src/` app, `worker/index.js` (+ `Lobby` Durable Object) | `apps/call/` (app, `worker/`, `scripts/`) |
| Site | `vctfantasy.dimas.works`, Worker `vct-lock-in` | `opval.dimas.works`, Worker `opval` |
| Deploy | `deploy.yml` | `deploy-call.yml` |
| D1 tables it uses | `daily_scores` (its app never reads the feed; its Worker only hosts ingest and the `/api/feed/*` routes) | accounts, sessions, saves, wallets, bingo, weekly bingo, settlements, transfer bets, feed + roster reads |
| Tests | multiplayer, endless*, perfectRun*, fantasy*, rive, squadSheet... | opval*, bingo*, weeklyBingo, transferBets, cardCurl |

The reachability scan (imports followed from each app's entry points) found **no code in `src/` that only OpVAL uses except 4 files in `src/engine/collect`, 4 in `src/engine/shared`, and `teams.json`**, and **32 files that both apps use**:

- Card UI and motion: `PlayerCard`, `PlayerPortrait`, `PackTear`, `Split`, `CountryFlag`, `SpecialtyIcon`, `lib/{anime,cardPhysics,gameAudio,motion,motionFeatures,portrait,useCardTilt,useReducedMotion,useRunSpeed,utils}`, `index.css`
- Data: `data/cards.json`, `data/kits.json`, `data/{specialties,statFields}.js`
- Engine bits: `engine/perfectRun.js`, `engine/endless/career.js`
- Feed Worker code: `worker/feed/{auth,roster,routes,store,validate}.js`. Only imported by `worker/index.js` on the VFL side, for routing, so it stays in `opval` and the shared count drops to 27 files.

Three more things are shared without being imported:

1. **The card pipeline**: `scripts/vlr-to-json.js`, `build_portraits.py`, `process_avatars.py`, `vlr-players.config.js`, and `public/assets` (153 MB: players 75, heads 53, kits 17).
2. **The feed pipeline**: `scripts/feed/`, `tools/vlrggapi/`, `feed.yml`, `feed-ci.yml`. The poller **POSTs to `vctfantasy.dimas.works/internal/ingest`**, and OpVAL's cron dispatches `feed.yml` by repo name.
3. **One D1 database** (`vfl-daily-scores`) and one `migrations/` folder, applied by both deploy workflows.

## Recommendation

**OpVAL keeps this repo's history and the data/feed/D1 ownership. VFL moves out into a new repo.**

Why this direction: OpVAL is the product being worked on (every recent commit), it already owns most of the D1 schema (migrations 0003-0013), and it already depends on the feed. VFL is the smaller, older piece. Moving VFL out means fewer owners to relocate (cards + feed + DB stay put) and the GitHub secrets and `production` environment already set up for this repo stay valid.

Then rename this repo to `opval` (GitHub redirects the old URL) so the names match what is in it.

**Decided 2026-11-02:** VFL stays in active development, keeps `vctfantasy.dimas.works`, and all repos are public. Active development on both rules out copying the shared code, so there are three repos: `opval`, `vfl` and a shared `cards-val`. `worker/feed` stays in `opval`.

### Target layout

**`cards-val` (new repo, a git submodule at `shared/` in the other two)** gets: the 27 shared files (card UI and motion with their 4 CSS modules, `data/`, engine bits), `public/assets`, the card pipeline scripts and `src/data/heads.json`, which only the pipeline uses. A trial `git filter-repo` on 2026-11-02 worked (23 commits, 173 MB), and the 27 files import nothing outside themselves.

**`opval` (this repo, renamed)** keeps: `apps/call/` (promote to the root later; optional), the OpVAL-only `src/engine/{collect,shared}` files and `teams.json`, `worker/feed`, `scripts/feed`, `tools/vlrggapi`, `migrations/`, `feed*.yml`, `deploy-call.yml`. Removes: Gauntlet pages, `worker/index.js` Lobby, `deploy.yml`, VFL-only tests.

**`vfl` (new repo)** gets: the VFL-only `src/`, `worker/index.js`, `wrangler.jsonc`, `vite.config.js`, `index.html`, `deploy.yml`, VFL-only tests, `DESIGN.md`, `VCT_GAME_KNOWLEDGE_BASE.md`, README.

## The hard parts, and the decision for each

| # | Problem | Recommended answer | Cost |
|---|---|---|---|
| 1 | **Shared card code (27 files)** | Move it to `cards-val`, added as a **git submodule** at `shared/` in both apps. Imports become relative paths into `shared/`, which also work in Node tests and Worker bundles. Dependencies stay in each app's `package.json` and resolve upward from `shared/`. No npm package: a git dependency would pull 153 MB of art into `node_modules`. | A shared change needs a commit in `cards-val`, then each app must update its submodule to get it. Dependabot's `gitsubmodule` updates can open those PRs daily. CI checkouts need `submodules: true`. |
| 2 | **Card art, 153 MB** | Lives in `cards-val/public/assets`. Each app keeps its own `public/` (icons, manifest, `legal.html`) with `public/assets` as a symlink to `../shared/public/assets`. Vite 8 copies the symlinked files into the build (tested); dev serving is untested. | Repo size ~150 MB, once on GitHub. |
| 3 | **Feed ingest URL** | Poller posts to **OpVAL** (`opval.dimas.works/internal/ingest`). OpVAL's Worker currently routes only `/api/feed/*`; add `/internal/ingest` there. `feed.yml` `FEED_BASE_URL` changes, and the `/api/feed` dev proxy in `apps/call/vite.config.js` moves to `opval.dimas.works`. **Do this before moving VFL**, or the feed stops. | Small code change in `apps/call/worker/index.js`. |
| 4 | **D1 database** | Keep one DB. OpVAL owns the schema and migrations; VFL binds the same DB (`daily_scores` only) and its deploy **no longer runs migrations**. | VFL silently depends on tables OpVAL can change. Pin that with a note in VFL's README. |
| 5 | **Feed workflow dispatch** | OpVAL's cron dispatches `.../repos/dimslalom/2605-Valorant-Fantasy-League/actions/workflows/feed.yml`. If the repo is renamed, update `FEED_WORKFLOW` in `apps/call/worker/index.js`. | One constant. |
| 6 | **Secrets** | The new `vfl` repo needs `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and a `production` environment. The `opval` repo keeps `FEED_INGEST_TOKEN`; VFL does not need it. | You add 2 secrets in GitHub; I cannot. |
| 7 | **Git history for VFL** | `git filter-repo` the VFL paths into the new repo so blame/history survive. | Needs `git-filter-repo` installed. |
| 8 | **`package.json`** | Two copies, each with only the dependencies its app imports (OpVAL does not need `three`, Rive etc. if the scan confirms it). | Trim after the move, not before. |

## Order of work (each step leaves both sites working)

1. **Repoint the feed to OpVAL.** Add `/internal/ingest` to the OpVAL Worker, deploy, set the `FEED_INGEST_TOKEN` Worker secret on `opval` to the same value GitHub holds (it has none today, so ingest would return 401), then change both `FEED_BASE_URL` lines in `feed.yml`, confirm a green poll. (Do not touch VFL yet.)
2. **Create `cards-val`** from a `git filter-repo` of the shared paths. Add it to this repo as the `shared/` submodule, repoint imports, symlink `public/assets`, delete the originals, add `submodules: true` to every workflow that builds, and add `shared` to `deploy-call.yml`'s paths. Both sites still deploy from this repo, so a green deploy of each proves the move.
3. **Create the `vfl` repo** from a `git filter-repo` of the VFL paths, add the submodule, set secrets, deploy to `vctfantasy.dimas.works` from the new repo. Both repos now deploy to the same Worker name for a moment: disable `deploy.yml` in this repo **first**.
4. **Strip VFL out of this repo**: remove Gauntlet pages, the Lobby DO and `deploy.yml`, trim `package.json`, drop VFL-only tests.
5. **Close the old feed path**: in `vfl`, remove the `handleFeed` import and its `/api/feed/*` and `/internal/*` routing from `worker/index.js`, then delete the `FEED_INGEST_TOKEN` secret from `vct-lock-in`. VFL's filter-repo must leave `worker/feed` out, so this has to land with step 3.
6. **Rename this repo to `opval`**, update `FEED_WORKFLOW`, README and `.claude/CLAUDE.md`. The push guide does the rename first, so the constant is right from the first push.
7. Run `graphify update .` in all three.
8. **Reorganise the laptop folder, last and outside a Claude session.** `2605 Valorant Fantasy League/` becomes a plain folder holding `opval/` (this repo, moved down one level), `vfl/` and `cards-val/`. Claude Code keys memory by path, so copy `~/.claude/projects/-Users-dimas-Documents-001-PROJECTS-2605-Valorant-Fantasy-League/memory` to the new project's folder.

## Risks to watch

- Step 3 is the only one that can take a live site down (two repos deploying one Worker). Disable the old workflow before the first deploy of the new one.
- `vct-lock-in` has a Durable Object migration tag (`v1`, `Lobby`). The new repo must carry the same `migrations` block in `wrangler.jsonc` or the deploy will try to recreate the class.
- The failing 'Feed poll' emails were network blips (ECONNRESET/ETIMEDOUT to `vctfantasy.dimas.works`); moving ingest to `opval.dimas.works` changes nothing about that. The retry fix in `scripts/feed/run.js` already shipped (7dd7057).

## Public repo check (2026-11-02)

This repo is already public. A pattern scan of all 83 commits (excluding `public/assets` and `src/data/*.json`) found no live keys or tokens, only the `local-dev` placeholder in `.dev.vars.example`. No repo has a `LICENSE`, so the code is all rights reserved by default. The vendored `tools/vlrggapi` has no license file either; check upstream's terms and carry its notice over.
