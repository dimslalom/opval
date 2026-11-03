"""Poll the public VLR transfer log and Riot's published contract sheet.
Fail closed on markup changes: no empty payload is sent as an official snapshot.
"""
import os
import re
from datetime import datetime
from urllib.parse import urljoin

import httpx
from selectolax.parser import HTMLParser

VLR = 'https://www.vlr.gg/transfers'
GCD = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRmmWiBmMMD43m5VtZq54nKlmj0ZtythsA1qCpegwx-iRptx2HEsG0T3cQlG1r2AIiKxBWnaurJZQ9Q/pubhtml'
GCD_SHEETS = {'AMERICAS': 1856086064, 'CN': 1474170664, 'EMEA': 0, 'PACIFIC': 1819901194}
# Rosters shrink for real in the off-season (Americas hit 27 in Nov 2026), while a markup or
# label change drops nearly every row. This floor only has to tell those two apart.
GCD_MIN_ROWS = 10
BASE = os.environ.get('FEED_BASE_URL', 'http://127.0.0.1:8787')
TOKEN = os.environ.get('FEED_INGEST_TOKEN', 'local-dev')


def clean(s):
    return ' '.join((s or '').split())


def parse_vlr(html):
    tree = HTMLParser(html)
    out = {}
    for row in tree.css('table.wf-table.mod-transfers tr'):
        player = row.css_first('td.txn-player a[href^="/player/"]')
        day_node = row.css_first('td.txn-day .txn-day-num')
        action = row.css_first('td.txn-action .tag')
        teams = row.css('td.txn-team a[href^="/team/"]')
        if not player or not day_node or not action or not teams:
            continue
        href = player.attributes.get('href', '')
        match = re.match(r'/player/(\d+)', href)
        date = re.fullmatch(r'(\d{1,2})/(\d{1,2})/(\d{4})', clean(day_node.text()))
        movement = clean(action.text()).lower()
        if not match or not date or movement not in ('joined', 'left'):
            continue
        day = f'{int(date[3]):04d}-{int(date[1]):02d}-{int(date[2]):02d}'
        try:
            datetime.strptime(day, '%Y-%m-%d')
        except ValueError:
            continue
        handle_node = player.css_first('div[style*="font-weight: 700"]')
        handle = clean(handle_node.text() if handle_node else player.text())
        team_names = [clean(a.text()) for a in teams]
        country_node = row.css_first('td.txn-country i.flag')
        country = next((c[4:] for c in (country_node.attributes.get('class', '').split() if country_node else []) if c.startswith('mod-')), None)
        record = {'day': day, 'vlrId': int(match[1]), 'handle': handle, 'country': country,
                  'moves': [{'type': movement, 'team': team_names[0],
                             'from': team_names[1] if len(team_names) > 1 else None}],
                  'sourceUrl': urljoin('https://www.vlr.gg', href)}
        out[(day, record['vlrId'], movement, team_names[0])] = record
    if not out:
        raise ValueError('VLR transfer markup changed: no rows parsed')
    return list(out.values())


def parse_gcd(html):
    tree = HTMLParser(html)
    rows = []
    for table in tree.css('table'):
        tr = table.css('tr')
        if not tr:
            continue
        for header_index, header_row in enumerate(tr[:12]):
            headers = [clean(x.text()).lower() for x in header_row.css('td')]
            def col(*names):
                return next((i for i, h in enumerate(headers) if any(n in h for n in names)), None)
            player = col('official tournament handle', 'player', 'ign', 'in game name', 'in-game name')
            team = col('team', 'organization')
            end = col('contract end', 'end date', 'end year', 'expiration', 'expiry')
            league = col('league', 'region')
            role = col('role')
            status = col('roster status')
            if player is None or team is None or end is None:
                continue
            for item in tr[header_index + 1:]:
                cells = [clean(x.text()) for x in item.css('td')]
                if len(cells) <= max(player, team, end):
                    continue
                if not cells[player] or not cells[team]:
                    continue
                if role is not None and (role >= len(cells) or cells[role].upper() not in ('PLAYER', 'ACTIVE PLAYER')):
                    continue
                if status is not None and status < len(cells) and cells[status].lower() != 'active':
                    continue
                rows.append({'player': cells[player], 'team': cells[team],
                             'league': cells[league] if league is not None and league < len(cells) else 'VCT',
                             'contractEnd': cells[end] or None})
            break
    if len(rows) < GCD_MIN_ROWS:
        raise ValueError(f'GCD markup changed or incomplete: only {len(rows)} rows parsed')
    return rows


def post(kind, values, run_id):
    with httpx.Client(timeout=90) as client:
        response = client.post(f'{BASE}/internal/ingest', headers={'Authorization': f'Bearer {TOKEN}'},
                               json={'schemaVersion': 1, 'kind': kind, 'runId': run_id,
                                     'source': {'name': 'riot-gcd' if kind == 'contracts' else 'vlr.gg'}, kind: values})
        response.raise_for_status()
        print(kind, response.json())


def main():
    run_id = os.environ.get('GITHUB_RUN_ID', f'local-{int(datetime.now().timestamp())}')
    failures = []
    with httpx.Client(timeout=30, follow_redirects=True, headers={'User-Agent': 'OpVAL roster monitor (public data)'}) as client:
        try:
            transfers = parse_vlr(client.get(VLR).raise_for_status().text)
            post('transfers', transfers, run_id)
        except Exception as error:
            failures.append(f'transfers: {error}')
        try:
            contracts = []
            for region, gid in GCD_SHEETS.items():
                sheet = f'{GCD}/sheet?headers=false&gid={gid}'
                found = parse_gcd(client.get(sheet).raise_for_status().text)
                if not found or any(row['league'].upper() != region for row in found):
                    raise ValueError(f'{region} sheet identity or rows changed')
                contracts.extend(found)
            post('contracts', contracts, run_id)
        except Exception as error:
            failures.append(f'contracts: {error}')
    if failures:
        raise RuntimeError('; '.join(failures))


if __name__ == '__main__':
    main()
