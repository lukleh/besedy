#!/usr/bin/env python3
"""One-off faster-whisper transcription without catalog registration."""

from __future__ import annotations

from besedy.commands import transcribe_oneoff


def main(argv: list[str] | None = None) -> int:
    return transcribe_oneoff.handle_transcribe_oneoff(transcribe_oneoff.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
