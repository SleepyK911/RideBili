#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Play bounded, interleaved stereo PCM on the local ALSA device.

PCM arrives on fd 3. Standard input carries start/hold commands. The audio
clock is the number of frames written minus the frames still in ALSA.
"""
import ctypes as c
import errno
import json
import os
import select
import sys
import time

RATE = 48000
FRAME = 4
CHUNK = 1024 * FRAME
PREROLL = RATE * FRAME * 3 // 10
LIMIT = RATE * FRAME


class IncompletePcm(ValueError):
    pass


def emit(event, **data):
    print(json.dumps(dict(ev=event, **data)), flush=True)


class Alsa:
    def __init__(self, device):
        self.lib = c.CDLL('libasound.so.2')
        self.handle = c.c_void_p()
        p, i, u, l = c.c_void_p, c.c_int, c.c_uint, c.c_long
        signatures = {
            'open': ([c.POINTER(p), c.c_char_p, i, i], i),
            'set_params': ([p, i, i, u, u, i, u], i),
            'writei': ([p, c.c_char_p, c.c_ulong], l),
            'delay': ([p, c.POINTER(l)], i),
            'recover': ([p, i, i], i),
            'close': ([p], i),
        }
        for name, (args, result) in signatures.items():
            method = getattr(self.lib, 'snd_pcm_' + name)
            method.argtypes, method.restype = args, result
            setattr(self, name, method)
        self.check(self.open(c.byref(self.handle), os.fsencode(device), 0, 1), 'open')
        try:
            # S16_LE, RW_INTERLEAVED, two channels, software resampling allowed, 64 ms.
            self.check(self.set_params(self.handle, 2, 3, 2, RATE, 1, 64000), 'set_params')
        except Exception:
            self.close(self.handle)
            raise

    @staticmethod
    def check(result, operation):
        if result < 0:
            raise OSError(-result, 'ALSA ' + operation)

    def write(self, data):
        result = self.writei(self.handle, data, len(data) // FRAME)
        if result == -errno.EAGAIN:
            return 0
        if result in (-errno.EPIPE, -errno.ESTRPIPE, -errno.EINTR):
            self.check(self.recover(self.handle, result, 1), 'recover')
            return 0
        self.check(result, 'write')
        return result

    def queued(self):
        delay = c.c_long()
        result = self.delay(self.handle, c.byref(delay))
        if result in (-errno.EPIPE, -errno.ESTRPIPE):
            return 0
        self.check(result, 'delay')
        return max(0, delay.value)


def play(alsa, audio=3, control=0, start_ms=0):
    os.set_blocking(audio, False)
    buf, commands = bytearray(), b''
    eof, ready, running, rebuffer = False, False, False, True
    waiting = False
    written = heard = 0
    skip_bytes = start_ms * RATE // 1000 * FRAME
    last_skip = 0
    last_write = last_tick = time.monotonic()
    while True:
        watch = [control]
        if not eof and len(buf) < LIMIT:
            watch.append(audio)
        readable, _, _ = select.select(watch, [], [], 0.015)
        if control in readable:
            data = os.read(control, 4096)
            if not data:
                return
            commands += data
            while b'\n' in commands:
                command, commands = commands.split(b'\n', 1)
                if command == b'quit':
                    return
                if command in (b'start', b'hold'):
                    if command == b'start' and not running:
                        last_write = time.monotonic()
                    running = command == b'start'
        if audio in readable:
            data = os.read(audio, min(32768, LIMIT - len(buf)))
            eof = not data
            if skip_bytes and data:
                discard = min(skip_bytes, len(data))
                skip_bytes -= discard
                data = data[discard:]
                now = time.monotonic()
                if now - last_skip >= 0.5:
                    last_skip = now
                    emit('skip')
            buf.extend(data)
            if eof and (len(buf) % FRAME or not (written or buf)):
                raise IncompletePcm('truncated PCM stream')
        if not ready and (len(buf) >= PREROLL or eof):
            ready = True
            emit('ready')

        now = time.monotonic()
        queued = alsa.queued() if written else 0
        if written:
            heard = max(heard, written - queued)
        if running and ready and not eof and not queued and len(buf) < FRAME:
            rebuffer = True
        if rebuffer and (len(buf) >= PREROLL or eof):
            rebuffer = False
        stalled = running and ready and rebuffer
        if waiting != stalled:
            waiting = stalled
            emit('buffer', on=waiting)
        if running and ready and not rebuffer and len(buf) >= FRAME:
            n = min(CHUNK, len(buf) // FRAME * FRAME)
            count = alsa.write(bytes(buf[:n]))
            if count:
                del buf[:count * FRAME]
                written += count
                last_write = now
            elif now - last_write > 2.5:
                raise OSError('ALSA stopped accepting PCM')
        if ready and now - last_tick >= 0.10:
            emit('time', ms=start_ms + heard * 1000 // RATE, mono=int(now * 1000))
            last_tick = now
        if eof and not buf and heard == written and written:
            emit('ended', ms=start_ms + heard * 1000 // RATE)
            return


if __name__ == '__main__':
    try:
        sink = Alsa(sys.argv[1])
        try:
            emit('opened')
            play(sink, start_ms=max(0, int(sys.argv[2])) if len(sys.argv) > 2 else 0)
        finally:
            sink.close(sink.handle)
    except (OSError, ValueError) as e:
        emit('error', msg=str(e), incomplete=isinstance(e, IncompletePcm))
        sys.exit(1)
