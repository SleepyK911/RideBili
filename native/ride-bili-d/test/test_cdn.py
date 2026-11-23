"""Regressions for signed CDN route selection and response reads."""
import io
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ytfetch


class Response(io.BytesIO):
    status = 200
    headers = {'Content-Length': '3'}

    def peek(self, _):
        return self.getbuffer()[:1].tobytes()


def url(name):
    return 'https://' + name + '.bilivideo.com/file.m4s'


class CdnTest(unittest.TestCase):
    def test_prioritizes_signed_mainland_backups_and_distinct_hosts(self):
        overseas = url('upos-sz-mirrorcosov') + '?sig=foreign'
        edge = url('edge') + '?os=mcdn&sig=edge'
        first = url('domestic') + '?a=x%2By&sig=a%2Fb'
        same_host = url('domestic') + '?sig=second'
        later = url('late') + '?sig=late'
        routes = [overseas, edge, first, same_host, first, later, 'https://wrong.example/video']
        self.assertEqual(ytfetch.cdn_routes(routes, 'upos-sz-mirrorcosov.bilivideo.com'),
                         [first, later, edge, overseas, same_host])
        self.assertEqual(ytfetch.cdn_routes(routes, 'late.bilivideo.com'),
                         [later, first, edge, overseas, same_host])

    def test_samples_first_media_bytes_once_without_probing(self):
        data = b'a' * 32768
        response = Response(data)
        response.headers = {'Content-Length': str(len(data))}
        with patch.object(ytfetch, 'open_route', return_value=response) as connect, patch.object(ytfetch, 'emit') as emit:
            with ytfetch.open_track(None, [url('primary'), url('backup')], '', kind='audio') as track:
                self.assertEqual(track.read(16384), data[:16384])
                emit.assert_not_called()
                self.assertEqual(track.read(16384), data[16384:])
                self.assertEqual(track.read(1), b'')
        self.assertEqual(connect.call_count, 1)
        emit.assert_called_once()
        record = emit.call_args[1]
        self.assertEqual((record['ev'], record['kind'], record['host'], record['bytes']),
                         ('cdn_sample', 'audio', 'primary.bilivideo.com', 32768))
        self.assertGreaterEqual(record['ms'], record['first_ms'])

    def test_replaces_failed_backup_while_primary_is_stalled(self):
        release, closed = threading.Event(), threading.Event()

        class Stalled(Response):
            def peek(self, n):
                if not release.wait(4):
                    raise TimeoutError('fixture primary timed out')
                return super().peek(n)

            def close(self):
                super().close()
                closed.set()

        def connect(_, route, __):
            if route == url('primary'):
                return Stalled(b'old')
            if route == url('failed'):
                raise OSError('fixture backup refused')
            return Response(b'new')

        try:
            start = time.monotonic()
            with patch.object(ytfetch, 'open_route', connect):
                with ytfetch.open_track(None, [url('primary'), url('failed'), url('third')], '') as track:
                    self.assertEqual(track.read(), b'new')
            elapsed = time.monotonic() - start
            self.assertLess(elapsed, 2, 'the third route must win before the stalled primary times out')
            print(f'third route selected after {elapsed * 1000:.0f} ms with the primary still stalled')
        finally:
            release.set()
        self.assertTrue(closed.wait(2), 'the late response must be closed')

    def test_fast_primary_does_not_start_backup(self):
        with patch.object(ytfetch, 'open_route', return_value=Response(b'abc')) as connect:
            with ytfetch.open_track(None, [url('primary'), url('backup')], '') as track:
                self.assertEqual(track.read(), b'abc')
        self.assertEqual(connect.call_count, 1)

    def test_empty_and_short_responses(self):
        with patch.object(ytfetch, 'open_route', side_effect=[Response(b''), Response(b'ab')]):
            with ytfetch.open_track(None, [url('empty'), url('short')], '') as track:
                self.assertEqual(track.read_some(8), b'ab')
                with self.assertRaises(ytfetch.CdnError):
                    track.read(8)

    def test_partial_read_resumes_without_repeating_delivered_bytes(self):
        first = Response(b'ab')
        first.headers = {'Content-Length': '6'}
        calls = []

        def connect(_, route, __, offset=0, total=None):
            calls.append((route, offset, total))
            return first if offset == 0 else Response(b'cdef')

        with patch.object(ytfetch, 'open_route', connect):
            with ytfetch.open_track(None, [url('primary'), url('backup')], '') as track:
                self.assertEqual(track.read(4), b'abcd')
                self.assertEqual(track.read(4), b'ef')
                self.assertEqual(track.read(4), b'')
        self.assertEqual(calls, [(url('primary'), 0, None), (url('backup'), 2, 6)])

    def test_resume_requires_exact_range_and_total(self):
        from unittest.mock import Mock

        for start, end, length in [(0, 5, 6), (2, 4, 5), (2, 4, 6)]:
            response = Response(b'bad')
            response.status = 206
            response.headers = {'Content-Range': f'bytes {start}-{end}/{length}'}
            opener = Mock()
            opener.open.return_value = response
            with self.assertRaises(OSError):
                ytfetch.open_route(opener, url('primary'), '', 2, 6)
            self.assertTrue(response.closed)

    def test_audio_can_resume_twice_and_reopen_the_original_host(self):
        calls = []

        def connect(_, route, __, offset=0, total=None):
            calls.append((route, offset, total))
            response = Response(b'abcdef'[offset:offset + 2])
            response.headers = {'Content-Length': '6'}
            return response

        with patch.object(ytfetch, 'open_route', connect), patch.object(ytfetch, 'emit'):
            with ytfetch.open_track(None, [url('primary'), url('backup')], '', kind='audio') as track:
                self.assertEqual(track.read(6), b'abcdef')
                self.assertEqual(track.read_some(1), b'')
        self.assertEqual(calls, [(url('primary'), 0, None), (url('backup'), 2, 6), (url('primary'), 4, 6)])


if __name__ == '__main__':
    unittest.main()
