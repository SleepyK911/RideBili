#!/bin/sh
set -eu
d=$(cd "$(dirname "$0")" && pwd)
/var/opt/mgu-python/current/bin/python3 -I -c 'import ast, pathlib, sys; [ast.parse(pathlib.Path(f).read_text(encoding="utf-8")) for f in sys.argv[1:]]' "$d/ytfetch.py" "$d/pcmout.py"
"$d/mgu-audio" -version >/dev/null
"$d/mgu-pcm" -version >/dev/null
exec /var/opt/jap-node22/current/bin/node -e 'require(process.argv[1] + "/bili.js"); require(process.argv[1] + "/thumb.js"); require(process.argv[1] + "/realtime.js")' "$d"
