#!/bin/sh
# Build the offline AAC -> MP3 helper from the two supplied LGPL source archives.
set -eu
if [ "$#" -ne 3 ]; then
    echo "Usage: $0 ffmpeg-n7.1.2.tar.gz lame_3.100.orig.tar.gz /absolute/output/mgu-audio" >&2
    exit 2
fi
ffmpeg=$(realpath "$1")
lame=$(realpath "$2")
out=$(realpath -m "$3")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
cd "$work"
tar -xzf "$lame"
cd lame-3.100
CFLAGS='-Os -march=x86-64' ./configure --prefix="$work/prefix" --enable-static --disable-shared --disable-frontend --disable-decoder >"$work/lame.log" 2>&1 || { tail -80 "$work/lame.log" >&2; exit 1; }
make -j"${JOBS:-4}" >>"$work/lame.log" 2>&1 || { tail -80 "$work/lame.log" >&2; exit 1; }
make install >>"$work/lame.log" 2>&1 || { tail -80 "$work/lame.log" >&2; exit 1; }
cd "$work"
tar -xzf "$ffmpeg"
cd FFmpeg-n7.1.2
./configure --disable-everything --disable-autodetect --disable-network --disable-doc --disable-ffplay --disable-ffprobe     --disable-debug --disable-asm --enable-small --enable-ffmpeg --enable-libmp3lame --enable-demuxer=mov     --enable-decoder=aac --enable-encoder=libmp3lame --enable-muxer=mp3 --enable-protocol=file     --enable-filter=aresample,aformat,anull --extra-cflags="-Os -march=x86-64 -I$work/prefix/include"     --extra-ldflags="-static -L$work/prefix/lib" >"$work/ffmpeg.log" 2>&1 || { tail -80 "$work/ffmpeg.log" >&2; tail -50 ffbuild/config.log >&2; exit 1; }
make -j"${JOBS:-4}" ffmpeg >>"$work/ffmpeg.log" 2>&1 || { tail -100 "$work/ffmpeg.log" >&2; exit 1; }
mkdir -p "$(dirname "$out")"
strip -o "$out" ffmpeg
chmod 0755 "$out"
"$out" -version
