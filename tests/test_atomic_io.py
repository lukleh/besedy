"""Tests for lib/data/atomic_io.py module."""

from __future__ import annotations

import json
import os
import stat

import pytest

import besedy.lib.data.atomic_io as atomic_io_module
from besedy.lib.data.atomic_io import (
    atomic_path,
    atomic_write_json,
    atomic_write_text,
)


class TestAtomicWriteText:
    def test_writes_content(self, tmp_path):
        target = tmp_path / "out.txt"
        atomic_write_text(target, "hello world")
        assert target.read_text(encoding="utf-8") == "hello world"

    def test_overwrites_existing_file(self, tmp_path):
        target = tmp_path / "out.txt"
        target.write_text("old", encoding="utf-8")
        atomic_write_text(target, "new")
        assert target.read_text(encoding="utf-8") == "new"

    def test_preserves_existing_file_mode(self, tmp_path):
        target = tmp_path / "out.txt"
        target.write_text("old", encoding="utf-8")
        target.chmod(0o660)
        atomic_write_text(target, "new")
        assert stat.S_IMODE(target.stat().st_mode) == 0o660

    def test_custom_encoding(self, tmp_path):
        target = tmp_path / "out.txt"
        atomic_write_text(target, "café", encoding="latin-1")
        assert target.read_bytes() == "café".encode("latin-1")

    def test_no_temp_residue(self, tmp_path):
        target = tmp_path / "out.txt"
        atomic_write_text(target, "content")
        assert [p.name for p in tmp_path.iterdir()] == ["out.txt"]

    def test_exception_preserves_original(self, tmp_path):
        target = tmp_path / "out.txt"
        target.write_text("original", encoding="utf-8")

        with pytest.raises(RuntimeError, match="boom"):
            with atomic_path(target) as tmp:
                tmp.write_text("partial", encoding="utf-8")
                raise RuntimeError("boom")

        assert target.read_text(encoding="utf-8") == "original"
        assert [p.name for p in tmp_path.iterdir()] == ["out.txt"]

    def test_exception_without_temp_file(self, tmp_path):
        target = tmp_path / "out.txt"
        with pytest.raises(RuntimeError, match="boom"):
            with atomic_path(target):
                raise RuntimeError("boom")
        assert list(tmp_path.iterdir()) == []

    def test_fsync_failure_preserves_original(self, monkeypatch, tmp_path):
        target = tmp_path / "out.txt"
        target.write_text("original", encoding="utf-8")

        def fail_fsync(_fd: int) -> None:
            raise OSError("storage sync failed")

        monkeypatch.setattr(atomic_io_module, "_fsync_file", fail_fsync)

        with pytest.raises(OSError, match="storage sync failed"):
            atomic_write_text(target, "new")

        assert target.read_text(encoding="utf-8") == "original"

    def test_before_replace_callback_runs(self, tmp_path):
        target = tmp_path / "out.txt"
        calls = []
        atomic_write_text(target, "new", before_replace=lambda: calls.append("ran"))
        assert calls == ["ran"]
        assert target.read_text(encoding="utf-8") == "new"

    def test_temp_file_preserves_target_suffix(self, tmp_path):
        """Temp file gets the target's suffix so subprocesses can detect format."""
        target = tmp_path / "output.wav"
        with atomic_path(target) as tmp:
            assert tmp.suffix == ".wav"
            tmp.write_bytes(b"data")

    def test_new_file_gets_umask_permissions(self, tmp_path):
        """New files use 0o666 & ~umask, not mkstemp's 0o600."""
        import besedy.lib.data.atomic_io as mod
        target = tmp_path / "new.txt"
        atomic_write_text(target, "content")
        mode = stat.S_IMODE(target.stat().st_mode)
        assert mode == 0o666 & ~mod._DEFAULT_UMASK

    def test_subprocess_inode_replacement_gets_fsynced(self, tmp_path):
        """When a subprocess replaces the temp file, the new content is fsynced."""
        target = tmp_path / "out.txt"
        with atomic_path(target) as tmp:
            tmp.unlink()
            tmp.write_text("from subprocess", encoding="utf-8")
        assert target.read_text(encoding="utf-8") == "from subprocess"

    def test_dir_fsync_failure_is_nonfatal(self, monkeypatch, tmp_path):
        """A directory-fsync failure after a successful replace must not fail
        the publish — the content is already fsynced and renamed into place."""
        if atomic_io_module._O_DIRECTORY == 0:
            pytest.skip("O_DIRECTORY not supported on this platform")

        real_open = os.open

        def fake_open(path, flags, *args, **kwargs):
            if flags & atomic_io_module._O_DIRECTORY:
                raise OSError("cannot fsync directory")
            return real_open(path, flags, *args, **kwargs)

        monkeypatch.setattr(atomic_io_module.os, "open", fake_open)

        target = tmp_path / "out.txt"
        atomic_write_text(target, "content")
        assert target.read_text(encoding="utf-8") == "content"


