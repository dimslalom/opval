import unittest
from scripts.feed.roster import parse_gcd, parse_vlr

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

    def test_markup_failure_is_loud(self):
        with self.assertRaises(ValueError):
            parse_gcd('<table><tr><td>Unknown</td></tr></table>')
        with self.assertRaises(ValueError):
            parse_vlr('<html>no transfers</html>')

if __name__ == '__main__':
    unittest.main()
