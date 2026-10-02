# Audio-hash golden fixtures

`tests/test_audio_content_hash.py::TestAudioContentSha256sum::test_decoded_hash_matches_pinned_value`
pins the `pcm-s16le-16000hz-mono-sha256-v1` hash of each file here. Any ffmpeg
build that reproduces these hashes may hash catalog audio. A build that does
not must not be used until a new algorithm version exists
(`docs/architecture.md`, Content-Addressed Storage).

Never regenerate or replace these files: the pinned hashes describe exactly
these bytes.

| Fixture | Source codec | Covers |
|---|---|---|
| `sine_44100hz_stereo.mp3` | MP3, 44.1 kHz stereo | `mp3float` decode, downmix, resample |
| `sine_44100hz_mono.m4a` | AAC-LC, 44.1 kHz mono | native `aac` decode, resample |
| `sine_48000hz_mono.opus` | Opus, 48 kHz mono | native `opus` decode, resample |

The fixtures were made with ffmpeg 6.1.1-3ubuntu5 from 3-second `lavfi` sine
sources (440 Hz, plus 660 Hz on the second MP3 channel). The encoders were
`libmp3lame` at 64k, native `aac` at 64k, and `libopus` at 32k.

## Checking a build

```bash
PATH=/dir/with/candidate/ffmpeg:$PATH uv run pytest tests/test_audio_content_hash.py -k pinned -v
```

When it passes, add the build to the list below with its full `ffmpeg -version`
output. When it fails, the hashes of existing catalog audio would change. As a
stronger check after any upgrade, recompute a sample of real catalog hashes and
compare them with the catalog's `Hash` column.

Builds that pick a different decoder fail these tests even at the same version.
Both builds below use the native `aac` and `opus` decoders, even though the
prod build also has `libfdk-aac` and `libopus`.

## Known-good builds

The easiest reproducible fallback is Ubuntu 24.04's apt package
(`docker run --rm -it ubuntu:24.04`, then `apt-get update && apt-get install ffmpeg`).

### ffmpeg 6.1.1-3ubuntu5 (Ubuntu 24.04 apt, also used by CI)

Verified 2026-10-02.

```text
ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers
built with gcc 13 (Ubuntu 13.2.0-23ubuntu3)
configuration: --prefix=/usr --extra-version=3ubuntu5 --toolchain=hardened --libdir=/usr/lib/x86_64-linux-gnu --incdir=/usr/include/x86_64-linux-gnu --arch=amd64 --enable-gpl --disable-stripping --disable-omx --enable-gnutls --enable-libaom --enable-libass --enable-libbs2b --enable-libcaca --enable-libcdio --enable-libcodec2 --enable-libdav1d --enable-libflite --enable-libfontconfig --enable-libfreetype --enable-libfribidi --enable-libglslang --enable-libgme --enable-libgsm --enable-libharfbuzz --enable-libmp3lame --enable-libmysofa --enable-libopenjpeg --enable-libopenmpt --enable-libopus --enable-librubberband --enable-libshine --enable-libsnappy --enable-libsoxr --enable-libspeex --enable-libtheora --enable-libtwolame --enable-libvidstab --enable-libvorbis --enable-libvpx --enable-libwebp --enable-libx265 --enable-libxml2 --enable-libxvid --enable-libzimg --enable-openal --enable-opencl --enable-opengl --disable-sndio --enable-libvpl --disable-libmfx --enable-libdc1394 --enable-libdrm --enable-libiec61883 --enable-chromaprint --enable-frei0r --enable-ladspa --enable-libbluray --enable-libjack --enable-libpulse --enable-librabbitmq --enable-librist --enable-libsrt --enable-libssh --enable-libsvtav1 --enable-libx264 --enable-libzmq --enable-libzvbi --enable-lv2 --enable-sdl2 --enable-libplacebo --enable-librav1e --enable-pocketsphinx --enable-librsvg --enable-libjxl --enable-shared
libavutil      58. 29.100 / 58. 29.100
libavcodec     60. 31.102 / 60. 31.102
libavformat    60. 16.100 / 60. 16.100
libavdevice    60.  3.100 / 60.  3.100
libavfilter     9. 12.100 /  9. 12.100
libswscale      7.  5.100 /  7.  5.100
libswresample   4. 12.100 /  4. 12.100
libpostproc    57.  3.100 / 57.  3.100
```

### ffmpeg git 2790dd6 (prod host, `/usr/local/bin/ffmpeg`, built from source)

Verified 2026-10-02. This was the `ffmpeg` on `PATH` on the prod host at that
date.

```text
ffmpeg version 2790dd6 Copyright (c) 2000-2025 the FFmpeg developers
built with gcc 13 (Ubuntu 13.3.0-6ubuntu2~24.04)
configuration: --prefix=/usr/local --enable-gpl --enable-nonfree --enable-version3 --enable-libfdk-aac --enable-libx264 --enable-libx265 --enable-libvpx --enable-libmp3lame --enable-libopus --enable-libvorbis --enable-libaom --enable-libdav1d --enable-libass --enable-libbs2b --enable-libcaca --enable-libcdio --enable-libcodec2 --enable-libfontconfig --enable-libfreetype --enable-libfribidi --enable-libgme --enable-libgsm --enable-libharfbuzz --enable-libjxl --enable-libopencore-amrnb --enable-libopencore-amrwb --enable-librav1e --enable-librubberband --enable-libshine --enable-libsnappy --enable-libsoxr --enable-libspeex --enable-libsrt --enable-libssh --enable-libtheora --enable-libtwolame --enable-libvidstab --enable-libwebp --enable-libxml2 --enable-libxvid --enable-libzimg --enable-libzmq --enable-libzvbi --enable-libbluray --enable-librist --enable-librsvg --enable-sdl2 --enable-opengl --extra-cflags=-I/usr/local/include --extra-ldflags=-L/usr/local/lib
libavutil      60.  8.100 / 60.  8.100
libavcodec     62. 11.100 / 62. 11.100
libavformat    62.  3.100 / 62.  3.100
libavdevice    62.  1.100 / 62.  1.100
libavfilter    11.  4.100 / 11.  4.100
libswscale      9.  1.100 /  9.  1.100
libswresample   6.  1.100 /  6.  1.100
```
