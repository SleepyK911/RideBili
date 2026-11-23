#!/usr/bin/env python3
"""Bake a compact GB2312 level-one atlas from Noto Sans SC."""
import argparse
import json
import os
from pathlib import Path
import re

from bake_fonts import TEXT, bake


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('font', type=Path)
    args = parser.parse_args()
    source = args.font.resolve()
    os.environ['FONTDIR'] = str(source.parent)
    import bake_fonts
    bake_fonts.FONTDIR = str(source.parent)
    root = Path(__file__).resolve().parents[2]
    common = []
    for lead in range(0xb0, 0xd8):
        for trail in range(0xa1, 0xff):
            try:
                common.append(bytes([lead, trail]).decode('gb2312'))
            except UnicodeDecodeError:
                pass
    ui = ''.join((root / 'apps' / 'ride_bili' / n).read_text(encoding='utf-8') for n in ('main.js', 'app.json', 'yt.js'))
    extra = ''.join(sorted(set(re.findall(r'[\u00a0\u3000-\u9fff\uff00-\uffef]', ui)))) + '，。、！？（）【】「」：；·□'
    atlas = bake(source.name, None, 20, TEXT + extra + ''.join(common))
    if atlas['atlasW'] > 1024 or atlas['atlasH'] > 2048:
        raise ValueError('atlas exceeds renderer budget')
    p = root / 'kit' / 'runtime' / 'fonts' / 'cjk.json'
    p.write_text(json.dumps({'family': 'cjk', 'source': 'Noto Sans SC', 'sizes': [atlas]}, separators=(',', ':')), encoding='utf-8')
    print('CJK atlas', atlas['atlasW'], atlas['atlasH'], len(atlas['glyphs']))


if __name__ == '__main__':
    main()
