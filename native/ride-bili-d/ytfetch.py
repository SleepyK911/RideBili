#!/usr/bin/env python3
"""Download Bilibili DASH or progressive MP4 and prepare the BMW audio and RideTube video files."""
from contextlib import contextmanager
from http.client import HTTPException
import json
from itertools import accumulate, chain, repeat
import os
from queue import Empty, Queue
import re
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.request
from urllib.parse import urlsplit
from fractions import Fraction

ID_RE = re.compile(r'BV[0-9A-Za-z]{10}(?:_p[1-9][0-9]{0,3})?')
HDR = struct.Struct('<4sHHHHHxxI12x')  # 32 bytes, record count at offset 16
REC = struct.Struct('<IQIB')            # 17 bytes: pts_ms, pos, size, key
CA = '/var/opt/mgu-python/current/ssl/cacert.pem'
LEASE = '/run/mgu-uplink/lease.json'
START_VIDEO_MS = 650
CDN_HEDGE_SECONDS = 0.30
CDN_TIMEOUT = 6
# ---------------------------------------------------------------- events

_out = sys.stdout
_out_lock = threading.Lock()


def emit(**kw):
    with _out_lock:
        try:
            _out.write(json.dumps(kw) + '\n')
            _out.flush()
        except OSError:
            os._exit(1)  # the daemon is gone


def fail(msg, pcm_fallback=False):
    emit(ev='error', msg=str(msg)[-500:], pcmFallback=pcm_fallback)
    os._exit(1)  # the other thread may sit in a socket read


MIN_FREE = 256 << 20  # bytes left free on the cache's file system while a video downloads


class Throttle:
    def __init__(self, per_s=2):
        self.gap, self.last = 1 / per_s, 0

    def __call__(self):
        now = time.monotonic()
        if now - self.last < self.gap:
            return False
        self.last = now
        return True


# ---------------------------------------------------------------- DNS through the uplink's lease

def _skip_name(b, i):
    while True:
        n = b[i]
        if n & 0xc0 == 0xc0:
            return i + 2
        if n == 0:
            return i + 1
        i += n + 1


