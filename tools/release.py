#!/usr/bin/env python3
"""Stage the RideBili schema-2 catalog for a USB drive."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
APP = 'ride_bili'
DAEMON = 'ride-bili-d'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('usb', type=Path)
    a = p.parse_args()
    out = a.usb / 'mgu-repo' / 'ridebili'
    out.mkdir(parents=True, exist_ok=True)
    src = ROOT / 'apps' / APP
    app = read(src / 'app.json')
    tool = ROOT / 'native' / DAEMON
    daemon = read(tool / 'component.json')
    comps = []
    for spec, kind, dist in ((app, 'app', ROOT / 'dist'), (daemon, 'tool', tool / 'dist')):
        name = f"{spec['id']}@{spec['version']}.tgz"
        dst = out / name
        shutil.copyfile(dist / name, dst)
        c = {k: spec[k] for k in ('id', 'title', 'description', 'version')}
        c.update(kind=kind, artifact={'name': name, 'size': dst.stat().st_size, 'sha256': sha(dst), 'url': name},
                 uninstallable=True, mguHmi=['ID7'])
        if kind == 'app':
            icon = out / 'ride_bili.png'
            shutil.copyfile(src / 'icon.png', icon)
            c.update(requires={DAEMON: daemon['version'], 'mgu-render': '0.6.16', 'mgu-inputgate': '1.0.0'},
                     icon=icon.name, iconSha256=sha(icon))
        else:
            c['requires'] = daemon['requires']
        comps.append(c)
    (out / 'catalog.json').write_text(json.dumps({'schema': 2, 'components': comps}, ensure_ascii=False, indent=2) + '\n',
                                      encoding='utf-8', newline='\n')


if __name__ == '__main__':
    main()
