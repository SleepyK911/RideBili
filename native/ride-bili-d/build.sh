#!/bin/sh
# Usage: MGU_STORE=/path/to/mgu-store ./build.sh /path/to/jap-ridetube-d@0.3.8.tgz
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${MGU_STORE:?set MGU_STORE to a checkout of robertnisipeanu/mgu-store}"
test "$#" = 1
[ -x "$here/build/mgu-audio" ] || { echo "Build mgu-audio with tools/build_audio.sh first" >&2; exit 1; }
[ -x "$here/build/mgu-pcm" ] || { echo "Build mgu-pcm with tools/build_pcm.sh first" >&2; exit 1; }
"${PYTHON:-python3}" "$here/tools/extract_decoder.py" "$1"
node "$MGU_STORE/deploy/hu" artifact "$here" --out "$here/dist"
