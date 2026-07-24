"""Shared helpers for analyzing audio quality metrics via ffmpeg/ffprobe."""

from __future__ import annotations

import json
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from besedy.lib.audio.decode import decode_to_temp_wav

AUDIO_QUALITY_COLUMNS = (
    "sample_rate",
    "channels",
    "bitrate_kbps",
    "integrated_loudness_lufs",
    "true_peak_db",
    "loudness_range_lu",
    "input_thresh",
    "target_offset",
    "needs_normalization",
    "codec_profile",
)


@dataclass
class AudioQualityMetrics:
    integrated_loudness_lufs: str = ""
    true_peak_db: str = ""
    loudness_range_lu: str = ""
    input_thresh: str = ""
    target_offset: str = ""
    sample_rate: str = ""
    bit_depth: str = ""
    channels: str = ""
    bitrate_kbps: str = ""
    mean_volume_db: str = ""
    max_volume_db: str = ""
    needs_normalization: str = ""
    codec_profile: str = ""


def analyze_loudness(
    file_path: Path,
    *,
    ffmpeg_binary: str = "ffmpeg",
    timeout: int | None = None,
    target_lufs: float = -16,
    loudness_range_lu: float = 11,
    true_peak_dbtp: float = -1.5,
) -> tuple[dict[str, str | None], str | None]:
    """Analyze audio loudness using ffmpeg's loudnorm filter.

    Uses a two-step decode approach to handle corrupted audio files:
    1. First decode the source to a temporary WAV (handles corruption gracefully)
    2. Then run loudnorm analysis on the clean WAV

    This prevents the loudnorm filter from losing audio at the end of corrupted
    files (e.g., MP3s with frame errors).
    """
    metrics: dict[str, str | None] = {
        "integrated_loudness_lufs": None,
        "true_peak_db": None,
        "loudness_range_lu": None,
        "input_thresh": None,
        "target_offset": None,
    }

    # Step 1: Decode source to temporary WAV (handles corruption gracefully)
    temp_fd, temp_path_str = tempfile.mkstemp(suffix=".wav", prefix="loudness_")
    temp_path = Path(temp_path_str)
    try:
        # Close the file descriptor - decode_to_temp_wav will write to the path
        import os

        os.close(temp_fd)

        ok, decode_error = decode_to_temp_wav(
            file_path,
            temp_path,
            ffmpeg_binary=ffmpeg_binary,
            timeout=timeout,
        )
        if not ok:
            return metrics, f"decode failed: {decode_error}"

        # Step 2: Run loudnorm analysis on the clean temp WAV
        cmd = [
            ffmpeg_binary,
            "-nostdin",
            "-hide_banner",
            "-nostats",
            "-i",
            str(temp_path),  # Analyze temp WAV, not original source
            "-af",
            f"loudnorm=I={target_lufs}:LRA={loudness_range_lu}:tp={true_peak_dbtp}:print_format=json",
            "-f",
            "null",
            "-",
        ]

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                timeout=timeout,
                check=True,
            )
        except subprocess.TimeoutExpired:
            return metrics, (
                f"loudnorm timed out after {timeout} seconds" if timeout else "loudnorm timed out"
            )
        except subprocess.CalledProcessError as exc:
            # Decode stderr with error handling
            stderr_text = exc.stderr.decode("utf-8", errors="replace") if exc.stderr else ""
            detail = stderr_text.strip().splitlines()[-1] if stderr_text else str(exc)
            return metrics, f"ffmpeg loudnorm failed (exit {exc.returncode}): {detail}"
        except Exception as exc:  # pragma: no cover - defensive
            return metrics, f"ffmpeg loudnorm failed: {exc}"

        # Decode stderr with error handling for bad UTF-8 sequences
        stderr = result.stderr.decode("utf-8", errors="replace")
        if not stderr:
            return metrics, "ffmpeg loudnorm produced no stderr output"

        lines = stderr.strip().split("\n")
        json_start = -1
        for i in range(len(lines) - 1, -1, -1):
            stripped = lines[i].strip()
            if stripped.startswith("{"):
                json_start = i
                break

        if json_start >= 0:
            json_text = "\n".join(lines[json_start:])
            try:
                data = json.loads(json_text)
                metrics["integrated_loudness_lufs"] = data.get("input_i") or ""
                metrics["true_peak_db"] = data.get("input_tp") or ""
                metrics["loudness_range_lu"] = data.get("input_lra") or ""
                metrics["input_thresh"] = data.get("input_thresh") or ""
                metrics["target_offset"] = data.get("target_offset") or ""
            except json.JSONDecodeError:
                for i in range(json_start, len(lines)):
                    try:
                        potential_json = "\n".join(lines[i:])
                        brace_count = 0
                        end_pos = -1
                        for j, char in enumerate(potential_json):
                            if char == "{":
                                brace_count += 1
                            elif char == "}":
                                brace_count -= 1
                                if brace_count == 0:
                                    end_pos = j + 1
                                    break
                        if end_pos > 0:
                            json_text = potential_json[:end_pos]
                            data = json.loads(json_text)
                            metrics["integrated_loudness_lufs"] = data.get("input_i") or ""
                            metrics["true_peak_db"] = data.get("input_tp") or ""
                            metrics["loudness_range_lu"] = data.get("input_lra") or ""
                            metrics["input_thresh"] = data.get("input_thresh") or ""
                            metrics["target_offset"] = data.get("target_offset") or ""
                            break
                    except (json.JSONDecodeError, ValueError):
                        continue
                else:
                    return metrics, "failed to parse loudnorm JSON output"
        else:
            return metrics, "ffmpeg loudnorm JSON block not found"

        required_fields = (
            "integrated_loudness_lufs",
            "true_peak_db",
            "loudness_range_lu",
            "input_thresh",
            "target_offset",
        )
        if any(not metrics[field] for field in required_fields):
            return metrics, "ffmpeg loudnorm output missing required metrics"

        return metrics, None

    finally:
        # Always clean up temp file
        temp_path.unlink(missing_ok=True)


