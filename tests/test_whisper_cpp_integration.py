"""Integration tests for whisper.cpp conversion.

These tests cover the full conversion pipeline including convert_whisper_cpp()
and convert_file() with realistic whisper.cpp JSON data.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from besedy.cli.convert_whisper_cpp import (
    WhisperCppConversionError,
    convert_file,
    convert_whisper_cpp,
    process_with_catalog,
    resolve_durations_from_catalog,
)


@pytest.fixture
def minimal_whisper_cpp_payload():
    """Minimal valid whisper.cpp JSON payload with Czech text requiring UTF-8 merging."""
    # Czech text "dobrý den" (good day) with diacritics
    # The 'ý' character is 2-byte UTF-8: C3 BD
    # When read as latin-1, it appears as: Ã½
    return {
        "systeminfo": "whisper.cpp test",
        "model": {
            "type": "base",
            "multilingual": True,
            "vocab": 51865,
            "audio": {"ctx": 1500, "state": 512, "head": 8, "layer": 6},
            "text": {"ctx": 448, "state": 512, "head": 8, "layer": 6},
            "mels": 80,
            "ftype": 1,
        },
        "params": {"model": "/path/to/ggml-base.bin", "language": "cs", "translate": False},
        "result": {"language": "cs"},
        "transcription": [
            {
                "timestamps": {"from": "00:00:00,000", "to": "00:00:02,000"},
                "offsets": {"from": 0, "to": 2000},
                # This is latin-1 mojibake of UTF-8 "dobrý den"
                # UTF-8 bytes: 64 6F 62 72 C3 BD 20 64 65 6E
                # Read as latin-1: d o b r Ã ½   d e n
                "text": " dobrÃ½ den",
                "tokens": [
                    {
                        "text": " dobr",
                        "timestamps": {"from": "00:00:00,000", "to": "00:00:01,000"},
                        "offsets": {"from": 0, "to": 1000},
                        "id": 1234,
                        "p": 0.95,
                    },
                    # Second token contains the broken UTF-8 byte (Ã½ = C3 BD)
                    {
                        "text": "Ã½",
                        "timestamps": {"from": "00:00:01,000", "to": "00:00:01,500"},
                        "offsets": {"from": 1000, "to": 1500},
                        "id": 1235,
                        "p": 0.90,
                    },
                    {
                        "text": " den",
                        "timestamps": {"from": "00:00:01,500", "to": "00:00:02,000"},
                        "offsets": {"from": 1500, "to": 2000},
                        "id": 1236,
                        "p": 0.92,
                    },
                ],
            }
        ],
    }


@pytest.fixture
def whisper_cpp_with_special_tokens():
    """Whisper.cpp payload with special control tokens."""
    return {
        "systeminfo": "whisper.cpp test",
        "model": {"type": "base"},
        "params": {"model": "test.bin", "language": "en"},
        "result": {"language": "en"},
        "transcription": [
            {
                "timestamps": {"from": "00:00:00,000", "to": "00:00:01,000"},
                "offsets": {"from": 0, "to": 1000},
                "text": " hello world",
                "tokens": [
                    {
                        "text": "[_SOT_]",
                        "timestamps": {"from": "00:00:00,000", "to": "00:00:00,000"},
                        "offsets": {"from": 0, "to": 0},
                        "id": 50257,
                        "p": 0.99,
                    },
                    {
                        "text": " hello",
                        "timestamps": {"from": "00:00:00,000", "to": "00:00:00,500"},
                        "offsets": {"from": 0, "to": 500},
                        "id": 1000,
                        "p": 0.95,
                    },
                    {
                        "text": " world",
                        "timestamps": {"from": "00:00:00,500", "to": "00:00:01,000"},
                        "offsets": {"from": 500, "to": 1000},
                        "id": 1001,
                        "p": 0.93,
                    },
                    {
                        "text": "[_EOT_]",
                        "timestamps": {"from": "00:00:01,000", "to": "00:00:01,000"},
                        "offsets": {"from": 1000, "to": 1000},
                        "id": 50256,
                        "p": 0.99,
                    },
                ],
            }
        ],
    }


@pytest.fixture
def empty_whisper_cpp_payload():
    """Valid but empty whisper.cpp payload."""
    return {
        "systeminfo": "whisper.cpp test",
        "model": {"type": "base"},
        "params": {"model": "test.bin", "language": "en"},
        "result": {"language": "en"},
        "transcription": [],
    }


class TestConvertWhisperCpp:
    """Test the convert_whisper_cpp() function with various payloads."""

    def test_minimal_valid_payload(self, minimal_whisper_cpp_payload):
        """Test conversion of minimal valid payload with UTF-8 merging."""
        result = convert_whisper_cpp(
            minimal_whisper_cpp_payload, source_encoding="latin-1", duration_seconds=2.0
        )

        # Check structure
        assert isinstance(result, dict)
        assert "meta" in result
        assert "segments" in result

        # Check meta fields
        assert result["meta"]["backend"] == "whisper.cpp"
        assert "systeminfo" in result["meta"]

        # Check segments
        assert len(result["segments"]) == 1
        segment = result["segments"][0]

        # Check timestamps
        assert segment["start"] == 0.0
        assert segment["end"] == 2.0

        # Check text was correctly decoded from latin-1 mojibake
        assert segment["text"] == "dobrý den"

        # Check words
        assert "words" in segment
        words = segment["words"]
        assert len(words) == 2  # " dobrý" and "den"

        # Verify word content
        assert words[0]["word"] == "dobrý"
        assert words[1]["word"] == "den"

        # Verify confidence values
        assert words[0]["confidence"] is not None
        assert words[1]["confidence"] is not None

    def test_special_tokens_filtered(self, whisper_cpp_with_special_tokens):
        """Test that special tokens are filtered out during conversion."""
        result = convert_whisper_cpp(
            whisper_cpp_with_special_tokens, source_encoding="utf-8", duration_seconds=1.0
        )

        # Check segment text doesn't contain special tokens
        segment = result["segments"][0]
        assert "[_SOT_]" not in segment["text"]
        assert "[_EOT_]" not in segment["text"]
        assert segment["text"].strip() == "hello world"

        # Check words don't contain special tokens
        words = segment["words"]
        assert len(words) == 2
        assert words[0]["word"] == "hello"
        assert words[1]["word"] == "world"

    def test_empty_transcription(self, empty_whisper_cpp_payload):
        """Test handling of empty transcription list."""
        result = convert_whisper_cpp(empty_whisper_cpp_payload, duration_seconds=0.0)

        assert isinstance(result, dict)
        assert len(result["segments"]) == 0
        assert result["meta"]["backend"] == "whisper.cpp"

    def test_missing_transcription_field(self):
        """Test error handling when 'transcription' field is missing."""
        payload = {"systeminfo": "test", "model": {}}

        with pytest.raises(WhisperCppConversionError) as exc_info:
            convert_whisper_cpp(payload, duration_seconds=1.0)

        assert "Missing required 'transcription' field" in str(exc_info.value)

    def test_invalid_payload_type(self):
        """Test error handling for non-dict payload."""
        with pytest.raises(WhisperCppConversionError) as exc_info:
            convert_whisper_cpp([], duration_seconds=1.0)

        assert "Expected dict payload" in str(exc_info.value)

    def test_invalid_transcription_type(self):
        """Test error handling when 'transcription' is not a list."""
        payload = {"transcription": "not a list"}

        with pytest.raises(WhisperCppConversionError) as exc_info:
            convert_whisper_cpp(payload, duration_seconds=1.0)

        assert "'transcription' must be a list" in str(exc_info.value)


class TestConvertFile:
    """Test the convert_file() function with file I/O."""

    def test_convert_valid_file(self, minimal_whisper_cpp_payload, tmp_path):
        """Test converting a valid whisper.cpp JSON file."""
        # Create input file with UTF-8 encoding (normal case)
        input_file = tmp_path / "input.json"
        with open(input_file, "w", encoding="utf-8") as f:
            json.dump(minimal_whisper_cpp_payload, f)

        # Create output file path
        output_file = tmp_path / "output.json"

        # Convert (convert_file signature is: input_path, output_path, indent)
        convert_file(Path(input_file), Path(output_file), indent=2, duration_seconds=1.23)

        # Verify output file exists and has valid content
        assert output_file.exists()

        with open(output_file, "r", encoding="utf-8") as f:
            result = json.load(f)

        # Verify structure
        assert "meta" in result
        assert "segments" in result
        assert len(result["segments"]) == 1

        # Verify text (the mojibake in the fixture should be decoded correctly)
        # The fixture already contains latin-1 mojibake in the text field
        assert (
            "dobrý den" in result["segments"][0]["text"]
            or "dobrÃ½ den" in result["segments"][0]["text"]
        )

    def test_convert_nonexistent_file(self, tmp_path):
        """Test error handling for nonexistent input file."""
        input_file = tmp_path / "nonexistent.json"
        output_file = tmp_path / "output.json"

        with pytest.raises(FileNotFoundError):
            convert_file(Path(input_file), Path(output_file), indent=2, duration_seconds=1.23)

    def test_convert_invalid_json(self, tmp_path):
        """Test error handling for malformed JSON file."""
        input_file = tmp_path / "invalid.json"
        with open(input_file, "w") as f:
            f.write("{this is not valid JSON}")

        output_file = tmp_path / "output.json"

        with pytest.raises(json.JSONDecodeError):
            convert_file(Path(input_file), Path(output_file), indent=2, duration_seconds=1.23)

    def test_output_file_created(self, minimal_whisper_cpp_payload, tmp_path):
        """Test that output file is created with correct permissions."""
        input_file = tmp_path / "input.json"
        with open(input_file, "w", encoding="latin-1") as f:
            json.dump(minimal_whisper_cpp_payload, f)

        output_file = tmp_path / "output.json"
        assert not output_file.exists()

        convert_file(Path(input_file), Path(output_file), indent=2, duration_seconds=1.23)

        assert output_file.exists()
        assert output_file.is_file()
        assert output_file.stat().st_size > 0


class TestProcessWithCatalogSkipExisting:
    """Test skip-existing behavior in process_with_catalog()."""

    @pytest.fixture
    def transcript_dir(self, tmp_path, minimal_whisper_cpp_payload):
        """Create a directory with transcript_original.json files."""
        # Create two transcript directories with hash-like structure
        hash1_dir = tmp_path / "whisper.cpp" / "ab" / "abcd1234"
        hash2_dir = tmp_path / "whisper.cpp" / "cd" / "cdef5678"
        hash1_dir.mkdir(parents=True)
        hash2_dir.mkdir(parents=True)

        # Write transcript_original.json files
        for d in [hash1_dir, hash2_dir]:
            with open(d / "transcript_original.json", "w", encoding="utf-8") as f:
                json.dump(minimal_whisper_cpp_payload, f)

        # Create a dummy catalog (content doesn't matter - we mock the loader)
        catalog = tmp_path / "catalog.csv"
        catalog.write_text("Hash,Full Path\n")

        files = [
            hash1_dir / "transcript_original.json",
            hash2_dir / "transcript_original.json",
        ]

        return {
            "tmp_path": tmp_path,
            "hash1_dir": hash1_dir,
            "hash2_dir": hash2_dir,
            "catalog": catalog,
            "files": files,
            # Mock duration map that would come from resolve_durations_from_catalog
            "duration_map": {f: (2.0, tmp_path / "audio.wav") for f in files},
        }

    def test_skip_existing_skips_converted_files(self, transcript_dir):
        """Test that already-converted files are skipped by default."""
        # Pre-create transcript.json for one file
        existing_output = transcript_dir["hash1_dir"] / "transcript.json"
        existing_output.write_text('{"pre": "existing"}')
        original_content = existing_output.read_text()

        with patch(
            "besedy.cli.convert_whisper_cpp.resolve_durations_from_catalog",
            return_value=transcript_dir["duration_map"],
        ):
            processed, failed, skipped = process_with_catalog(
                transcript_dir["files"],
                transcript_dir["catalog"],
                indent=2,
                skip_existing=True,
            )

        assert skipped == 1  # hash1 was skipped
        assert processed == 1  # hash2 was processed
        assert failed == 0

        # Verify the pre-existing file was NOT overwritten
        assert existing_output.read_text() == original_content

        # Verify the other file was converted
        new_output = transcript_dir["hash2_dir"] / "transcript.json"
        assert new_output.exists()
        result = json.loads(new_output.read_text())
        assert "meta" in result
        assert "segments" in result

    def test_skip_existing_false_reconverts_all(self, transcript_dir):
        """Test that skip_existing=False re-converts all files."""
        # Pre-create transcript.json for one file
        existing_output = transcript_dir["hash1_dir"] / "transcript.json"
        existing_output.write_text('{"pre": "existing"}')

        with patch(
            "besedy.cli.convert_whisper_cpp.resolve_durations_from_catalog",
            return_value=transcript_dir["duration_map"],
        ):
            processed, failed, skipped = process_with_catalog(
                transcript_dir["files"],
                transcript_dir["catalog"],
                indent=2,
                skip_existing=False,
            )

        assert skipped == 0
        assert processed == 2  # Both files processed
        assert failed == 0

        # Verify the pre-existing file WAS overwritten
        result = json.loads(existing_output.read_text())
        assert "meta" in result  # Now has proper structure
        assert result.get("pre") is None  # Old content gone

    def test_no_output_converts_normally(self, transcript_dir):
        """Test that files without existing output are always converted."""
        with patch(
            "besedy.cli.convert_whisper_cpp.resolve_durations_from_catalog",
            return_value=transcript_dir["duration_map"],
        ):
            processed, failed, skipped = process_with_catalog(
                transcript_dir["files"],
                transcript_dir["catalog"],
                indent=2,
                skip_existing=True,
            )

        assert skipped == 0  # Nothing to skip
        assert processed == 2
        assert failed == 0

        # Verify both outputs exist
        for d in [transcript_dir["hash1_dir"], transcript_dir["hash2_dir"]]:
            output = d / "transcript.json"
            assert output.exists()
            result = json.loads(output.read_text())
            assert "meta" in result


class TestResolveDurationsSkipsMissing:
    """MAJOR #7: an unresolvable catalog entry must not fail the whole batch."""

    def test_resolve_omits_missing_hash_and_missing_audio(self, tmp_path, capsys):
        """resolve_durations_from_catalog skips entries the catalog can't
        resolve instead of raising, so one bad entry doesn't abort the rest."""
        present = tmp_path / "aa" / "present"
        missing_hash = tmp_path / "bb" / "missinghash"
        missing_audio = tmp_path / "cc" / "missingaudio"
        for d in [present, missing_hash, missing_audio]:
            d.mkdir(parents=True)

        audio = tmp_path / "present.wav"
        audio.write_bytes(b"RIFF")
        gone = tmp_path / "gone.wav"  # referenced by catalog but never created

        catalog_map = {"present": audio, "missingaudio": gone}
        files = [
            present / "transcript_original.json",
            missing_hash / "transcript_original.json",
            missing_audio / "transcript_original.json",
        ]

        with (
            patch(
                "besedy.cli.convert_whisper_cpp._load_catalog",
                return_value=catalog_map,
            ),
            patch(
                "besedy.cli.convert_whisper_cpp.measure_audio_duration_seconds",
                return_value=3.5,
            ),
        ):
            result = resolve_durations_from_catalog(tmp_path / "catalog.csv", files)

        # Only the fully-resolvable file appears; the others are omitted.
        assert set(result) == {present / "transcript_original.json"}
        assert result[present / "transcript_original.json"] == (3.5, audio)

        # The two skip reasons stay distinct (missing hash vs missing audio),
        # so an operator can tell why each file was dropped.
        out = capsys.readouterr().out
        assert "missinghash: hash not found in catalog" in out
        assert "missingaudio: audio file missing" in out

    def test_process_fails_missing_entry_per_file(self, transcript_dir):
        """A file absent from the resolved duration map fails on its own while
        the resolvable file in the same batch still converts."""
        files = transcript_dir["files"]
        # duration_map resolves only the second file; the first is unresolvable.
        partial_map = {files[1]: (2.0, transcript_dir["tmp_path"] / "audio.wav")}

        with patch(
            "besedy.cli.convert_whisper_cpp.resolve_durations_from_catalog",
            return_value=partial_map,
        ):
            processed, failed, skipped = process_with_catalog(
                files,
                transcript_dir["catalog"],
                indent=2,
                skip_existing=False,
            )

        assert processed == 1
        assert failed == 1
        assert skipped == 0
        # The resolvable file was still converted.
        assert (transcript_dir["hash2_dir"] / "transcript.json").exists()

    @pytest.fixture
    def transcript_dir(self, tmp_path, minimal_whisper_cpp_payload):
        hash1_dir = tmp_path / "whisper.cpp" / "ab" / "abcd1234"
        hash2_dir = tmp_path / "whisper.cpp" / "cd" / "cdef5678"
        hash1_dir.mkdir(parents=True)
        hash2_dir.mkdir(parents=True)
        for d in [hash1_dir, hash2_dir]:
            with open(d / "transcript_original.json", "w", encoding="utf-8") as f:
                json.dump(minimal_whisper_cpp_payload, f)
        catalog = tmp_path / "catalog.csv"
        catalog.write_text("Hash,Full Path\n")
        return {
            "tmp_path": tmp_path,
            "hash1_dir": hash1_dir,
            "hash2_dir": hash2_dir,
            "catalog": catalog,
            "files": [
                hash1_dir / "transcript_original.json",
                hash2_dir / "transcript_original.json",
            ],
        }


