# Audio-hash golden fixtures

`tests/test_audio_content_hash.py::TestAudioContentSha256sum::test_decoded_hash_matches_pinned_value`
pins the `pcm-s16le-16000hz-mono-sha256-v1` hash of each file here. Any ffmpeg
build that reproduces these hashes may hash catalog audio. A build that does
not must not be used until a new algorithm version exists
(`docs/architecture.md`, Content-Addressed Storage).

Never regenerate or replace these files: the pinned hashes describe exactly
these bytes.

## What the fixtures contain

All eight are encoded from one 7.75 s, 44.1 kHz stereo master. Its left and
right channels differ throughout, so the stereo-to-mono downmix shows up in the
hash. The master runs through these sections:

| Time (s) | Content | What it exercises |
|---|---|---|
| 0.00–4.50 | Czech speech: left dry, right with a room echo | real speech spectra, downmix of unlike channels |
| 4.50–4.75 | digital silence | zero handling, and Opus/AAC quiet-frame modes |
| 4.75–5.75 | exponential sweep 30 Hz–21 kHz, left up and right down | the resampler's anti-alias low-pass (the target's Nyquist is 8 kHz) |
| 5.75–6.25 | seeded pink noise, different per channel | broadband content |
| 6.25–6.75 | 20 Hz click train, opposite polarity per channel | transients, which force block/window switching |
| 6.75–7.75 | speech boosted 12 dB | overs that clip in the s16 conversion |

The speech is chapter 2 of the LibriVox recording of *Krysař* by Viktor Dyk,
read in Czech by Kudrna. It is under the Public Domain Mark 1.0:
<https://archive.org/details/krysar_2007_librivox>. `generate.sh` records how
the files were made, using ffmpeg 6.1.1-3ubuntu5 on 2026-10-02. Rerunning it
writes new bytes and new hashes, so use it only to build a new set.

Each fixture matches a decode and resample path that occurs in the prod catalog
as of 2026-10-02 (252 recordings):

| Fixture | Prod catalog counterpart |
|---|---|
| `talk_44100hz_stereo_vbr_cover.mp3` | MP3 44.1 kHz stereo (71); embedded cover art like 34 of the MP3s (`-vn`) |
| `talk_48000hz_mono.mp3` | MP3 48 kHz mono (26); 3:1 resample |
| `talk_32000hz_stereo.mp3` | MP3 32 kHz (4); 2:1 resample |
| `talk_16000hz_stereo.mp3` | MP3 16 kHz (26); downmix only, no resample |
| `talk_44100hz_mono.m4a` | AAC-LC 44.1 kHz mono (41); MP4 edit-list priming trim |
| `talk_22050hz_mono.m4a` | AAC-LC 22.05 kHz (1); odd resample ratio |
| `talk_48000hz_stereo_video.mp4` | AAC-LC 48 kHz stereo (11); an H.264 track like 4 of the 5 MP4s (`-vn`) |
| `talk_48000hz_stereo_voip.mkv` | Opus 48 kHz stereo (8: 6 Matroska/WebM, 2 Ogg); low-bitrate speech mode |

The AAC fixtures decode to slightly more than 7.75 s, and the MP3 and Opus
fixtures to exactly 7.75 s. Encoder-delay and padding trimming has changed
between ffmpeg versions, so the pinned hashes cover it as well.

ffmpeg git `2790dd6` prints `Error parsing Opus packet header.` after the last
packet of the MKV fixture. It still exits 0 and produces the same PCM as
6.1.1. The real prod Opus files don't trigger it.

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