def analyze_volume(
    file_path: Path,
    *,
    ffmpeg_binary: str = "ffmpeg",
    timeout: int | None = None,
) -> dict[str, str | None]:
    metrics = {
        "mean_volume_db": None,
        "max_volume_db": None,
    }

    cmd = [
        ffmpeg_binary,
        "-nostdin",
        "-hide_banner",
        "-nostats",
        "-i",
        str(file_path),
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            check=True,
        )
    except subprocess.TimeoutExpired:
        return metrics
    except Exception:
        return metrics

    # Decode stderr with error handling for bad UTF-8 sequences
    stderr = result.stderr.decode("utf-8", errors="replace")
    for line in stderr.split("\n"):
        if "mean_volume:" in line:
            parts = line.split("mean_volume:")
            if len(parts) > 1:
                metrics["mean_volume_db"] = parts[1].strip().split()[0]
        elif "max_volume:" in line:
            parts = line.split("max_volume:")
            if len(parts) > 1:
                metrics["max_volume_db"] = parts[1].strip().split()[0]

    return metrics


def analyze_technical_properties(
    file_path: Path,
    *,
    ffprobe_binary: str = "ffprobe",
    timeout: int = 10,
) -> dict[str, str | None]:
    metrics = {
        "sample_rate": None,
        "bit_depth": None,
        "channels": None,
        "bitrate_kbps": None,
        "codec_profile": None,
    }

    # NOTE: Do NOT add "-nostdin" flag here. The custom ffprobe build has a bug
    # where it misparses -nostdin and fails with "Option not found". This has
    # been encountered and fixed multiple times. ffmpeg works fine with -nostdin,
    # but ffprobe does not.
    cmd = [
        ffprobe_binary,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(file_path),
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            check=True,
        )
    except subprocess.TimeoutExpired:
        return metrics
    except Exception:
        return metrics

    # Decode stdout with error handling for bad UTF-8 sequences
    stdout = result.stdout.decode("utf-8", errors="replace")
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return metrics

    if "streams" in data:
        for stream in data["streams"]:
            if stream.get("codec_type") == "audio":
                sample_rate = stream.get("sample_rate")
                if sample_rate:
                    metrics["sample_rate"] = str(int(float(sample_rate)))

                bits_per_sample = stream.get("bits_per_sample")
                bits_per_raw_sample = stream.get("bits_per_raw_sample")
                if bits_per_raw_sample and int(bits_per_raw_sample) > 0:
                    metrics["bit_depth"] = str(bits_per_raw_sample)
                elif bits_per_sample and int(bits_per_sample) > 0:
                    metrics["bit_depth"] = str(bits_per_sample)

                channels = stream.get("channels")
                if channels:
                    metrics["channels"] = str(channels)

                bitrate = stream.get("bit_rate")
                if bitrate:
                    metrics["bitrate_kbps"] = str(int(float(bitrate)) // 1000)

                profile = stream.get("profile")
                if profile and profile != "unknown":
                    metrics["codec_profile"] = profile

                break

    if not metrics["bitrate_kbps"] and "format" in data:
        bitrate = data["format"].get("bit_rate")
        if bitrate:
            metrics["bitrate_kbps"] = str(int(float(bitrate)) // 1000)

    return metrics


def needs_declipping(true_peak_db: str | None, threshold: float = -1.0) -> bool:
    """
    Detect if a file needs declipping based on true peak measurement.

    Clipping occurs when audio samples exceed the maximum digital value,
    causing flat-topped waveforms and harsh distortion. This is particularly
    problematic for speech intelligibility.

    Args:
        true_peak_db: True peak value from audio analysis (dBTP)
        threshold: Peak threshold in dBTP (default -1.0, conservative for speech)
                  Values closer to 0 indicate higher likelihood of clipping.

    Returns:
        True if file has clipping artifacts (peaks at or above threshold)

    Note:
        - Broadcast standards typically use -1.0 to -1.5 dBTP as max
        - Files with peaks >= -1.0 dBTP likely contain clipped samples
        - Speech is especially sensitive to clipping artifacts
    """
    if not true_peak_db:
        return False
    try:
        peak = float(true_peak_db)
        return peak >= threshold
    except ValueError:
        return False


def determine_needs_normalization(integrated_loudness: str | None) -> str:
    if not integrated_loudness:
        return ""
    try:
        lufs = float(integrated_loudness)
    except ValueError:
        return ""
    if lufs < -20 or lufs > -12:
        return "yes"
    return "no"


def analyze_audio_file(
    file_path: Path,
    *,
    timeout: int | None = None,
    ffmpeg_binary: str = "ffmpeg",
    ffprobe_binary: str = "ffprobe",
) -> AudioQualityMetrics:
    metrics = AudioQualityMetrics()

    if not file_path.exists():
        raise FileNotFoundError(file_path)

    tech_props = analyze_technical_properties(
        file_path,
        ffprobe_binary=ffprobe_binary,
        timeout=10,
    )
    metrics.sample_rate = tech_props.get("sample_rate") or ""
    metrics.bit_depth = tech_props.get("bit_depth") or ""
    metrics.channels = tech_props.get("channels") or ""
    metrics.bitrate_kbps = tech_props.get("bitrate_kbps") or ""
    metrics.codec_profile = tech_props.get("codec_profile") or ""

    loudness, loudness_error = analyze_loudness(
        file_path,
        ffmpeg_binary=ffmpeg_binary,
        timeout=timeout,
    )
    metrics.integrated_loudness_lufs = loudness.get("integrated_loudness_lufs") or ""
    metrics.true_peak_db = loudness.get("true_peak_db") or ""
    metrics.loudness_range_lu = loudness.get("loudness_range_lu") or ""
    metrics.input_thresh = loudness.get("input_thresh") or ""
    metrics.target_offset = loudness.get("target_offset") or ""

    loudness_fields = (
        metrics.integrated_loudness_lufs,
        metrics.true_peak_db,
        metrics.loudness_range_lu,
        metrics.input_thresh,
        metrics.target_offset,
    )
    if loudness_error or any(not field for field in loudness_fields):
        reason = loudness_error or "missing loudnorm metrics"
        raise RuntimeError(f"loudnorm analysis failed for {file_path}: {reason}")

    # Skip volumedetect - mean_volume_db and max_volume_db are not used for
    # normalization decisions (which use LUFS) and would double processing time

    metrics.needs_normalization = determine_needs_normalization(metrics.integrated_loudness_lufs)

    return metrics