class TestMainExitCode:
    """MAJOR #7 review: conversion failures must surface as a non-zero exit."""

    def _run_main(self, tmp_path, result_tuple, monkeypatch):
        from besedy.cli import convert_whisper_cpp as mod

        input_dir = tmp_path / "whisper.cpp"
        input_dir.mkdir()
        catalog = tmp_path / "catalog.csv"
        catalog.write_text("Hash,Full Path\n")

        monkeypatch.setattr(mod, "resolve_project_path", lambda p: Path(p))
        monkeypatch.setattr(mod, "_infer_catalog_path", lambda p: None)
        monkeypatch.setattr(
            mod,
            "find_transcript_files",
            lambda p: [input_dir / "ab" / "transcript_original.json"],
        )
        monkeypatch.setattr(
            mod, "process_with_catalog", lambda *a, **k: result_tuple
        )
        monkeypatch.setattr(
            sys, "argv", ["convert", str(input_dir), "--catalog", str(catalog)]
        )
        mod.main()

    def test_exits_nonzero_when_files_failed(self, tmp_path, monkeypatch):
        # process_with_catalog reports (processed=0, failed=1, skipped=0).
        with pytest.raises(SystemExit) as exc:
            self._run_main(tmp_path, (0, 1, 0), monkeypatch)
        assert exc.value.code == 1

    def test_exits_zero_when_all_succeed(self, tmp_path, monkeypatch):
        # (processed=2, failed=0, skipped=0) → normal return, no SystemExit.
        self._run_main(tmp_path, (2, 0, 0), monkeypatch)
