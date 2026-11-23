"""Check that PCM seek discards the prefix and reports an absolute clock."""
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pcmout


class PcmOffsetTest(unittest.TestCase):
    def test_only_samples_after_target_reach_alsa(self):
        first = b'\x11\x00\x11\x00'
        second = b'\x22\x00\x22\x00'
        events, played = [], bytearray()

        class Sink:
            def write(self, data):
                played.extend(data)
                return len(data) // pcmout.FRAME

            def queued(self):
                return 0

        audio, writer = os.pipe()
        control, commands = os.pipe()

        def feed():
            with os.fdopen(writer, 'wb') as file:
                file.write(first * pcmout.RATE + second * pcmout.RATE)

        producer = threading.Thread(target=feed, daemon=True)
        try:
            os.write(commands, b'start\n')
            producer.start()
            with patch.object(pcmout, 'emit', lambda name, **data: events.append((name, data))):
                pcmout.play(Sink(), audio, control, start_ms=1000)
        finally:
            for fd in (audio, control, commands):
                os.close(fd)
            producer.join(timeout=2)
        self.assertEqual(played, second * pcmout.RATE)
        self.assertIn(('ended', {'ms': 2000}), events)
        self.assertTrue(any(name == 'skip' for name, _ in events))
        self.assertTrue(all(data['ms'] >= 1000 for name, data in events if name == 'time'))


if __name__ == '__main__':
    unittest.main()
