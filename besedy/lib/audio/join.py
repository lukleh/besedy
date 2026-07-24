"""Audio joining utilities for concatenating multiple audio files.

This module provides:
- Audio file probing (codec, sample rate, channels, bitrate, metadata)
- Join strategy determination (stream copy vs reencode)
- FFmpeg command building for concatenation with optional fades
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

# Lossless audio codecs that don't constrain bitrate ceiling
LOSSLESS_CODECS = frozenset(
    {
        "pcm_s16le",
        "pcm_s24le",
        "pcm_s32le",
        "pcm_f32le",
        "pcm_f64le",
        "flac",
        "alac",
        "wavpack",
        "ape",
        "tak",
    }
)

# Format extensions mapping
FORMAT_EXTENSIONS = {
    "opus": ".opus",
    "mp3": ".mp3",
    "m4a": ".m4a",
    "aac": ".m4a",
    "flac": ".flac",
    "wav": ".wav",
    "ogg": ".ogg",
}

# Codec name to format mapping
CODEC_TO_FORMAT = {
    "mp3": "mp3",
    "aac": "m4a",
    "opus": "opus",
    "vorbis": "ogg",
    "flac": "flac",
    "pcm_s16le": "wav",
    "pcm_s24le": "wav",
    "pcm_s32le": "wav",
}

# Default bitrate for Opus (kbps) - good for speech
DEFAULT_OPUS_BITRATE = 64

# Maximum bitrate for Opus (kbps) - 128 is plenty for speech/discussion recordings
MAX_OPUS_BITRATE = 128

# Opus supported sample rates (must use one of these)
OPUS_SUPPORTED_RATES = frozenset({48000, 24000, 16000, 12000, 8000})


@dataclass
class AudioFileInfo:
    """Audio file properties extracted from ffprobe."""

    path: Path
    codec: str  # e.g., "mp3", "aac", "pcm_s16le"
    sample_rate: int  # e.g., 44100, 48000
    channels: int  # 1 or 2
    bitrate_kbps: int | None  # None for lossless
    duration_seconds: float
    is_lossless: bool
    # Metadata
    title: str | None = None
    artist: str | None = None
    album: str | None = None
    date: str | None = None
    genre: str | None = None
    comment: str | None = None


@dataclass
class JoinMetadata:
    """Resolved metadata for joined output."""

    title: str | None
    artist: str | None
    album: str | None
    date: str | None
    genre: str | None
    comment: str


@dataclass
class JoinStrategy:
    """Determined joining strategy."""

    method: str  # "stream_copy" or "reencode"
    output_format: str  # e.g., "opus", "mp3"
    sample_rate: int
    channels: int
    bitrate_kbps: int
    use_fades: bool


def probe_audio_file(
    path: Path,
    *,
    ffprobe_binary: str = "ffprobe",
    timeout: int = 30,
) -> AudioFileInfo:
    """Extract audio file properties using ffprobe.

    Args:
        path: Path to the audio file.
        ffprobe_binary: Path to ffprobe executable.
        timeout: Timeout in seconds.

    Returns:
        AudioFileInfo with extracted properties.

    Raises:
        FileNotFoundError: If file doesn't exist.
        RuntimeError: If ffprobe fails or no audio stream found.
    """
    if not path.exists():
        raise FileNotFoundError(f"Audio file not found: {path}")

    ffprobe = shutil.which(ffprobe_binary) or ffprobe_binary
    cmd = [
        ffprobe,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            check=True,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"ffprobe timed out after {timeout}s for {path}") from exc
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode("utf-8", errors="replace") if exc.stderr else ""
        raise RuntimeError(f"ffprobe failed for {path}: {stderr}") from exc

    stdout = result.stdout.decode("utf-8", errors="replace")
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"ffprobe returned invalid JSON for {path}") from exc

    # Find first audio stream
    audio_stream = None
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "audio":
            audio_stream = stream
            break

    if not audio_stream:
        raise RuntimeError(f"No audio stream found in {path}")

    codec = audio_stream.get("codec_name", "unknown")
    is_lossless = codec in LOSSLESS_CODECS

    # Extract sample rate
    sample_rate_raw = audio_stream.get("sample_rate")
    try:
        sample_rate = int(sample_rate_raw)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"Invalid sample rate for {path}: {sample_rate_raw}") from exc

    # Extract channels
    channels_raw = audio_stream.get("channels")
    try:
        channels = int(channels_raw)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"Invalid channel count for {path}: {channels_raw}") from exc

    # Extract bitrate (from audio stream only, not container)
    # Container bitrate includes video which is misleading for audio join
    bitrate_kbps = None
    bitrate_raw = audio_stream.get("bit_rate")

    # Only fall back to format bitrate if there's no video stream
    # (i.e., it's a pure audio file where container bitrate = audio bitrate)
    if not bitrate_raw:
        has_video = any(s.get("codec_type") == "video" for s in data.get("streams", []))
        if not has_video and "format" in data:
            bitrate_raw = data["format"].get("bit_rate")

    if bitrate_raw:
        try:
            bitrate_kbps = int(float(bitrate_raw)) // 1000
        except (TypeError, ValueError):
            pass

    # Extract duration (from format)
    duration_raw = data.get("format", {}).get("duration")
    try:
        duration_seconds = float(duration_raw)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"Invalid duration for {path}: {duration_raw}") from exc

    # Extract metadata from format tags
    tags = data.get("format", {}).get("tags", {})
    # Tags can be case-insensitive, check common variations
    title = tags.get("title") or tags.get("TITLE")
    artist = tags.get("artist") or tags.get("ARTIST")
    album = tags.get("album") or tags.get("ALBUM")
    date = tags.get("date") or tags.get("DATE")
    genre = tags.get("genre") or tags.get("GENRE")
    comment = tags.get("comment") or tags.get("COMMENT")

    return AudioFileInfo(
        path=path,
        codec=codec,
        sample_rate=sample_rate,
        channels=channels,
        bitrate_kbps=bitrate_kbps,
        duration_seconds=duration_seconds,
        is_lossless=is_lossless,
        title=title,
        artist=artist,
        album=album,
        date=date,
        genre=genre,
        comment=comment,
    )


def check_stream_copy_compatible(files: list[AudioFileInfo]) -> bool:
    """Check if all files can be stream-copied (identical codec, rate, channels)."""
    if len(files) < 2:
        return True

    first = files[0]
    for f in files[1:]:
        if f.codec != first.codec:
            return False
        if f.sample_rate != first.sample_rate:
            return False
        if f.channels != first.channels:
            return False

    return True


def _resolve_metadata_field(values: list[str | None]) -> str | None:
    """If all non-empty values match, use it. Otherwise use first non-empty."""
    non_empty = [v for v in values if v]
    if not non_empty:
        return None
    if len(set(non_empty)) == 1:
        return non_empty[0]
    return non_empty[0]


def _find_best_opus_sample_rate(target_rate: int) -> int:
    """Find the best Opus sample rate for the given target rate.

    Opus only supports specific sample rates: 48000, 24000, 16000, 12000, 8000 Hz.
    We pick the closest supported rate that is >= target, or 48000 if target is higher.
    """
    if target_rate in OPUS_SUPPORTED_RATES:
        return target_rate

    # Find the smallest supported rate >= target, or use 48000
    candidates = [r for r in OPUS_SUPPORTED_RATES if r >= target_rate]
    if candidates:
        return min(candidates)

    # If target is higher than all supported rates, use 48000 (highest)
    return 48000


def _escape_comment(text: str | None) -> str:
    """Escape a comment for inclusion in joined metadata.

    Replaces newlines with literal \\n and strips leading/trailing whitespace.
    """
    if not text:
        return ""
    return text.strip().replace("\n", "\\n").replace("\r", "")


def _build_join_decision(
    files: list[AudioFileInfo],
    strategy: "JoinStrategy",
) -> str:
    """Build the strategy line describing what transformations were applied.

    Returns one of:
    - "STRATEGY:copy" - stream copy, no re-encoding
    - "STRATEGY:fades" - re-encode only for fade transitions (params were compatible)
    - "STRATEGY:reencode|..." - re-encode with parameter changes listed
    """
    if strategy.method == "stream_copy":
        return "STRATEGY:copy"

    # Check if files were stream-copy compatible (same codec, rate, channels)
    is_compatible = check_stream_copy_compatible(files)

    if is_compatible and strategy.use_fades:
        # Re-encoded only because of fades
        return "STRATEGY:fades"

    # Build list of changes
    changes = []

    # Check sample rate changes
    source_rates = {f.sample_rate for f in files}
    if len(source_rates) > 1 or strategy.sample_rate not in source_rates:
        rates_str = ",".join(str(r) for r in sorted(source_rates))
        changes.append(f"sr:{rates_str}→{strategy.sample_rate}")

    # Check channel changes
    source_channels = {f.channels for f in files}
    if len(source_channels) > 1 or strategy.channels not in source_channels:
        ch_str = ",".join(str(c) for c in sorted(source_channels))
        changes.append(f"ch:{ch_str}→{strategy.channels}")

    # Check codec/format changes
    source_codecs = {f.codec for f in files}
    target_format = strategy.output_format
    if len(source_codecs) > 1:
        changes.append(f"fmt:mixed→{target_format}")
    elif CODEC_TO_FORMAT.get(files[0].codec, files[0].codec) != target_format:
        changes.append(f"fmt:{files[0].codec}→{target_format}")

    # Check bitrate (only for lossy)
    source_bitrates = {f.bitrate_kbps for f in files if f.bitrate_kbps}
    if source_bitrates and strategy.bitrate_kbps not in source_bitrates:
        br_str = ",".join(str(b) for b in sorted(source_bitrates))
        changes.append(f"br:{br_str}→{strategy.bitrate_kbps}")

    if changes:
        return "STRATEGY:reencode|" + "|".join(changes)
    elif strategy.use_fades:
        return "STRATEGY:fades"
    else:
        return "STRATEGY:reencode"


def resolve_join_metadata(
    files: list[AudioFileInfo],
    *,
    source_hashes: list[str] | None = None,
    strategy: "JoinStrategy | None" = None,
    title_override: str | None = None,
    artist_override: str | None = None,
    album_override: str | None = None,
) -> JoinMetadata:
    """Resolve metadata for joined output from source files.

    Strategy for each field:
    1. Use override if provided
    2. If all non-empty values match, use that value
    3. If values differ, use first file's value
    4. If all empty, leave None

    Args:
        files: List of source audio files.
        source_hashes: List of SHA-256 hashes for each source file (same order as files).
        strategy: Join strategy with method and target properties.
        title_override: Override for title tag.
        artist_override: Override for artist tag.
        album_override: Override for album tag.

    Returns:
        JoinMetadata with resolved values.
    """
    # Collect values from all files
    titles = [f.title for f in files]
    artists = [f.artist for f in files]
    albums = [f.album for f in files]
    dates = [f.date for f in files]
    genres = [f.genre for f in files]

    # Resolve each field
    title = title_override or _resolve_metadata_field(titles)
    artist = artist_override or _resolve_metadata_field(artists)
    album = album_override or _resolve_metadata_field(albums)
    date = _resolve_metadata_field(dates)
    genre = _resolve_metadata_field(genres)

    # Build comment with multiple lines:
    # #1: <source 1 comment>
    # #2: <source 2 comment>
    # JOINED|count|file1|hash1|file2|hash2|...
    # join:<decision>

    comment_lines = []

    # Add source comments (escaped - newlines replaced with \n literal)
    for i, f in enumerate(files, start=1):
        escaped_comment = _escape_comment(f.comment)
        comment_lines.append(f"#{i}: {escaped_comment}")

    # Add JOINED line: JOINED|count|file1|hash1|file2|hash2|...
    joined_parts = ["JOINED", str(len(files))]
    for i, f in enumerate(files):
        joined_parts.append(f.path.name)
        if source_hashes and i < len(source_hashes):
            # Use first 16 chars of hash for brevity
            joined_parts.append(source_hashes[i][:16])
        else:
            joined_parts.append("")
    comment_lines.append("|".join(joined_parts))

    # Add strategy line
    if strategy:
        comment_lines.append(_build_join_decision(files, strategy))
    else:
        comment_lines.append("STRATEGY:unknown")

    comment = "\\n".join(comment_lines)

    return JoinMetadata(
        title=title,
        artist=artist,
        album=album,
        date=date,
        genre=genre,
        comment=comment,
    )


def determine_join_strategy(
    files: list[AudioFileInfo],
    *,
    use_fades: bool = True,
    force_reencode: bool = False,
    output_format: str | None = None,
    sample_rate_override: int | None = None,
    channels_override: int | None = None,
    bitrate_override: int | None = None,
) -> JoinStrategy:
    """Determine the optimal joining strategy.

    Args:
        files: List of source audio files.
        use_fades: Whether to apply 1s fade transitions (default True).
        force_reencode: Always re-encode, never stream copy.
        output_format: User-specified output format.
        sample_rate_override: Force specific sample rate.
        channels_override: Force specific channel count.
        bitrate_override: Force specific bitrate.

    Returns:
        JoinStrategy with method and target properties.
    """
    # Determine if stream copy is possible
    can_stream_copy = not use_fades and not force_reencode and check_stream_copy_compatible(files)

    # Compute target properties from minimums
    target_sample_rate = sample_rate_override or min(f.sample_rate for f in files)
    target_channels = channels_override or min(f.channels for f in files)

    # Bitrate: minimum from lossy sources, or default
    lossy_bitrates = [f.bitrate_kbps for f in files if not f.is_lossless and f.bitrate_kbps]
    if bitrate_override:
        target_bitrate = bitrate_override
    elif lossy_bitrates:
        target_bitrate = min(lossy_bitrates)
    else:
        target_bitrate = DEFAULT_OPUS_BITRATE

    # Determine output format
    if output_format:
        fmt = output_format.lower()
    elif all(f.codec == files[0].codec for f in files):
        # Same codec, keep that format (even if rate/channels differ)
        fmt = CODEC_TO_FORMAT.get(files[0].codec, "opus")
    else:
        # Mixed codecs, default to Opus
        fmt = "opus"

    # Adjust sample rate for Opus (only supports specific rates)
    if fmt == "opus" and not sample_rate_override:
        target_sample_rate = _find_best_opus_sample_rate(target_sample_rate)

    # Cap bitrate for Opus (libopus supports max 510 kbps)
    if fmt == "opus" and not bitrate_override and target_bitrate > MAX_OPUS_BITRATE:
        target_bitrate = MAX_OPUS_BITRATE

    method = "stream_copy" if can_stream_copy else "reencode"

    return JoinStrategy(
        method=method,
        output_format=fmt,
        sample_rate=target_sample_rate,
        channels=target_channels,
        bitrate_kbps=target_bitrate,
        use_fades=use_fades,
    )


def build_stream_copy_command(
    files: list[AudioFileInfo],
    output: Path,
    metadata: JoinMetadata | None = None,
    *,
    ffmpeg_binary: str = "ffmpeg",
    overwrite: bool = True,
) -> tuple[list[str], Path]:
    """Build FFmpeg command for stream copy via concat demuxer.

    Args:
        files: List of source audio files.
        output: Output file path.
        metadata: Optional metadata to write to output.
        ffmpeg_binary: Path to ffmpeg executable.
        overwrite: Whether to overwrite output.

    Returns:
        Tuple of (command, concat_list_path).
        Caller is responsible for cleaning up concat_list_path.
    """
    # Create concat list file
    fd, list_path_str = tempfile.mkstemp(suffix=".txt", prefix="concat_")
    list_path = Path(list_path_str)

    with open(fd, "w", encoding="utf-8") as f:
        for audio in files:
            # Escape single quotes in path
            escaped = str(audio.path).replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")

    ffmpeg = shutil.which(ffmpeg_binary) or ffmpeg_binary
    cmd = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_path),
        "-c",
        "copy",
    ]

    # Add metadata tags
    if metadata:
        if metadata.title:
            cmd.extend(["-metadata", f"title={metadata.title}"])
        if metadata.artist:
            cmd.extend(["-metadata", f"artist={metadata.artist}"])
        if metadata.album:
            cmd.extend(["-metadata", f"album={metadata.album}"])
        if metadata.date:
            cmd.extend(["-metadata", f"date={metadata.date}"])
        if metadata.genre:
            cmd.extend(["-metadata", f"genre={metadata.genre}"])
        if metadata.comment:
            cmd.extend(["-metadata", f"comment={metadata.comment}"])
        cmd.extend(["-metadata", "encoder=Besedy catalog join"])

    if overwrite:
        cmd.append("-y")

    cmd.append(str(output))

    return cmd, list_path


def build_reencode_command(
    files: list[AudioFileInfo],
    output: Path,
    strategy: JoinStrategy,
    metadata: JoinMetadata | None = None,
    *,
    ffmpeg_binary: str = "ffmpeg",
    overwrite: bool = True,
) -> list[str]:
    """Build FFmpeg command for re-encoding with optional fades.

    Args:
        files: List of source audio files.
        output: Output file path.
        strategy: Join strategy with target properties.
        metadata: Optional metadata to write to output.
        ffmpeg_binary: Path to ffmpeg executable.
        overwrite: Whether to overwrite output.

    Returns:
        FFmpeg command as list of strings.
    """
    ffmpeg = shutil.which(ffmpeg_binary) or ffmpeg_binary
    cmd = [ffmpeg, "-nostdin", "-hide_banner"]

    # Add all input files
    for audio in files:
        cmd.extend(["-i", str(audio.path)])

    # Build filter complex
    filter_parts = []
    labels = []
    n = len(files)

    for i, audio in enumerate(files):
        label = f"a{i}"
        duration = audio.duration_seconds

        if strategy.use_fades:
            if n == 1:
                # Single file, no fades
                filter_parts.append(f"[{i}:a]anull[{label}]")
            elif i == 0:
                # First file: fade out only
                fade_out_start = max(0, duration - 1)
                filter_parts.append(f"[{i}:a]afade=t=out:st={fade_out_start:.3f}:d=1[{label}]")
            elif i == n - 1:
                # Last file: fade in only
                filter_parts.append(f"[{i}:a]afade=t=in:d=1[{label}]")
            else:
                # Middle file: fade in and fade out
                fade_out_start = max(0, duration - 1)
                filter_parts.append(
                    f"[{i}:a]afade=t=in:d=1,afade=t=out:st={fade_out_start:.3f}:d=1[{label}]"
                )
        else:
            # No fades, just pass through
            filter_parts.append(f"[{i}:a]anull[{label}]")

        labels.append(f"[{label}]")

    # Concat all streams
    concat_inputs = "".join(labels)
    filter_parts.append(f"{concat_inputs}concat=n={n}:v=0:a=1[out]")

    filter_complex = ";".join(filter_parts)
    cmd.extend(["-filter_complex", filter_complex])
    cmd.extend(["-map", "[out]"])

    # Audio encoding settings
    cmd.extend(["-ar", str(strategy.sample_rate)])
    cmd.extend(["-ac", str(strategy.channels)])

    # Codec and format-specific settings
    fmt = strategy.output_format.lower()
    if fmt == "opus":
        cmd.extend(["-c:a", "libopus", "-b:a", f"{strategy.bitrate_kbps}k", "-vbr", "on"])
    elif fmt == "mp3":
        cmd.extend(["-c:a", "libmp3lame", "-b:a", f"{strategy.bitrate_kbps}k"])
    elif fmt in ("m4a", "aac"):
        cmd.extend(["-c:a", "aac", "-b:a", f"{strategy.bitrate_kbps}k"])
    elif fmt == "ogg":
        cmd.extend(["-c:a", "libvorbis", "-b:a", f"{strategy.bitrate_kbps}k"])
    elif fmt == "flac":
        cmd.extend(["-c:a", "flac"])
    elif fmt == "wav":
        cmd.extend(["-c:a", "pcm_s16le"])
    else:
        # Default to Opus
        cmd.extend(["-c:a", "libopus", "-b:a", f"{strategy.bitrate_kbps}k", "-vbr", "on"])

    # Add metadata
    if metadata:
        if metadata.title:
            cmd.extend(["-metadata", f"title={metadata.title}"])
        if metadata.artist:
            cmd.extend(["-metadata", f"artist={metadata.artist}"])
        if metadata.album:
            cmd.extend(["-metadata", f"album={metadata.album}"])
        if metadata.date:
            cmd.extend(["-metadata", f"date={metadata.date}"])
        if metadata.genre:
            cmd.extend(["-metadata", f"genre={metadata.genre}"])
        if metadata.comment:
            cmd.extend(["-metadata", f"comment={metadata.comment}"])
        cmd.extend(["-metadata", "encoder=Besedy catalog join"])

    if overwrite:
        cmd.append("-y")

    cmd.append(str(output))

    return cmd


def format_duration(seconds: float) -> str:
    """Format duration in seconds to HH:MM:SS string."""
    total_seconds = int(seconds)
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def format_size(size_bytes: int) -> str:
    """Format file size in human-readable form."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.1f} GB"
