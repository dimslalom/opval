# Riot GCD archive backfill

The importer reads Wayback's index for Riot's published Global Contract Database sheet and downloads one capture at a time, with at least five seconds between archive requests. It checks the exact UTC capture timestamp, skips verified sheets with empty or incomplete roster tables, and caches parsed roster fields. The cache contains no HTML, legal names, residency, or contact information. The early APAC label maps to PACIFIC. Captures from 2024 onward require CN alongside the original three leagues.

## Collect and review

From the repository root, use `uv` to run the importer with Python 3.13 and the feed's parser dependencies:

```sh
uv run --python 3.13 --with httpx==0.28.1 --with selectolax==0.4.8 \
  python -m scripts.feed.gcd_archive --cache-dir /tmp/opval-gcd-archive
```

The command prints the URL and row count or skip reason for each capture. Keep the cache directory until replay completes. If Wayback throttles or the connection fails, rerun with the same directory to resume. To recheck a skipped capture before replay, delete that timestamp's JSON file from the cache.

## Replay and verify

Apply migrations through 0015 and start the Worker before replay. Use `npm run call:api` for a local run. For a production rollout, pause live GCD posts until replay finishes so that the first live snapshot follows the archive. Replay needs a Riot GCD history that is empty or contains an earlier prefix from this backfill. A newer successful read causes the Worker to reject earlier unpublished captures.

Set `FEED_BASE_URL` and `FEED_INGEST_TOKEN` as for the existing feed, then run:

```sh
uv run --python 3.13 --with httpx==0.28.1 --with selectolax==0.4.8 \
  python -m scripts.feed.gcd_archive --cache-dir /tmp/opval-gcd-archive --apply
```

The same command resumes after an interrupted replay. Previously published captures return as duplicates. Archive replay only updates the roster evidence tables. Weekly game tables still use the live feed.

Check `/api/roster/v2/sources/riot-gcd/archive` for capture times, row counts, and evidence links. To fetch an older page, pass the returned `nextAt` as `?at=<nextAt>`. Check `/api/roster/v2/teams` for the earliest tracked date and latest successful read. Once replay finishes, resume live posts. Gaps between accepted observations remain gaps, so join and departure windows can span months.

## Fill the gap from the weekly game's snapshots

The live feed has stored GCD reads for the weekly game since 5 October 2026 (`roster_snapshots`, `roster_snapshot_rows`, `roster_source_checks`). `worker/roster/legacy.js` replays every check after the evidence model's latest read. The game kept active players only, with no tags, roles, or coaches, so each replayed read covers players only. It doesn't confirm or close coaches and staff, and teams are matched by name within their league. Each unbroken run of identical checks becomes two reads, its first and its last. Every check day still gets a timeline tick.

Run the replay before deploying the roster Worker, so no live read lands first. Live reads newer than the snapshots would make the Worker reject them as stale. Replay into a local copy of production, then push only the changed rows:

1. Copy production's roster tables and the three snapshot tables into the local D1, using paged reads rather than `wrangler d1 export`, which blocks the database while it runs. Then keep a copy of that file.
2. `node scripts/dev/replay-legacy-gcd.mjs`
3. Diff the copy against the replayed file. Write `INSERT OR REPLACE` rows by rowid, parents first, and run that file against production with `wrangler d1 execute --remote --file`.

On the free plan, each D1 query is billed for every row it reads (5 million a day). Check `wrangler d1 insights` after a large replay.
