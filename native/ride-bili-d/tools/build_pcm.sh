#!/bin/sh
# Build the offline AAC -> stereo PCM helper from the supplied LGPL archive.
set -eu
if [ "$#" -ne 2 ]; then
    echo "Usage: $0 ffmpeg-n7.1.2.tar.gz /absolute/output/mgu-pcm" >&2
    exit 2
fi
ffmpeg=$(realpath "$1")
out=$(realpath -m "$2")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
cd "$work"
tar -xzf "$ffmpeg"
cd FFmpeg-n7.1.2
./configure --disable-everything --disable-autodetect --disable-network --disable-doc \
    --disable-ffplay --disable-ffprobe --disable-debug --disable-asm --enable-small \
    --enable-ffmpeg --enable-demuxer=mov --enable-decoder=aac --enable-encoder=pcm_s16le \
    --enable-muxer=pcm_s16le --enable-protocol=pipe --enable-filter=aresample,aformat,anull \
    --extra-cflags='-Os -march=x86-64' --extra-ldflags=-static >"$work/build.log" 2>&1 ||
    { tail -80 "$work/build.log" >&2; tail -50 ffbuild/config.log >&2; exit 1; }
make -j"${JOBS:-4}" ffmpeg >>"$work/build.log" 2>&1 ||
    { tail -100 "$work/build.log" >&2; exit 1; }
mkdir -p "$(dirname "$out")"
strip -o "$out" ffmpeg
chmod 0755 "$out"
"$out" -version
