#!/usr/bin/env bash
# Provenance record for the audio-hash golden fixtures in this directory.
#
# Do NOT rerun this to refresh the committed fixtures: encoders change between
# ffmpeg builds, so the output bytes (and therefore the pinned hashes) would
# change. The script exists so the fixtures can be audited and, if a new set is
# ever needed, rebuilt the same way. Writes into the directory given as $1.
#
# Source: LibriVox recording of "Krysař" by Viktor Dyk, chapter 2, read in
# Czech by Kudrna. Public Domain Mark 1.0:
# https://archive.org/details/krysar_2007_librivox
set -euo pipefail

out=${1:?usage: generate.sh <output-dir>}
ffmpeg=${FFMPEG:-ffmpeg}
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

src="$work/krysar_02_dyk.mp3"
curl -sSfL -o "$src" https://archive.org/download/krysar_2007_librivox/krysar_02_dyk.mp3
echo "36db80d9253f6820e054ea3408d1e73241b25f24fc186ebc05373fe4765187bc  $src" | sha256sum -c -

ff() { "$ffmpeg" -nostdin -hide_banner -loglevel error -y "$@"; }

# Master: 7.75 s of 44.1 kHz stereo float. Left and right differ throughout
# so the stereo-to-mono downmix shows up in the hash.
#   0.00-4.50  speech (L dry, R with a room echo)
#   4.50-4.75  digital silence
#   4.75-5.75  exponential sweep 30 Hz-21 kHz (L up, R down), above the
#              8 kHz Nyquist of the 16 kHz target, so the resampler's
#              anti-alias filter shapes it
#   5.75-6.25  seeded pink noise, different seed per channel
#   6.25-6.75  20 Hz click train (transients force block switching)
#   6.75-7.75  speech boosted 12 dB (overs clip in the s16 conversion)
sweep='sin(2*PI*30*1/log(700)*(exp(t*log(700))-1))'
sweep_down='sin(2*PI*30*1/log(700)*(exp((1-t)*log(700))-1))'
ff -ss 23.5 -t 5.5 -i "$src" \
  -f lavfi -i "anullsrc=r=44100:cl=stereo:d=0.25" \
  -f lavfi -i "aevalsrc=0.5*${sweep}|0.5*${sweep_down}:s=44100:d=1" \
  -f lavfi -i "anoisesrc=c=pink:seed=236:a=0.25:r=44100:d=0.5" \
  -f lavfi -i "anoisesrc=c=pink:seed=237:a=0.25:r=44100:d=0.5" \
  -f lavfi -i "aevalsrc=if(lt(mod(t\,0.05)\,1/44100)\,0.9\,0)|if(lt(mod(t-0.025\,0.05)\,1/44100)\,-0.9\,0):s=44100:d=0.5" \
  -filter_complex "
    [0:a]aresample=44100,pan=mono|c0=0.5*c0+0.5*c1,asplit=3[sp][sr][hot];
    [sp]atrim=0:4.5,asetpts=N/SR/TB[spl];
    [sr]atrim=0:4.5,asetpts=N/SR/TB,aecho=0.8:0.6:37:0.35,highpass=f=120[spr];
    [spl][spr]join=inputs=2:channel_layout=stereo[speech];
    [3:a][4:a]join=inputs=2:channel_layout=stereo[noise];
    [hot]atrim=4.5:5.5,asetpts=N/SR/TB,volume=12dB,asplit[hl][hr];
    [hr]adelay=3[hrd];
    [hl][hrd]join=inputs=2:channel_layout=stereo,atrim=0:1[loud];
    [speech][1:a][2:a][noise][5:a][loud]concat=n=6:v=0:a=1,
      afade=t=in:d=0.01,afade=t=out:st=7.7:d=0.05[mix]" \
  -map "[mix]" -c:a pcm_f32le "$work/master.wav"

# A small JPEG to embed as cover art, like 34 of the prod catalog's MP3s.
ff -f lavfi -i "testsrc2=s=96x96:d=1" -frames:v 1 "$work/cover.jpg"

# One fixture per decode/resample path that occurs in the prod catalog.
ff -i "$work/master.wav" -i "$work/cover.jpg" -map 0:a -map 1:v \
  -c:a libmp3lame -q:a 4 -ar 44100 -ac 2 -c:v copy -disposition:v attached_pic \
  -metadata title="Krysař, kapitola 2" -metadata artist="Viktor Dyk" -id3v2_version 3 \
  "$out/talk_44100hz_stereo_vbr_cover.mp3"
ff -i "$work/master.wav" -c:a libmp3lame -b:a 48k -ar 48000 -ac 1 "$out/talk_48000hz_mono.mp3"
ff -i "$work/master.wav" -c:a libmp3lame -b:a 48k -ar 32000 -ac 2 "$out/talk_32000hz_stereo.mp3"
ff -i "$work/master.wav" -c:a libmp3lame -b:a 32k -ar 16000 -ac 2 "$out/talk_16000hz_stereo.mp3"
ff -i "$work/master.wav" -c:a aac -b:a 64k -ar 44100 -ac 1 "$out/talk_44100hz_mono.m4a"
ff -i "$work/master.wav" -c:a aac -b:a 32k -ar 22050 -ac 1 "$out/talk_22050hz_mono.m4a"
ff -i "$work/master.wav" -f lavfi -i "color=c=black:s=64x64:r=2:d=7.75" -map 0:a -map 1:v \
  -c:a aac -b:a 96k -ar 48000 -ac 2 -c:v libx264 -preset veryslow -crf 51 -pix_fmt yuv420p \
  -shortest "$out/talk_48000hz_stereo_video.mp4"
ff -i "$work/master.wav" -c:a libopus -b:a 24k -application voip -ar 48000 -ac 2 \
  "$out/talk_48000hz_stereo_voip.mkv"
