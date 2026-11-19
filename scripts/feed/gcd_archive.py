"""Collect Wayback captures of the Riot GCD, then replay them into roster history."""
import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from tempfile import NamedTemporaryFile

import httpx

from scripts.feed.roster import GCD, GCD_MIN_ROWS, GCD_SHEETS, HTMLParser, parse_gcd, request_with_retry

WAYBACK = 'https://web.archive.org'
FIRST_CAPTURE = '20221101000000'
TIMESTAMP_FORMAT = '%Y%m%d%H%M%S'
ARCHIVE_INTERVAL = 5.0


def archive_url(timestamp, raw=False):
    return f'{WAYBACK}/web/{timestamp}{"id_" if raw else ""}/{GCD}'


def capture_timestamps(index):
    if not isinstance(index, list) or not index or index[0] != ['timestamp']:
        raise ValueError('unexpected Wayback index format')
    timestamps = set()
    for row in index[1:]:
        if not isinstance(row, list) or len(row) != 1 or not isinstance(row[0], str):
            raise ValueError('unexpected Wayback index row')
        timestamp = row[0]
        if not re.fullmatch(r'[0-9]{14}', timestamp) or timestamp < FIRST_CAPTURE:
            raise ValueError('invalid Wayback index timestamp')
        datetime.strptime(timestamp, TIMESTAMP_FORMAT)
        timestamps.add(timestamp)
    if not timestamps:
        raise ValueError('no Wayback captures found for the GCD sheet')
    return sorted(timestamps)


def cache_json(path, value):
    # Publish each cache file atomically so an interrupted download can be retried.
    with NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as temp:
        tmp_path = Path(temp.name)
        try:
            json.dump(value, temp, ensure_ascii=False)
            temp.close()
            tmp_path.replace(path)
        finally:
            tmp_path.unlink(missing_ok=True)


def load_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def parse_capture(timestamp, html):
    rows = parse_gcd(html, use_sheet_league=True)
    for row in rows:
        league = row['league'].upper()
        row['league'] = 'PACIFIC' if league == 'APAC' else league
    counts = Counter(row['league'] for row in rows)
    expected = set(GCD_SHEETS)
    if timestamp < '20240101000000':
        expected.remove('CN')
    incomplete = sorted(league for league in expected | counts.keys() if counts[league] < GCD_MIN_ROWS)
    unexpected = sorted(counts.keys() - GCD_SHEETS.keys())
    if incomplete or unexpected:
        raise ValueError(f'incomplete leagues {incomplete}; unexpected leagues {unexpected}')
    return rows


def fetch_capture(client, timestamp):
    response = request_with_retry(client, 'GET', archive_url(timestamp, raw=True), delay=15)
    memento = response.headers.get('Memento-Datetime')
    if not memento or parsedate_to_datetime(memento).astimezone(timezone.utc).strftime(TIMESTAMP_FORMAT) != timestamp:
        raise RuntimeError(f'Wayback could not verify the exact capture timestamp for {timestamp}')
    html = response.text
    try:
        return {'contracts': parse_capture(timestamp, html)}
    except ValueError as error:
        title = HTMLParser(html).css_first('title')
        if not title or 'global contract database' not in title.text().lower():
            raise RuntimeError(f'Wayback returned an unexpected page for {timestamp}') from error
        return {'skipped': str(error)}


def collect(client, cache_dir):
    index_path = cache_dir / 'index.json'
    if index_path.exists():
        timestamps = capture_timestamps(load_json(index_path))
    else:
        response = request_with_retry(client, 'GET', f'{WAYBACK}/cdx/search/cdx', delay=15, params={
            'url': GCD, 'from': FIRST_CAPTURE, 'output': 'json', 'fl': 'timestamp', 'filter': 'statuscode:200',
        })
        index = response.json()
        timestamps = capture_timestamps(index)
        cache_json(index_path, index)

    accepted = []
    for timestamp in timestamps:
        path = cache_dir / f'{timestamp}.json'
        if path.exists():
            capture = load_json(path)
        else:
            capture = fetch_capture(client, timestamp)
            cache_json(path, capture)
        if 'skipped' in capture:
            print(f'Skipped {archive_url(timestamp)} ({capture["skipped"]})', flush=True)
        else:
            accepted.append((timestamp, capture['contracts']))
            print(f'Ready {archive_url(timestamp)} ({len(capture["contracts"])} rows)', flush=True)
    if not accepted:
        raise RuntimeError('no complete GCD captures found')
    print(f'{len(accepted)} complete captures, {len(timestamps) - len(accepted)} skipped', flush=True)
    return accepted


def replay(client, base, token, captures):
    for timestamp, contracts in captures:
        response = request_with_retry(client, 'POST', f'{base}/internal/ingest', delay=5,
                                      headers={'Authorization': f'Bearer {token}'}, json={
            'schemaVersion': 1, 'kind': 'contracts-archive', 'runId': f'wayback-{timestamp}',
            'captureTimestamp': timestamp, 'contracts': contracts,
        })
        result = response.json()
        if result.get('duplicate') is not True and not result.get('rows'):
            raise RuntimeError(f'unexpected ingest response for {timestamp}')
        print(f'{timestamp} {result}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', required=True, type=Path)
    parser.add_argument('--apply', action='store_true', help='send the collected captures to the Worker')
    args = parser.parse_args()
    base = os.environ.get('FEED_BASE_URL', '').rstrip('/')
    token = os.environ.get('FEED_INGEST_TOKEN')
    if args.apply and (not base or not token):
        parser.error('--apply requires FEED_BASE_URL and FEED_INGEST_TOKEN')

    next_request = 0

    def pace(_request):
        nonlocal next_request
        time.sleep(max(0, next_request - time.monotonic()))
        next_request = time.monotonic() + ARCHIVE_INTERVAL

    args.cache_dir.mkdir(parents=True, exist_ok=True)
    timeout = httpx.Timeout(90, connect=15)
    with httpx.Client(timeout=timeout, event_hooks={'request': [pace]},
                      headers={'User-Agent': 'OpVAL GCD history backfill (public data)'}) as archive:
        captures = collect(archive, args.cache_dir)
    if args.apply:
        with httpx.Client(timeout=timeout) as worker:
            replay(worker, base, token, captures)


if __name__ == '__main__':
    try:
        main()
    except httpx.HTTPStatusError as error:
        print(f'{error.request.method} {error.request.url}: HTTP {error.response.status_code}', file=sys.stderr)
        if error.request.method == 'POST':
            print(error.response.text, file=sys.stderr)
        sys.exit(1)
    except (httpx.RequestError, OSError, RuntimeError, ValueError) as error:
        sys.exit(str(error))