def resolve_a(host, servers, timeout=3):
    qid = os.urandom(2)
    q = (qid + b'\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00'
         + b''.join(bytes([len(p)]) + p for p in host.rstrip('.').encode('idna').split(b'.'))
         + b'\x00\x00\x01\x00\x01')
    err = 'no server'
    for srv in servers:
        s = socket.socket(socket.AF_INET6 if ':' in srv else socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.settimeout(timeout)
            s.sendto(q, (srv, 53))
            r = s.recv(4096)
            while r[:2] != qid:
                r = s.recv(4096)
            if r[3] & 15:
                err = f'{srv}: rcode {r[3] & 15}'
                continue
            i = _skip_name(r, 12) + 4
            ips = []
            for _ in range(struct.unpack_from('>H', r, 6)[0]):
                i = _skip_name(r, i)
                typ, cls, _ttl, ln = struct.unpack_from('>HHIH', r, i)
                i += 10
                if typ == 1 and cls == 1 and ln == 4:
                    ips.append(socket.inet_ntoa(r[i:i + 4]))
                i += ln
            if ips:
                return ips
            err = f'{srv}: no A record'
        except (OSError, IndexError, struct.error) as e:
            err = f'{srv}: {e}'
        finally:
            s.close()
    raise socket.gaierror(socket.EAI_NONAME, f'{host}: lease DNS: {err}')


def lease_servers(lease):
    try:
        with open(lease) as f:
            return [s for s in json.load(f).get('dns', []) if isinstance(s, str)]
    except (OSError, ValueError, AttributeError):
        return []


def _is_ip(h):
    for fam in (socket.AF_INET, socket.AF_INET6):
        try:
            socket.inet_pton(fam, h)
            return True
        except OSError:
            pass
    return False


def install_dns(lease):
    """The system resolver answers no internet names on the car: ask the uplink's DNS servers."""
    if getattr(socket.getaddrinfo, '_lease', None) == lease:  # serve installed it
        return lease_servers(lease)
    servers = lease_servers(lease)
    if not servers:
        return []
    orig, cache = socket.getaddrinfo, {}

    def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        h = host.decode() if isinstance(host, bytes) else host
        if not h or h == 'localhost' or _is_ip(h) or family == socket.AF_INET6:
            return orig(host, port, family, type, proto, flags)
        if h not in cache:
            cache[h] = resolve_a(h, servers)
        p = int(port or 0)  # shortcut: service names ('https') unsupported, urllib/yt-dlp pass numbers
        return [(socket.AF_INET, type or socket.SOCK_STREAM, proto, '', (ip, p)) for ip in cache[h]]

    getaddrinfo._lease = lease
    socket.getaddrinfo = getaddrinfo
    return servers


# ---------------------------------------------------------------- MP4 boxes

def boxes(b, i=0, end=None):
    """Yield (type, payload_start, box_end) for the boxes in b[i:end]."""
    end = len(b) if end is None else end
    while i + 8 <= end:
        size, typ = struct.unpack_from('>I4s', b, i)
        hdr = 8
        if size == 1:
            size, hdr = struct.unpack_from('>Q', b, i + 8)[0], 16
        elif size == 0:
            size = end - i
        if size < hdr or i + size > end:
            raise ValueError(f'bad {typ!r} box')
        yield typ, i + hdr, i + size
        i += size


def kid(b, s, e, *path):
    for name in path:
        s, e = next(((s2, e2) for t, s2, e2 in boxes(b, s, e) if t == name), (None, None))
        if s is None:
            raise ValueError(f'no {name.decode()} box')
    return s, e


def trak_info(moov, handler=None):
    """First matching track, with the sample table and DASH defaults."""
    for t, s, e in boxes(moov, 8):
        if t != b'trak':
            continue
        h, _ = kid(moov, s, e, b'mdia', b'hdlr')
        if handler is None or moov[h + 8:h + 12] == handler:
            break
    else:
        raise ValueError('MP4: missing track')
    ms, _ = kid(moov, s, e, b'mdia', b'mdhd')
    ts = struct.unpack_from('>I', moov, ms + (20 if moov[ms] else 12))[0]
    st, ste = kid(moov, s, e, b'mdia', b'minf', b'stbl')
    ds, de = kid(moov, st, ste, b'stsd')
    zs, _ = kid(moov, st, ste, b'stsz')
    trex = (0, 0, 0)
    try:
        xs, _ = kid(moov, 8, len(moov), b'mvex', b'trex')
        trex = struct.unpack_from('>III', moov, xs + 12)  # default duration, size, flags
    except ValueError:
        pass
    return dict(ts=ts, stsd=moov[ds - 8:de], stsd_at=(ds, de),
                stbl=(st, ste), samples=struct.unpack_from('>I', moov, zs + 8)[0], trex=trex)


def parse_moof(b, next_dts, trex):
    """Samples of moof box bytes b: [(offset from moof start, size, dts, cto, flags)], next dts."""
    out = []
    for t, s, e in boxes(b, 8):
        if t != b'traf':
            continue
        hs, _ = kid(b, s, e, b'tfhd')
        fl = struct.unpack_from('>I', b, hs)[0] & 0xffffff
        p, base = hs + 8, None
        if fl & 1:
            base, p = struct.unpack_from('>Q', b, p)[0], p + 8
        if fl & 2:
            p += 4
        dd, dsz, dfl = trex
        if fl & 8:
            dd, p = struct.unpack_from('>I', b, p)[0], p + 4
        if fl & 0x10:
            dsz, p = struct.unpack_from('>I', b, p)[0], p + 4
        if fl & 0x20:
            dfl = struct.unpack_from('>I', b, p)[0]
        if base is not None:
            raise ValueError('tfhd base_data_offset unsupported')
        try:
            ts_, _ = kid(b, s, e, b'tfdt')
            next_dts = struct.unpack_from('>Q' if b[ts_] else '>I', b, ts_ + 4)[0]
        except ValueError:
            pass
        pos = 0
        for t2, rs, _ in boxes(b, s, e):
            if t2 != b'trun':
                continue
            v, rfl = b[rs], struct.unpack_from('>I', b, rs)[0] & 0xffffff
            n = struct.unpack_from('>I', b, rs + 4)[0]
            p = rs + 8
            if rfl & 1:
                pos, p = struct.unpack_from('>i', b, p)[0], p + 4
            first = None
            if rfl & 4:
                first, p = struct.unpack_from('>I', b, p)[0], p + 4
            for k in range(n):
                d, sz, sf, cto = dd, dsz, (first if k == 0 and first is not None else dfl), 0
                if rfl & 0x100:
                    d, p = struct.unpack_from('>I', b, p)[0], p + 4
                if rfl & 0x200:
                    sz, p = struct.unpack_from('>I', b, p)[0], p + 4
                if rfl & 0x400:
                    sf, p = struct.unpack_from('>I', b, p)[0], p + 4
                if rfl & 0x800:
                    cto, p = struct.unpack_from('>i' if v else '>I', b, p)[0], p + 4
                out.append((pos, sz, next_dts, cto, sf))
                pos += sz
                next_dts += d
    return out, next_dts


def is_key(flags):
    return not flags & 0x01010000  # ffmpeg's rule: not non-sync and not depends-on-others


# ---------------------------------------------------------------- audio: DASH m4a -> plain MP4, moov first

def box(t, *parts):
    body = b''.join(parts)
    return struct.pack('>I4s', 8 + len(body), t) + body


def full(t, flags, *parts):
    return box(t, struct.pack('>I', flags), *parts)


MATRIX = struct.pack('>9I', 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000)


def flat_moov(ts, stsd, durs, sizes, chunks, offsets):
    stts, run = [], None
    for d in durs:
        if run and run[1] == d:
            run[0] += 1
        else:
            run = [1, d]
            stts.append(run)
    stsc = []
    for i, (_, n) in enumerate(chunks):
        if not stsc or stsc[-1][1] != n:
            stsc.append((i + 1, n))
    total = sum(durs)
    stbl = box(b'stbl', stsd,
               full(b'stts', 0, struct.pack('>I', len(stts)), *(struct.pack('>II', *r) for r in stts)),
               full(b'stsc', 0, struct.pack('>I', len(stsc)), *(struct.pack('>III', c, n, 1) for c, n in stsc)),
               full(b'stsz', 0, struct.pack('>II', 0, len(sizes)), struct.pack(f'>{len(sizes)}I', *sizes)),
               full(b'stco', 0, struct.pack('>I', len(offsets)), struct.pack(f'>{len(offsets)}I', *offsets)))
    minf = box(b'minf', full(b'smhd', 0, b'\0' * 4),
               box(b'dinf', full(b'dref', 0, struct.pack('>I', 1), full(b'url ', 1))), stbl)
    mdia = box(b'mdia', full(b'mdhd', 0, struct.pack('>IIIIHH', 0, 0, ts, total, 0x55c4, 0)),
               full(b'hdlr', 0, b'\0' * 4, b'soun', b'\0' * 12, b'SoundHandler\0'), minf)
    tkhd = full(b'tkhd', 3, struct.pack('>IIIII', 0, 0, 1, 0, total), b'\0' * 8,
                struct.pack('>HHHH', 0, 0, 0x0100, 0), MATRIX, b'\0' * 8)
    mvhd = full(b'mvhd', 0, struct.pack('>IIIIIH', 0, 0, ts, total, 0x10000, 0x0100), b'\0' * 10,
                MATRIX, b'\0' * 24, struct.pack('>I', 2))
    return box(b'moov', mvhd, box(b'trak', tkhd, mdia))


def flatten_m4a(src, dst, limit=None):
    """Rewrite a fragmented (DASH) m4a as ftyp+moov+mdat; edit lists are dropped. Returns (dst size, ms).
    limit: only src[:limit] is written yet (the rest may be zeros): the samples entirely inside it; a plain
    MP4 then gives None (it cannot be cut)."""
    with open(src, 'rb') as f:
        top, limit_ = [], os.fstat(f.fileno()).st_size if limit is None else limit
        while True:
            at, h = f.tell(), f.read(16)
            if len(h) < 8 or at + 8 > limit_:
                break
            size, t = struct.unpack_from('>I4s', h)
            if size == 1:
                size = struct.unpack_from('>Q', h, 8)[0]
            elif size == 0:
                size = os.fstat(f.fileno()).st_size - at
            if size < 8 or (at + size > limit_ and t != b'mdat'):
                break  # a box not all written yet (an mdat is cut per sample below)
            if t in (b'moov', b'moof'):
                f.seek(at)
                top.append((t, at, f.read(size)))
            f.seek(at + size)
        moov = next((bx for t, _, bx in top if t == b'moov'), None)
        if moov is None:
            raise ValueError('audio: no moov')
        tk = trak_info(moov)
        if tk['samples']:  # already a plain MP4
            if limit is not None:
                return None
            shutil.copyfile(src, dst)
            return os.path.getsize(dst), 0
        end, durs, sizes, chunks, dts = None, [], [], [], 0  # chunks: (source offset, sample count), one per run
        cut = False
        for t, at, b in top:
            if t != b'moof' or cut:
                continue
            samples, nd = parse_moof(b, dts, tk['trex'])
            for i, (off, sz, sdts, _, _) in enumerate(samples):
                if at + off + sz > limit_:
                    cut = True
                    break
                if chunks and at + off == end:
                    chunks[-1][1] += 1
                else:
                    chunks.append([at + off, 1])
                end = at + off + sz
                sizes.append(sz)
                durs.append((samples[i + 1][2] if i + 1 < len(samples) else nd) - sdts)
            dts = nd
        if not sizes:
            raise ValueError('audio: no samples')
        return write_flat_audio(f, dst, tk, durs, sizes, chunks)


def write_flat_audio(f, dst, tk, durs, sizes, chunks):
    if tk['stsd'][20:24] != b'mp4a':
        raise ValueError('audio: expected AAC sample entry')
    ftyp = box(b'ftyp', b'M4A ', struct.pack('>I', 0x200), b'M4A isomiso2')
    n = len(chunks)
    head = len(ftyp) + len(flat_moov(tk['ts'], tk['stsd'], durs, sizes, chunks, [0] * n)) + 8
    offsets, o, i = [], head, 0
    for _, k in chunks:
        offsets.append(o)
        o += sum(sizes[i:i + k])
        i += k
    moov2 = flat_moov(tk['ts'], tk['stsd'], durs, sizes, chunks, offsets)
    if o - head + 8 > 0xffffffff:
        raise ValueError('audio: over 4 GB')
    with open(dst, 'wb') as g:
        g.write(ftyp + moov2 + struct.pack('>I4s', o - head + 8, b'mdat'))
        i = 0
        for at, k in chunks:
            nbytes = sum(sizes[i:i + k])
            i += k
            f.seek(at)
            g.write(f.read(nbytes))
    return os.path.getsize(dst), sum(durs) * 1000 // tk['ts']


class AnnexB:
    """Length-prefixed NALs -> Annex-B, with SPS/PPS before IDRs: byte-for-byte ffmpeg's h264_mp4toannexb."""

    def __init__(self, avcc):
        self.ls = (avcc[4] & 3) + 1
        i, sps, pps = 6, [], []
        for _ in range(avcc[5] & 31):
            n = struct.unpack_from('>H', avcc, i)[0]
            sps.append(avcc[i + 2:i + 2 + n])
            i += 2 + n
        for _ in range(avcc[i]):
            n = struct.unpack_from('>H', avcc, i + 1)[0]
            pps.append(avcc[i + 3:i + 3 + n])
            i += 2 + n
        if not sps or not pps:
            raise ValueError('avcC without SPS/PPS')
        self.sps = b''.join(b'\0\0\0\1' + x for x in sps)
        self.pps = b''.join(b'\0\0\0\1' + x for x in pps)
        self.new_idr, self.sps_seen, self.pps_seen = True, False, False

    def convert(self, data):
        out, i, ls = bytearray(), 0, self.ls
        while i + ls <= len(data):
            n = int.from_bytes(data[i:i + ls], 'big')
            nal = data[i + ls:i + ls + n]
            i += ls + n
            if not nal:
                continue
            t = nal[0] & 31
            if t == 7:
                self.sps_seen = self.new_idr = True
            elif t == 8:
                self.pps_seen = self.new_idr = True
                if not self.sps_seen:
                    out += self.sps
                    self.sps_seen = True
            if not self.new_idr and t == 5 and len(nal) > 1 and nal[1] & 0x80:
                self.new_idr = True
            if self.new_idr and t == 5 and not self.sps_seen and not self.pps_seen:
                out += self.sps + self.pps
                self.new_idr = False
            elif self.new_idr and t == 5 and self.sps_seen and not self.pps_seen:
                out += self.pps
            out += (b'\0\0\0\1' if not out or t in (7, 8) else b'\0\0\1') + nal
            if not self.new_idr and t == 1:
                self.new_idr, self.sps_seen, self.pps_seen = True, False, False
        return bytes(out)


def read_box_header(f):
    """(type, header, remaining bytes), with None for a box extending to EOF."""
    h = f.read(8)
    if not h:
        return None
    if len(h) < 8:
        raise ValueError('video: truncated')
    size, t = struct.unpack('>I4s', h)
    if size == 1:
        x = f.read(8)
        h += x
        size = struct.unpack('>Q', x)[0]
    if size and size < len(h):
        raise ValueError(f'video: bad {t!r} box')
    return t, h, size - len(h) if size else None


def read_exact(f, size):
    if size is None:
        raise ValueError('video: missing box length')
    data = f.read(size)
    if len(data) != size:
        raise ValueError('video: truncated')
    return data


def skip_bytes(f, size):
    while size is None or size:
        n = 256 << 10
        data = f.read(n if size is None else min(n, size))
        if not data:
            if size is not None:
                raise ValueError('video: truncated')
            return
        if size is not None:
            size -= len(data)


def sample_batches(f, data_at, size, samples, moof_at, first):
    """Read contiguous samples in bounded batches, publishing the first keyframe alone."""
    end = data_at + size if size is not None else None
    if any(a[0] + a[1] > b[0] for a, b in zip(samples, samples[1:])):
        # Preserve the seek-like interpretation for fragments that do not
        # interleave media in decode order.
        need = max(o + n for o, n, *_ in samples) + moof_at - data_at
        if need < 0 or (size is not None and need > size):
            raise ValueError('video: sample outside mdat')
        data = memoryview(read_exact(f, need))
        if any(moof_at + o < data_at for o, *_ in samples):
            raise ValueError('video: sample outside mdat')
        yield samples, data, data_at
        skip_bytes(f, None if size is None else size - need)
        return
    cursor, i = data_at, 0
    while i < len(samples):
        start = moof_at + samples[i][0]
        stop = start + samples[i][1]
        j = i + 1
        if not first or i:
            while j < min(i + 12, len(samples)) and stop == moof_at + samples[j][0] and stop - start < 128 << 10:
                stop += samples[j][1]
                j += 1
        if start < cursor or (end is not None and stop > end):
            raise ValueError('video: sample outside or out of order in mdat')
        skip_bytes(f, start - cursor)
        data = memoryview(read_exact(f, stop - start))
        yield samples[i:j], data, start
        cursor, i = stop, j
    skip_bytes(f, None if end is None else end - cursor)


def video_config(moov, tk, cap):
    ds, _ = tk['stsd_at']
    es, ee = ds + 16, ds + 8 + struct.unpack_from('>I', moov, ds + 8)[0]
    if moov[ds + 12:ds + 16] not in (b'avc1', b'avc3'):
        raise ValueError('video: expected AVC sample entry')
    w, h = struct.unpack_from('>HH', moov, es + 24)
    max_long = {360: 640, 480: 864, 720: 1280, 1080: 1920}[cap]
    if not min(w, h) or min(w, h) > cap or max(w, h) > max_long:
        raise ValueError(f'video: dimensions exceed {cap}p')
    cs, ce = kid(moov, es + 78, ee, b'avcC')
    return w, h, AnnexB(moov[cs:ce])


def demux_video(f, d, on_progress, cap=1080):
    """Stream fMP4 from f into d/video.h264.part + d/index.bin. Returns (frames, bytes, max_ms)."""
    vfd = os.open(os.path.join(d, 'video.h264.part'), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    ifd = None
    at, conv, tk, base, pos, count, max_ms, dts, moof = 0, None, None, None, 0, 0, 0, 0, None
    try:
        ifd = os.open(os.path.join(d, 'index.bin'), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        while (bx := read_box_header(f)) is not None:
            t, header, size = bx
            data_at = at + len(header)
            if t == b'moov':
                b = header + read_exact(f, size)
                tk = trak_info(b)
                if tk['samples']:
                    raise ValueError('video: not fragmented')
                w, h, conv = video_config(b, tk, cap)
            elif t == b'moof':
                if conv is None:
                    raise ValueError('video: moof before moov')
                moof = (at, header + read_exact(f, size))
            elif t == b'mdat' and moof:
                m_at, mb = moof
                samples, dts = parse_moof(mb, dts, tk['trex'])
                if samples and base is None:
                    base = min(s[2] + s[3] for s in samples)
                    dur = (samples[1][2] - samples[0][2]) if len(samples) > 1 else (tk['trex'][0] or 1)
                    fps = Fraction(tk['ts'], dur).limit_denominator(1001)
                    os.write(ifd, HDR.pack(b'MGYI', 1, w, h, fps.numerator, fps.denominator, 0))
                for batch, payload, start in sample_batches(f, data_at, size, samples, m_at, not count):
                    vbuf, ibuf = [], []
                    for off, sz, sdts, cto, sf in batch:
                        o = m_at + off - start
                        au = conv.convert(payload[o:o + sz])
                        key = is_key(sf)
                        if count == 0 and not key:
                            raise ValueError('video: first sample is not a keyframe')
                        ms = max(0, round((sdts + cto - base) * 1000 / tk['ts']))
                        max_ms = max(max_ms, ms)
                        vbuf.append(au)
                        ibuf.append(REC.pack(ms, pos, len(au), key))
                        pos += len(au)
                        count += 1
                    # order matters to the reader: bytes, then their records, then the count
                    os.write(vfd, b''.join(vbuf))
                    os.write(ifd, b''.join(ibuf))
                    os.pwrite(ifd, struct.pack('<I', count), 16)
                    on_progress(max_ms, count, pos)
                moof = None
            else:
                skip_bytes(f, size)
            if size is None:
                break
            at = data_at + size
    finally:
        os.close(vfd)
        if ifd is not None:
            os.close(ifd)
    if not count or moof:
        raise ValueError('video: missing or incomplete frames')
    os.replace(os.path.join(d, 'video.h264.part'), os.path.join(d, 'video.h264'))
    return count, pos, max_ms


def read_moov(f, size):
    """Read the index without loading the media data box into memory."""
    while f.tell() + 8 <= size:
        start = f.tell()
        length, typ = struct.unpack('>I4s', f.read(8))
        if length == 1:
            length = struct.unpack('>Q', f.read(8))[0]
        elif not length:
            length = size - start
        if length < f.tell() - start or start + length > size:
            raise ValueError('MP4: invalid box')
        if typ == b'moov' and length <= 32 << 20:
            f.seek(start)
            return f.read(length)
        f.seek(start + length)
    raise ValueError('MP4: missing index')


def sample_table(moov, track):
    """Return the progressive MP4 sample sizes, timing, and chunk offsets."""
    st, end = track['stbl']
    table = {t: memoryview(moov)[i:j] for t, i, j in boxes(moov, st, end)}
    count = track['samples']
    if not 0 < count <= 2_000_000:
        raise ValueError('MP4: invalid sample count')

    def entries(name, fmt):
        data = table[name]
        n = struct.unpack_from('>I', data, 4)[0]
        if len(data) != 8 + n * struct.calcsize(fmt):
            raise ValueError('MP4: invalid sample table')
        return struct.iter_unpack(fmt, data[8:])

    def runs(name, fmt):
        out = []
        for n, value in entries(name, fmt):
            if len(out) + n > count:
                raise ValueError('MP4: invalid sample timing')
            out.extend(repeat(value, n))
        if len(out) != count:
            raise ValueError('MP4: incomplete sample timing')
        return out

    fixed = struct.unpack_from('>I', table[b'stsz'], 4)[0]
    sizes = [fixed] * count if fixed else tuple(x[0] for x in struct.iter_unpack('>I', table[b'stsz'][12:]))
    if len(sizes) != count or not min(sizes) or max(sizes) > 16 << 20:
        raise ValueError('MP4: invalid sample size')
    offsets = entries(b'co64', '>Q') if b'co64' in table else entries(b'stco', '>I')
    mappings = iter(entries(b'stsc', '>III'))
    mapping, following = next(mappings, None), None
    if mapping is None or mapping[0] != 1:
        raise ValueError('MP4: missing chunk mapping')
    following = next(mappings, None)
    chunks = []
    for i, (offset,) in enumerate(offsets, 1):
        if following and following[0] <= i:
            mapping, following = following, next(mappings, None)
        if mapping[2] != 1 or not mapping[1]:
            raise ValueError('MP4: unsupported sample description')
        chunks.append((offset, mapping[1]))
    if sum(n for _, n in chunks) != count:
        raise ValueError('MP4: incomplete chunk mapping')
    durations = runs(b'stts', '>II')
    composition = runs(b'ctts', '>Ii' if table[b'ctts'][0] else '>II') if b'ctts' in table else None
    keys = {x[0] for x in entries(b'stss', '>I')} if b'stss' in table else None
    return sizes, chunks, durations, composition, keys


def unpack_progressive(src, d, cap, on_progress):
    vpart = os.path.join(d, 'video.h264.part')
    ap = os.path.join(d, 'audio.m4a.part')
    with open(src, 'rb') as f:
        size = os.fstat(f.fileno()).st_size
        moov = read_moov(f, size)
        audio, video = trak_info(moov, b'soun'), trak_info(moov, b'vide')
        w, h, conv = video_config(moov, video, cap)
        asizes, achunks, adurs, _, _ = sample_table(moov, audio)
        vsizes, vchunks, vdurs, cto, keys = sample_table(moov, video)
        for sizes, chunks in ((asizes, achunks), (vsizes, vchunks)):
            i = 0
            for at, n in chunks:
                if at + sum(sizes[i:i + n]) > size:
                    raise ValueError('MP4: sample outside file')
                i += n
        check_space(d, size)
        abytes, _ = write_flat_audio(f, ap, audio, adurs, asizes, achunks)
        if not video['ts'] or not sum(vdurs) or (keys is not None and 1 not in keys):
            raise ValueError('MP4: invalid video timing')
        fps = Fraction(len(vsizes) * video['ts'], sum(vdurs)).limit_denominator(1001)
        if fps > 31:
            raise ValueError('MP4: frame rate exceeds 30 fps')
        pts = list(chain([0], accumulate(vdurs[:-1])))
        if cto is not None:
            pts = [dt + off for dt, off in zip(pts, cto)]
        base, pos, max_ms, i = min(pts), 0, 0, 0
        with open(vpart, 'wb') as out, open(os.path.join(d, 'index.bin'), 'wb') as index:
            index.write(HDR.pack(b'MGYI', 1, w, h, fps.numerator, fps.denominator, len(vsizes)))
            for at, n in vchunks:
                f.seek(at)
                for _ in range(n):
                    sample = f.read(vsizes[i])
                    if len(sample) != vsizes[i]:
                        raise ValueError('MP4: truncated sample')
                    data = conv.convert(sample)
                    ms = round((pts[i] - base) * 1000 / video['ts'])
                    index.write(REC.pack(ms, pos, len(data), keys is None or i + 1 in keys))
                    out.write(data)
                    pos += len(data)
                    max_ms = max(ms, max_ms)
                    i += 1
                on_progress(max_ms, i, pos)
    os.replace(vpart, os.path.join(d, 'video.h264'))
    os.replace(ap, os.path.join(d, 'audio.m4a'))
    return i, pos, max_ms, abytes


# ---------------------------------------------------------------- fetch


UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
WEB = 'https://www.bilibili.com/'


def is_cdn(url):
    if not isinstance(url, str) or len(url) > 8192:
        return False
    u = urlsplit(url)
    return (u.scheme == 'https' and ((u.hostname or '').endswith(('.bilivideo.com', '.bilivideo.cn'))
                or u.hostname == 'upos-hz-mirrorakam.akamaized.net')
            and u.username is None and u.port is None)


class CDNRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not is_cdn(newurl):
            raise OSError('unexpected CDN redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def open_route(opener, url, referer, offset=0, total=None):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': referer, 'Range': f'bytes={offset}-'})
    response = opener.open(req, timeout=CDN_TIMEOUT)
    if not offset and response.status == 200 and (total is None or response.headers.get('Content-Length') == str(total)):
        return response
    if response.status == 206:
        span = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
        if span:
            first, last, length = map(int, span.groups())
            if first == offset and first <= last and last + 1 == length and (total is None or total == length):
                return response
    response.close()
    raise OSError(str(response.status) + ' partial')


def first_cdn(opener, urls, referer, problems, offset=0, total=None):
    """Keep the first response with bytes. Refill a failed slot without waiting on the other."""
    results = Queue()
    lock = threading.Lock()
    finished = False
    pending = 0
    remaining = iter(urls)

    def connect(url):
        started = time.monotonic()
        response = None
        error = None
        try:
            response = open_route(opener, url, referer, offset, total) if total is not None else open_route(opener, url, referer)
            if not response.peek(1):
                raise OSError('empty media')
        except Exception as e:
            if response is not None:
                response.close()
                response = None
            error = getattr(e, 'code', None) or type(e).__name__
        with lock:
            if not finished:
                results.put((url, response, error, time.monotonic() - started))
            elif response is not None:
                response.close()

    def start_next():
        nonlocal pending
        url = next(remaining, None)
        if url is None:
            return
        threading.Thread(target=connect, args=(url,), daemon=True).start()
        pending += 1

    start_next()
    can_hedge = True
    try:
        while pending:
            try:
                url, response, error, first = results.get(timeout=CDN_HEDGE_SECONDS if can_hedge else None)
            except Empty:
                can_hedge = False
                start_next()
                continue
            pending -= 1
            if response is not None:
                return url, response, first
            problems.append(str(error))
            start_next()
        return None
    finally:
        with lock:
            finished = True
            while not results.empty():
                _, response, _, _ = results.get_nowait()
                if response is not None:
                    response.close()


class CdnError(OSError):
    """An exhausted route list or a transport error while reading a media track."""


def cdn_routes(urls, preferred=None):
    """Keep Bilibili's signed URLs intact and give ordinary mainland routes a head start."""
    def priority(url):
        u = urlsplit(url)
        host = u.hostname or ''
        overseas = host.endswith('.akamaized.net') or re.search(r'-(?:mirror(?:ali|aws|cos|tx|hw|bos)ov\d*|ov\d+)\.', host)
        edge = ('.mcdn.' in host or re.match(r'/v\d+/resource(?:/|$)', u.path)
                or re.search(r'(?:^|&)os=mcdn(?:&|$)', u.query, re.I))
        return (2 if overseas else 1 if edge else 0, host != preferred)

    unique = sorted(dict.fromkeys(url for url in urls[:12] if is_cdn(url)), key=priority)
    first, duplicates, hosts = [], [], set()
    for url in unique:
        host = urlsplit(url).hostname
        (duplicates if host in hosts else first).append(url)
        hosts.add(host)
    return (first + duplicates)[:5]


@contextmanager
def open_track(opener, urls, referer, kind=None, preferred=None):
    if not isinstance(urls, list):
        raise ValueError('missing CDN URLs')
    problems = []
    routes = cdn_routes(urls, preferred)
    selected = first_cdn(opener, routes, referer, problems)
    if selected is None:
        raise CdnError('B 站 CDN 无法下载 (' + ', '.join(problems) + ')')
    winner, response, first = selected
    host = urlsplit(winner).hostname
    def reopen(offset, total):
        nonlocal winner
        if kind:
            emit(ev='cdn_fault', kind=kind, host=urlsplit(winner).hostname)
        # Use alternate URLs for the same track, then allow a fresh connection to the old host.
        backups = [url for url in routes if url != winner] + [winner]
        problems.clear()
        replacement = first_cdn(opener, backups, referer, problems, offset, total)
        if replacement is None:
            raise CdnError('B 站 CDN 断点续读失败 (' + ', '.join(problems) + ')')
        winner = replacement[0]
        print(f'CDN resumed at {offset} of {total} bytes', file=sys.stderr, flush=True)
        return replacement[1]

    def sample(received, read_time):
        emit(ev='cdn_sample', kind=kind, host=host, first_ms=round(first * 1000),
             bytes=received, ms=round((first + read_time) * 1000))

    track = None
    try:
        track = CompleteTrack(response, reopen, sample if kind else None,
                              32768 if kind == 'audio' else 131072, resumes=2 if kind == 'audio' else 1)
        yield track
    finally:
        (track.response if track is not None else response).close()


class CompleteTrack:
    """Verify Content-Length even when the demuxer calls read(size)."""
    def __init__(self, response, reopen=None, sample=None, sample_bytes=131072, resumes=1):
        self.response = response
        size = response.headers.get('Content-Length')
        if response.status == 206:
            size = response.headers['Content-Range'].rsplit('/', 1)[1]
        self.left = int(size or -1)
        self.received = 0
        self.reopen = reopen
        self.resumes = resumes
        self.sample = sample
        self.sample_bytes = sample_bytes
        self.read_time = 0

    def read(self, n=-1):
        size = min(n, self.left) if n >= 0 and self.left >= 0 else n
        data = self.read_from(size, False)
        if size > len(data) and self.left > 0:
            parts = bytearray(data)
            while len(parts) < size:
                parts.extend(self.read_from(size - len(parts), False))
            return bytes(parts)
        return data

    def read_some(self, n):
        return self.read_from(n, True)

    def read_from(self, n, some):
        if not n or self.left == 0:
            return b''
        try:
            read = self.response.read1 if some else self.response.read
            if self.sample is None:
                return self.consume(read(n))
            started = time.monotonic()
            data = self.consume(read(n))
            self.read_time += time.monotonic() - started
            if self.received >= self.sample_bytes:
                sample, self.sample = self.sample, None
                sample(self.received, self.read_time)
            return data
        except (OSError, HTTPException) as e:
            if self.reopen and self.resumes and self.left > 0:
                self.resumes -= 1
                self.sample = None
                self.response.close()
                self.response = self.reopen(self.received, self.received + self.left)
                return self.read_from(n, some)
            raise CdnError('CDN read failed (' + type(e).__name__ + ')') from e

    def consume(self, data):
        if self.left >= 0:
            if len(data) > self.left:
                raise OSError('response exceeds declared size')
            self.left -= len(data)
            if not data and self.left:
                raise OSError('incomplete CDN response')
        self.received += len(data)
        return data


def check_space(d, needed=0):
    free = shutil.disk_usage(d).free
    if free < MIN_FREE + needed:
        raise OSError('车机存储空间不足')


def mp3_command(source, dest):
    helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mgu-audio')
    return [helper, '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-y',
            '-protocol_whitelist', 'file', '-i', source, '-map', '0:a:0', '-map_metadata', '-1',
            '-c:a', 'libmp3lame', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-f', 'mp3', dest]


def publish_mp3(mp3):
    part = mp3 + '.part'
    n = os.path.getsize(part)
    if n < 512:
        raise ValueError('MP3: empty audio')
    os.chmod(part, 0o644)
    os.replace(part, mp3)
    return n


def prepare_mp3(d, aac, duration, name='audio.mp3'):
    """Produce a self-contained MP3 for BMW's OapGenericMedia service."""
    mp3 = os.path.join(d, name)
    check_space(d, max(os.path.getsize(aac) * 3, int(duration * 17000) + 65536))
    subprocess.run(mp3_command(aac, mp3 + '.part'), check=True, timeout=max(120, duration / 5))
    n = publish_mp3(mp3)
    os.unlink(aac)
    return n


def dash_audio(opener, urls, referer, d, duration, resume_ms, preferred):
    """Encode the full DASH track during transfer and prepare one complete MP3 excerpt."""
    src = os.path.join(d, 'audio.src.m4a')
    mp3 = os.path.join(d, 'audio.mp3')
    full_done = threading.Event()
    head_ready = threading.Event()
    head = None
    started = time.monotonic()

    def make_head(prefix, minimum):
        aac = os.path.join(d, 'audio.head.aac.part')
        try:
            flat = flatten_m4a(src, aac, limit=prefix)
            if not flat or flat[1] < minimum or full_done.is_set():
                return
            ms = flat[1]
            n = prepare_mp3(d, aac, ms / 1000, 'audio.head.mp3')
            if not full_done.is_set():
                head_ready.set()
                emit(ev='audio_head', ms=ms, bytes=n)
                print(f'audio: head {ms / 1000:.1f}s at {time.monotonic() - started:.2f}s', file=sys.stderr, flush=True)
        except (OSError, ValueError, KeyError, struct.error, subprocess.SubprocessError):
            pass  # a flat/non-streamable MP4 can still use the complete-file path
        finally:
            for name in (aac, os.path.join(d, 'audio.head.mp3.part')):
                try:
                    os.unlink(name)
                except FileNotFoundError:
                    pass

    check_space(d, int(duration * 17000))
    # The helper already includes the file protocol. Linux exposes stdin as a non-seekable file.
    proc = subprocess.Popen(mp3_command('/proc/self/fd/0', mp3 + '.part'), stdin=subprocess.PIPE)
    tick, streamed = Throttle(), False
    try:
        with open_track(opener, urls, referer, 'audio', preferred) as track, open(src, 'wb') as out:
            total, received = max(0, track.left), 0
            attempts, next_head = 0, 0
            transfer_start = time.monotonic()
            feeding = True
            while True:
                chunk = track.read(64 << 10)
                if not chunk:
                    break
                out.write(chunk)
                received += len(chunk)
                if tick():
                    check_space(d)
                    if total:
                        emit(ev='audio', pct=min(100, round(received * 100 / total)))
                if head is not None and not head.is_alive() and not head_ready.is_set():
                    head.join()
                    head = None
                if (head is None and not head_ready.is_set() and attempts < 2 and received >= next_head
                        and total > received and duration >= 60 and resume_ms <= 84000):
                    # A longer clip or a slow link gets a longer runway. Bound the work before playback.
                    elapsed = max(0.1, time.monotonic() - transfer_start)
                    remaining = (total - received) * elapsed / received
                    floor = 24 if duration < 120 else 15
                    goal = min(90, duration * 0.65, max(floor, 1.35 * remaining + 4, duration / 24 + 4, resume_ms / 1000 + 4))
                    if (duration >= 120 or remaining >= 4) and duration * received / total >= goal and received < total * 0.75:
                        out.flush()
                        minimum = max(20000 if duration < 120 else 10000, resume_ms + 2500)
                        attempts += 1
                        next_head = received + max(64 << 10, total // 10)
                        head = threading.Thread(target=make_head, args=(received, minimum), daemon=True)
                        head.start()
                if feeding:
                    try:
                        proc.stdin.write(chunk)
                    except BrokenPipeError:
                        feeding = False
        try:
            proc.stdin.close()
        except BrokenPipeError:
            pass
        streamed = proc.wait(timeout=max(120, duration / 5)) == 0
        if streamed:
            try:
                n = os.path.getsize(mp3 + '.part')
                if n / 16000 + 3 < duration * 0.94:
                    raise ValueError('MP3: stream ended early')
                n = publish_mp3(mp3)
            except (OSError, ValueError):
                streamed = False
        if not streamed:
            # Some media have the index at the end and need a seekable input.
            part = os.path.join(d, 'audio.m4a.part')
            check_space(d, os.path.getsize(src))
            _, ms = flatten_m4a(src, part)
            n = prepare_mp3(d, part, max(duration, ms / 1000))
        full_done.set()
        emit(ev='audio_ready', bytes=n)
        print(f'audio: full {"streamed" if streamed else "file"} at {time.monotonic() - started:.2f}s', file=sys.stderr, flush=True)
    finally:
        full_done.set()
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        if not proc.stdin.closed:
            try:
                proc.stdin.close()
            except BrokenPipeError:
                pass
        if head is not None:
            head.join()
        try:
            os.unlink(src)
        except FileNotFoundError:
            pass


def decode_pcm(read):
    """Decode an AAC track directly to the daemon's bounded audio pipe."""
    helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mgu-pcm')
    cmd = [helper, '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror',
           '-probesize', '32768', '-analyzeduration', '500000',
           '-i', 'pipe:0', '-map', '0:a:0', '-c:a', 'pcm_s16le',
           '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1']
    # Only FFmpeg owns the write end, so the sink sees EOF when the last PCM arrives.
    with os.fdopen(3, 'wb', buffering=0) as output:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=output)
    try:
        with proc.stdin as pcm_in:
            while True:
                chunk = read(16 << 10)
                if not chunk:
                    break
                pcm_in.write(chunk)
        if proc.wait() != 0:
            raise ValueError('AAC decoder failed')
        emit(ev='pcm_done')
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def dash_pcm(opener, urls, referer, preferred):
    with open_track(opener, urls, referer, 'audio', preferred) as track:
        decode_pcm(track.read_some)


def local_pcm(src):
    with open(src, 'rb') as track:
        decode_pcm(track.read1)


def fetch(d, meta):
    if not ID_RE.fullmatch(str(meta.get('id', ''))):
        raise ValueError('bad video ID')
    os.umask(0o022)
    install_dns(LEASE)
    ctx = ssl.create_default_context(cafile=CA if os.path.isfile(CA) else None)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), CDNRedirect(), urllib.request.HTTPSHandler(context=ctx))
    check_space(d)
    info = {k: meta.get(k) for k in ('id', 'title', 'channel', 'duration_s')}
    with open(os.path.join(d, 'meta.json.tmp'), 'w', encoding='utf-8') as f:
        json.dump(info, f)
    os.replace(os.path.join(d, 'meta.json.tmp'), os.path.join(d, 'meta.json'))
    emit(ev='meta', **info)
    dur_ms = (info['duration_s'] or 0) * 1000
    referer = WEB + 'video/' + info['id'].split('_p')[0] + '/'
    cap = int(meta.get('maxHeight', 1080))
    if cap not in (360, 480, 720, 1080):
        raise ValueError('invalid resolution cap')

    pcm = bool(meta.get('pcm'))
    fast = bool(meta.get('fastCdn'))
    preferred = meta.get('cdnPreferred') or {}
    tick = Throttle(5 if pcm else 2)
    first_buffer = False
    video_track = None
    video_start = None

    def transfer():
        if video_track is not None and fast:
            return dict(wire_bytes=video_track.received,
                        wire_ms=round((time.monotonic() - video_start) * 1000))
        return {}

    def progress(ms, frames, size):
        nonlocal first_buffer
        reached = pcm and not first_buffer and ms >= START_VIDEO_MS
        if reached or tick():
            check_space(d)
            emit(ev='video', ms=ms, frames=frames, bytes=size,
                 pct=min(99, round(ms * 100 / dur_ms)) if dur_ms else 0, **transfer())
        if reached:
            first_buffer = True

    def download(urls, dest):
        tick = Throttle()
        with open_track(opener, urls, referer, 'mp4', preferred.get('mp4')) as track, open(dest, 'wb') as out:
            total, done = max(0, track.left), 0
            while True:
                chunk = track.read_some(64 << 10)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                if tick():
                    check_space(d)
                    emit(ev='audio', pct=min(100, round(done * 100 / total)) if total else 0)

    if meta.get('progressive'):
        src = os.path.join(d, 'fallback.mp4')
        try:
            download(meta['progressive'], src)
            frames, size, ms, _ = unpack_progressive(src, d, cap, progress)
            os.remove(src)
        except (OSError, ValueError, KeyError, struct.error) as e:
            fail('B 站备用 MP4 下载或封装失败 (' + str(e)[:100] + ')')
        emit(ev='video', ms=ms, frames=frames, bytes=size, pct=100)
        emit(ev='video_done')
        try:
            audio = os.path.join(d, 'audio.m4a')
            if pcm:
                local_pcm(audio)
                os.unlink(audio)
            else:
                abytes = prepare_mp3(d, audio, info['duration_s'] or 0)
                emit(ev='audio_ready', bytes=abytes)
        except (OSError, ValueError, subprocess.SubprocessError):
            fail('B 站备用音轨解码失败', pcm_fallback=pcm)
        emit(ev='done')
        return

    def audio():
        try:
            if meta.get('pcm'):
                dash_pcm(opener, meta['audio'], referer, preferred.get('audio'))
            else:
                dash_audio(opener, meta['audio'], referer, d, info['duration_s'] or 0,
                           int(meta.get('resumeMs') or 0), preferred.get('audio'))
        except CdnError as e:
            fail('B 站音轨网络中断 · ' + str(e))
        except (OSError, ValueError, KeyError, struct.error, subprocess.SubprocessError) as e:
            fail('B 站音轨解码失败 (' + type(e).__name__ + ')', pcm_fallback=pcm)

    ta = threading.Thread(target=audio, daemon=True)
    ta.start()
    try:
        video_start = time.monotonic()
        with open_track(opener, meta['video'], referer, 'video', preferred.get('video')) as video_track:
            frames, size, ms = demux_video(video_track, d, progress, cap)
    except (OSError, ValueError, KeyError, struct.error) as e:
        fail('B 站视频下载或封装失败 (' + type(e).__name__ + ')')
    emit(ev='video', ms=ms, frames=frames, bytes=size, pct=100, **transfer())
    emit(ev='video_done')
    ta.join()
    emit(ev='done')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        fail('usage: ytfetch.py <output directory>')
    try:
        fetch(sys.argv[1], json.loads(sys.stdin.readline(256 << 10)))
    except Exception:
        fail('B 站播放数据无效')
