import unittest
from unittest.mock import MagicMock
import httpx
from scripts.feed.gcd_archive import archive_url, capture_timestamps, fetch_capture, parse_capture
from scripts.feed.roster import parse_gcd, parse_vlr, request_with_retry


class GCDArchiveTests(unittest.TestCase):
    def test_index_sorts_and_deduplicates_by_timestamp(self):
        first, second = '20221114190655', '20240501113418'
        self.assertEqual(capture_timestamps([['timestamp'], [second], [first], [second]]), [first, second])

    def test_historical_league_coverage(self):
        header = '<tr><td>League</td><td>Team</td><td>Player</td><td>Contract End</td></tr>'
        def capture(leagues):
            rows = ''.join(f'<tr><td>{league}</td><td>Team</td><td>{league}-{i}</td><td>2025</td></tr>'
                           for league in leagues for i in range(10))
            return f'<table>{header}{rows}</table>'
        early = capture(['AMERICAS', 'EMEA', 'APAC'])
        self.assertEqual({row['league'] for row in parse_capture('20221114190655', early)},
                         {'AMERICAS', 'EMEA', 'PACIFIC'})
        with self.assertRaisesRegex(ValueError, 'CN'):
            parse_capture('20240501113418', early)
        self.assertEqual(len(parse_capture('20240501113418', capture(['AMERICAS', 'EMEA', 'PACIFIC', 'CN']))), 40)

    def test_skips_verified_sheet_shell_but_refuses_different_capture(self):
        timestamp = '20261005002743'
        def archive_response(request):
            self.assertEqual(str(request.url), archive_url(timestamp, raw=True))
            return httpx.Response(200, headers={'Memento-Datetime': memento},
                                  text='<title>VALORANT Global Contract Database - Google Drive</title>')
        with httpx.Client(transport=httpx.MockTransport(archive_response)) as client:
            memento = 'Mon, 05 Oct 2026 00:27:43 GMT'
            self.assertIn('skipped', fetch_capture(client, timestamp))
            memento = 'Mon, 05 Oct 2026 00:28:43 GMT'
            with self.assertRaisesRegex(RuntimeError, 'exact capture'):
                fetch_capture(client, timestamp)

    def test_archive_recovers_missing_league_header_from_known_sheet_id(self):
        header = '<tr><td>mad</td><td>Team</td><td>Player</td><td>Contract End</td></tr>'
        rows = ''.join(f'<tr><td>AMERICAS</td><td>Team</td><td>p{i}</td><td>2025</td></tr>'
                       for i in range(10))
        table = f'<div id="1856086064"><div><table>{header}{rows}</table></div></div>'
        self.assertEqual({r['league'] for r in parse_gcd(table, use_sheet_league=True)}, {'AMERICAS'})
        self.assertEqual({r['league'] for r in parse_gcd(table.replace('1856086064', 'unknown'), use_sheet_league=True)}, {'VCT'})


