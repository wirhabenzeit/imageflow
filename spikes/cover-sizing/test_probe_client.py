"""Offline regression checks for HTTP recovery and explicit paper handling."""
import io
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.parse
from blurb_probe import Client
from whitewall_rules import RULES, spine_width_mm


def form(token):
    return io.BytesIO(f'<input name="authenticity_token" value="{token}">'.encode())


def specification(token='rotated'):
    return io.BytesIO((f'<input name="authenticity_token" value="{token}">'
                       'Your Book Specifications 28 pages Page Specifications '
                       'Cover Specifications Gutter / Spine (w x h) 33 x 918 '
                       'If you have Adobe').encode())


def http_error(code, body='Request rejected'):
    return urllib.error.HTTPError('https://example.test', code, 'Error', {},
                                  io.BytesIO(body.encode()))


class ProbeClientTests(unittest.TestCase):
    def error(self, code, body='Request rejected'):
        error = http_error(code, body)
        self.addCleanup(error.close)
        return error

    def test_permanent_http_errors_are_not_retried(self):
        for code in (400, 401, 403, 404, 422):
            with self.subTest(code=code), patch('blurb_probe.time.sleep') as sleep:
                opener = Mock()
                opener.open.side_effect = [form('initial'), self.error(code)]
                client = Client(opener)
                with self.assertRaises(urllib.error.HTTPError):
                    client.fetch('large_square', 'standard', 'lithowrap', 28)
                self.assertEqual(opener.open.call_count, 2)
                sleep.assert_not_called()

    def test_transient_status_and_transport_errors_are_retried(self):
        for error in (self.error(429), self.error(503), urllib.error.URLError('Disconnected')):
            with self.subTest(error=error), patch('blurb_probe.time.sleep') as sleep:
                opener = Mock()
                opener.open.side_effect = [form('initial'), error, specification()]
                client = Client(opener)
                row = client.fetch('large_square', 'standard', 'lithowrap', 28)
                self.assertEqual(row['pages'], 28)
                self.assertEqual(client.token, 'rotated')
                self.assertEqual(opener.open.call_count, 3)
                sleep.assert_called_once_with(1)

    def test_transient_failures_stop_after_three_attempts(self):
        with patch('blurb_probe.time.sleep') as sleep:
            opener = Mock()
            opener.open.side_effect = [form('initial')] + [self.error(503) for _ in range(3)]
            client = Client(opener)
            with self.assertRaises(urllib.error.HTTPError):
                client.fetch('large_square', 'standard', 'lithowrap', 28)
            self.assertEqual(opener.open.call_count, 4)
            self.assertEqual(sleep.call_count, 2)

    def test_explicit_token_rejection_refreshes_and_resubmits(self):
        for code in (403, 422):
            with self.subTest(code=code), patch('blurb_probe.time.sleep') as sleep:
                opener = Mock()
                opener.open.side_effect = [form('initial'), self.error(code, 'InvalidAuthenticityToken'),
                                          form('refreshed'), specification()]
                client = Client(opener)
                client.fetch('large_square', 'standard', 'lithowrap', 28)
                posted = urllib.parse.parse_qs(opener.open.call_args_list[3].args[1].decode())
                self.assertEqual(posted['authenticity_token'], ['refreshed'])
                self.assertEqual(client.token, 'rotated')
                sleep.assert_not_called()

    def test_token_error_in_success_status_also_refreshes(self):
        opener = Mock()
        opener.open.side_effect = [form('initial'), io.BytesIO(b'CSRF token expired'),
                                  form('refreshed'), specification()]
        Client(opener).fetch('large_square', 'standard', 'lithowrap', 28)
        self.assertEqual(opener.open.call_count, 4)

    def test_repeated_token_failure_is_bounded(self):
        for response in ('http', 'html'):
            with self.subTest(response=response):
                rejected = lambda: self.error(422, 'InvalidAuthenticityToken') if response == 'http' else io.BytesIO(b'InvalidAuthenticityToken')
                opener = Mock()
                opener.open.side_effect = [form('initial'), rejected(), form('refreshed'), rejected()]
                client = Client(opener)
                with self.assertRaises((urllib.error.HTTPError, ValueError)):
                    client.fetch('large_square', 'standard', 'lithowrap', 28)
                self.assertEqual(opener.open.call_count, 4)

    def test_missing_form_token_is_an_explicit_error(self):
        opener = Mock()
        opener.open.return_value = io.BytesIO(b'No calculator form')
        with self.assertRaisesRegex(ValueError, 'no authenticity token'):
            Client(opener)


class WhiteWallPaperTests(unittest.TestCase):
    def test_known_papers_and_decimal_normalization(self):
        self.assertEqual(len(RULES), 6)
        self.assertEqual(spine_width_mm('paper-digital-glossy', 44), 9.3)
        self.assertEqual(spine_width_mm('paper-digital-matte', 44), 9.9)
        for paper in ('paper-fujiCrystal-glossy', 'paper-fujiCrystal-semi-matte', 'paper-fujiCrystal-velvet'):
            self.assertEqual(spine_width_mm(paper, 36), 12.5)

    def test_unknown_papers_do_not_inherit_a_formula(self):
        for paper in ('paper-new', 'paper-fujiCrystal-new'):
            with self.subTest(paper=paper), self.assertRaisesRegex(ValueError, 'Unknown WhiteWall paper'):
                spine_width_mm(paper, 28)


if __name__ == '__main__':
    unittest.main()