class TestAtomicWriteJson:
    def test_roundtrip(self, tmp_path):
        target = tmp_path / "out.json"
        data = {"key": "value", "numbers": [1, 2, 3]}
        atomic_write_json(target, data)
        assert json.loads(target.read_text(encoding="utf-8")) == data

    def test_json_kwargs_forwarded(self, tmp_path):
        target = tmp_path / "out.json"
        data = {"text": "Příliš žluťoučký kůň"}
        atomic_write_json(target, data, indent=2, ensure_ascii=False)
        raw = target.read_text(encoding="utf-8")
        assert "Příliš žluťoučký kůň" in raw
        assert "\n" in raw
        assert json.loads(raw) == data

    def test_no_temp_residue(self, tmp_path):
        target = tmp_path / "out.json"
        atomic_write_json(target, {"a": 1})
        assert [p.name for p in tmp_path.iterdir()] == ["out.json"]


class TestAtomicPath:
    def test_happy_path(self, tmp_path):
        target = tmp_path / "out.wav"
        with atomic_path(target) as tmp:
            tmp.write_bytes(b"audio data")
            assert not target.exists()
        assert target.read_bytes() == b"audio data"
        assert [p.name for p in tmp_path.iterdir()] == ["out.wav"]

    def test_overwrites_existing_file(self, tmp_path):
        target = tmp_path / "out.txt"
        target.write_text("old", encoding="utf-8")
        with atomic_path(target) as tmp:
            tmp.write_text("new", encoding="utf-8")
        assert target.read_text(encoding="utf-8") == "new"

    def test_follows_symlink_to_target(self, tmp_path):
        target = tmp_path / "real.txt"
        link = tmp_path / "link.txt"
        target.write_text("old", encoding="utf-8")
        link.symlink_to(target)
        atomic_write_text(link, "new")
        assert link.is_symlink()
        assert target.read_text(encoding="utf-8") == "new"

    def test_dangling_symlink_becomes_valid(self, tmp_path):
        target = tmp_path / "real.txt"
        link = tmp_path / "link.txt"
        link.symlink_to(target)
        atomic_write_text(link, "new")
        assert link.is_symlink()
        assert target.read_text(encoding="utf-8") == "new"


class TestNoFollowSymlink:
    def test_no_follow_rejects_preexisting_symlink(self, tmp_path):
        protected = tmp_path / "protected.txt"
        protected.write_text("sentinel", encoding="utf-8")
        destination = tmp_path / "state.txt"
        destination.symlink_to(protected.name)

        with pytest.raises(OSError, match="Refusing atomic publication through symlink"):
            atomic_write_text(destination, "replacement", follow_symlinks=False)

        assert destination.is_symlink()
        assert protected.read_text(encoding="utf-8") == "sentinel"

    def test_no_follow_preserves_mode(self, tmp_path):
        """Mode preservation works on the no-follow path (not just mkstemp default)."""
        destination = tmp_path / "state.txt"
        destination.write_text("old", encoding="utf-8")
        destination.chmod(0o640)

        atomic_write_text(destination, "new", follow_symlinks=False)

        assert stat.S_IMODE(destination.stat().st_mode) == 0o640
        assert destination.read_text(encoding="utf-8") == "new"

    def test_no_follow_path_rejects_symlink_via_context(self, tmp_path):
        """atomic_path (not just atomic_write_text) refuses a preexisting symlink."""
        protected = tmp_path / "protected.txt"
        protected.write_text("sentinel", encoding="utf-8")
        destination = tmp_path / "state.txt"
        destination.symlink_to(protected.name)

        with pytest.raises(OSError, match="Refusing atomic publication through symlink"):
            with atomic_path(destination, follow_symlinks=False) as tmp:
                tmp.write_text("replacement", encoding="utf-8")

        assert destination.is_symlink()
        assert protected.read_text(encoding="utf-8") == "sentinel"

    def test_no_follow_json_keyword_not_forwarded_to_json_dumps(self, tmp_path):
        """follow_symlinks is consumed by atomic_write_json, not leaked into json.dumps."""
        destination = tmp_path / "state.json"
        atomic_write_json(destination, {"value": 1}, follow_symlinks=False, sort_keys=True)
        assert destination.read_text(encoding="utf-8") == '{"value": 1}'