class RosterParserTests(unittest.TestCase):
    def test_vlr_row(self):
        html = '<table class="wf-table mod-transfers"><tr><td class="txn-day"><span class="txn-day-num">10/04/2026</span></td><td class="txn-player"><a href="/player/12/test"><div style="font-weight: 700">Test</div></a></td><td class="txn-action"><span class="tag">joined</span></td><td class="txn-team"><a href="/team/34/acme">ACME</a></td></tr></table>'
        self.assertEqual(parse_vlr(html)[0]['moves'][0]['team'], 'ACME')

    def test_gcd_header_after_title(self):
        head = '<tr><td>Global Contract Database</td></tr><tr><td>League</td><td>Team</td><td>Official Tournament Handle</td><td>Role</td><td>End Date (Month Day, Year)</td><td>Roster Status</td></tr>'
        body = ''.join(f'<tr><td>AMERICAS</td><td>T{i}</td><td>P{i}</td><td>PLAYER</td><td>2027</td><td>Active</td></tr>' for i in range(30))
        self.assertEqual(len(parse_gcd(f'<table>{head}{body}</table>')), 30)

    def test_china_active_player_and_season_end(self):
        head = '<tr><td>League</td><td>Team</td><td>Official Tournament Handle</td><td>Role</td><td>End Date (Month Day, Year)</td><td>Roster Status</td></tr>'
        body = ''.join(f'<tr><td>CN</td><td>T{i}</td><td>P{i}</td><td>ACTIVE PLAYER</td><td>2027 Season End</td><td>Active</td></tr>' for i in range(30))
        rows = parse_gcd(f'<table>{head}{body}</table>')
        self.assertEqual(len(rows), 30)
        self.assertEqual(rows[0]['contractEnd'], '2027 Season End')

    def test_offseason_sheet_with_open_slots_is_not_a_markup_failure(self):
        head = '<tr><td>League</td><td>Team</td><td>Official Tournament Handle</td><td>Role</td><td>End Date (Month Day, Year)</td><td>Roster Status</td></tr>'
        players = ''.join(f'<tr><td>AMERICAS</td><td>T{i}</td><td>P{i}</td><td>PLAYER</td><td>2027</td><td>Active</td></tr>' for i in range(27))
        slots = ''.join(f'<tr><td>AMERICAS</td><td>T{i}</td><td></td><td></td><td></td><td></td></tr>' for i in range(13))
        self.assertEqual(len(parse_gcd(f'<table>{head}{players}{slots}</table>')), 27)

    def test_nearly_empty_sheet_is_loud(self):
        head = '<tr><td>League</td><td>Team</td><td>Official Tournament Handle</td><td>Role</td><td>End Date (Month Day, Year)</td><td>Roster Status</td></tr>'
        body = ''.join(f'<tr><td>AMERICAS</td><td>T{i}</td><td>P{i}</td><td>PLAYER</td><td>2027</td><td>Active</td></tr>' for i in range(9))
        with self.assertRaises(ValueError):
            parse_gcd(f'<table>{head}{body}</table>')

    def test_staff_and_reserves_are_sent_without_personal_details(self):
        head = '<tr><td>League</td><td>Team</td><td>Official Tournament Handle</td><td>Role</td><td>Legal First Name</td><td>Legal Family Name</td><td>End Date (Month Day, Year)</td><td>Resident Status</td><td>Roster Status</td><td>Team Tag</td><td>Team Contact Information</td></tr>'
        players = ''.join(f'<tr><td>EMEA</td><td>T{i}</td><td>P{i}</td><td>PLAYER</td><td>First</td><td>Last</td><td>2027</td><td>Resident</td><td>Active</td><td>T{i}</td><td>a@b.c</td></tr>' for i in range(10))
        coach = '<tr><td>EMEA</td><td>T0</td><td>Coachy</td><td>HEAD COACH</td><td>First</td><td>Last</td><td>2027</td><td>/</td><td>Staff</td><td>T0</td><td></td></tr>'
        rows = parse_gcd(f'<table>{head}{players}{coach}</table>')
        self.assertEqual(len(rows), 11)
        self.assertEqual(rows[-1], {'player': 'Coachy', 'team': 'T0', 'league': 'EMEA', 'contractEnd': '2027', 'role': 'HEAD COACH', 'status': 'Staff', 'teamTag': 'T0'})
        self.assertNotIn('a@b.c', repr(rows))
        self.assertNotIn('First', repr(rows))

    def test_markup_failure_is_loud(self):
        with self.assertRaises(ValueError):
            parse_gcd('<table><tr><td>Unknown</td></tr></table>')
        with self.assertRaises(ValueError):
            parse_vlr('<html>no transfers</html>')


class RetryTests(unittest.TestCase):
    def test_success_first_try(self):
        client = MagicMock()
        req = httpx.Request('GET', 'http://example.com')
        resp = httpx.Response(200, request=req, text='ok')
        client.request.return_value = resp
        sleep = MagicMock()
        res = request_with_retry(client, 'GET', 'http://example.com', sleep=sleep)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(client.request.call_count, 1)
        sleep.assert_not_called()

    def test_retries_on_timeout_and_succeeds(self):
        client = MagicMock()
        req = httpx.Request('GET', 'http://example.com')
        resp = httpx.Response(200, request=req, text='ok')
        client.request.side_effect = [httpx.ReadTimeout('timeout', request=req), resp]
        sleep = MagicMock()
        res = request_with_retry(client, 'GET', 'http://example.com', sleep=sleep)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(client.request.call_count, 2)
        sleep.assert_called_once_with(1.0)

    def test_retries_on_server_error_and_succeeds(self):
        client = MagicMock()
        req = httpx.Request('GET', 'http://example.com')
        resp_503 = httpx.Response(503, request=req)
        resp_200 = httpx.Response(200, request=req, text='ok')
        client.request.side_effect = [resp_503, resp_200]
        sleep = MagicMock()
        res = request_with_retry(client, 'GET', 'http://example.com', sleep=sleep)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(client.request.call_count, 2)
        sleep.assert_called_once_with(1.0)

    def test_exceeds_max_retries_raises_request_error(self):
        client = MagicMock()
        req = httpx.Request('GET', 'http://example.com')
        client.request.side_effect = httpx.ReadTimeout('timed out', request=req)
        sleep = MagicMock()
        with self.assertRaises(httpx.ReadTimeout):
            request_with_retry(client, 'GET', 'http://example.com', attempts=3, sleep=sleep)
        self.assertEqual(client.request.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    def test_client_error_does_not_retry(self):
        client = MagicMock()
        req = httpx.Request('GET', 'http://example.com')
        resp_404 = httpx.Response(404, request=req)
        client.request.return_value = resp_404
        sleep = MagicMock()
        with self.assertRaises(httpx.HTTPStatusError):
            request_with_retry(client, 'GET', 'http://example.com', attempts=3, sleep=sleep)
        self.assertEqual(client.request.call_count, 1)
        sleep.assert_not_called()

if __name__ == '__main__':
    unittest.main()
