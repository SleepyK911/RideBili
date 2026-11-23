# RideBili service

The service runs on the BMW ID7 system Node and uses the stock RideTube x86-64 video decoder, installed as `bili-dec`. The original RideTube service and RideBili share the BMW MediaPlayer source and decoder frame path. The daemon and browsing remain available when the original service is installed. Playback reports the conflict until the original service is removed in MGU Store.

The application uses JSON lines on `/run/ride-bili-d/ctl.sock`. Bilibili API calls and thumbnail decoding run as the uplink UID under the bundled Node 22. The Python fetcher also runs as the uplink UID. It takes validated CDN URLs on stdin, downloads H.264/AAC DASH tracks or a public progressive MP4 fallback, and writes `video.h264` and `index.bin`.

With `pcm: true`, `mgu-pcm` decodes the DASH audio track or the AAC track extracted from a progressive MP4. It sends 48 kHz stereo samples over a bounded pipe to `pcmout.py`. The app handles `pcm_route` and `pcm_release` messages through its OAP AudioManager proxies and replies with the matching token. The sink subtracts the ALSA queue delay from its frame count to drive the video clock. It releases the PCM device on stop. The app disconnects the AudioManager connection it acquired.

The compatibility path encodes AAC with FFmpeg/LAME and stages finished MP3s for BMW MediaPlayer. Long tracks can publish one independently finalized short MP3, then switch to the full file at the same playback position. Seek and resume restart PCM at the requested position, with the audio clock offset to match. The compatibility path is selected explicitly. A PCM failure ends that session and reports the error. Account cookies stay in a root-only local file. Quit the session from the app menu before uninstalling.

The build takes a hash-verified upstream `jap-ridetube-d@0.3.8.tgz`, extracts the decoder, and packs a tool artifact through MGU Store. See the repository README for the commands.
