"""Refuse to hash catalog audio with an ffmpeg that does not reproduce the pinned hashes.

Lossy decoders and the resampler are not bit-exact across ffmpeg versions,
builds or even CPU feature sets, so the same file can get a different
`pcm-s16le-16000hz-mono-sha256-v1` hash on another host. Before an ffmpeg
binary hashes anything, it decodes the fixtures in `audio_hash_fixtures/`
(the codec, rate and container mixes found in the prod catalog) and must
reproduce `PINNED_HASHES` exactly. See `audio_hash_fixtures/README.md`.
"""

from __future__ import annotations

import os
import shutil
import threading
from collections.abc import Callable
from pathlib import Path

FIXTURES_DIR = Path(__file__).with_name("audio_hash_fixtures")
SKIP_ENV = "BESEDY_SKIP_HASH_DECODER_CHECK"

# Never change these without a new audio-hash algorithm version: they describe
# exactly the bytes in FIXTURES_DIR as decoded by the known-good builds.
PINNED_HASHES: dict[str, str] = {
    "talk_44100hz_stereo_vbr_cover.mp3": (
        "ae87fc2006610b8413f7d1c5987db4739a523c87e30d3ae3c2ce5becf917c9d4"
    ),
    "talk_48000hz_mono.mp3": "00f3fdbaa04e22bc2039ac546fabeb0a199d6b7f9c70b1ebdae250756fb05e97",
    "talk_32000hz_stereo.mp3": "4d9fee2b9c85b64e214042fc7a033811b483120b2ea0d2767da3686923066261",
    "talk_16000hz_stereo.mp3": "83dc5f6715d3ee6f3849bff47bc5fbcbed6ce1d62e09e8689cb2ec0d03be5607",
    "talk_44100hz_mono.m4a": "5289065e09090ca3841e0806470dee4a8e382ef5c3092c59fdee3695a24530cb",
    "talk_22050hz_mono.m4a": "4f6a1c2cec1f9c609310518edb8cc1c104fb8fe744f3d778e43ef9ea1efbb049",
    "talk_48000hz_stereo_video.mp4": (
        "ac07348cf28c1bfa5cf06092a3598e8e91fed6b80831be2ca6fa27cc110b5fc9"
    ),
    "talk_48000hz_stereo_voip.mkv": (
        "ab0f8f404627b7c75af1cad7427b54dd8ab5d3741fd90e76c82735c1f43fe77e"
    ),
}


class HashDecoderMismatchError(Exception):
    """This ffmpeg would give catalog audio different hashes than the pinned builds.

    Deliberately not a RuntimeError or OSError, which callers treat as a
    per-file failure: no file may be hashed with this build.
    """


_lock = threading.Lock()
_verified: set[tuple[str, int, int]] = set()


def require_reproducible_hash_decoder(
    ffmpeg_binary: str,
    decode: Callable[[Path, str], str | None],
) -> None:
    """Raise `HashDecoderMismatchError` unless ``ffmpeg_binary`` reproduces the pins.

    ``decode(path, ffmpeg_binary)`` is the unchecked hash function. A binary is
    checked once per process, keyed by its resolved path, size and mtime, so
    replacing it in place is checked again. An ffmpeg that is not found is left
    to the decode itself, which reports the file as undecodable.
    """
    if os.environ.get(SKIP_ENV) == "1":
        return
    resolved = shutil.which(ffmpeg_binary)
    if resolved is None:
        return
    real = os.path.realpath(resolved)
    stat = os.stat(real)
    key = (real, stat.st_size, stat.st_mtime_ns)
    with _lock:
        if key in _verified:
            return
        mismatched = [
            name
            for name, expected in PINNED_HASHES.items()
            if decode(FIXTURES_DIR / name, ffmpeg_binary) != expected
        ]
        if mismatched:
            raise HashDecoderMismatchError(
                f"{real} does not reproduce the pinned audio hashes of "
                f"{len(mismatched)}/{len(PINNED_HASHES)} fixtures ({', '.join(mismatched)}), "
                "so it would give catalog audio different identities than the known-good "
                f"builds. Use a build listed in {FIXTURES_DIR / 'README.md'}, or set "
                f"{SKIP_ENV}=1 for a throwaway catalog that never meets real ones."
            )
        _verified.add(key)
