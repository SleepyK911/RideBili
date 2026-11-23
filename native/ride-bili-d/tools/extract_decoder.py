#!/usr/bin/env python3
"""Extract and verify the decoder from the official RideTube 0.3.8 service artifact."""
import argparse
import hashlib
from pathlib import Path
import tarfile

SERVICE_SHA256 = '627db11ddd499581f84f79f9c3fdd7fb868ac8399bdf0f7c4660d77f4a317147'
DECODER_SHA256 = '15a9c75d2a19e3cafda3f5a8d0f7eb706a12c90ca90f5b60f1253d25749dd2eb'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('service_package', type=Path)
    a = p.parse_args()
    if hashlib.sha256(a.service_package.read_bytes()).hexdigest() != SERVICE_SHA256:
        p.error('RideTube upstream archive digest mismatch')
    with tarfile.open(a.service_package, 'r:gz') as t:
        data = t.extractfile('files/ytdec').read()
    if hashlib.sha256(data).hexdigest() != DECODER_SHA256:
        p.error('decoder digest mismatch')
    out = Path(__file__).resolve().parents[1] / 'build' / 'ytdec'
    out.parent.mkdir(exist_ok=True)
    out.write_bytes(data)
    print(out)


if __name__ == '__main__':
    main()
