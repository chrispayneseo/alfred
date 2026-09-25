"""Sandboxed read-only local file access for Alfred Core.

Only a dedicated configured root is visible. Callers use relative paths; hidden
entries, symlinks, path escapes and binary files are rejected. Reads and searches
are deliberately bounded to keep this integration safe for conversational use.
"""

from __future__ import annotations

import os
from pathlib import Path

from . import config


TEXT_SUFFIXES = {
    "", ".txt", ".md", ".markdown", ".csv", ".json", ".jsonl", ".log",
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".xml", ".html",
    ".htm", ".css", ".py", ".js", ".jsx", ".ts", ".tsx", ".sql", ".sh",
}
MAX_LIST_ENTRIES = 100
MAX_SEARCH_RESULTS = 20
MAX_SEARCH_FILES = 300
MAX_SEARCH_BYTES = 2 * 1024 * 1024
MAX_RETURN_CHARS = 20000


def configured() -> bool:
    return bool(config.settings.files_enabled and config.settings.files_root.strip())


def _root() -> Path:
    if not configured():
        raise RuntimeError("Local files integration is not enabled")
    root = Path(config.settings.files_root).expanduser()
    try:
        resolved = root.resolve(strict=True)
    except FileNotFoundError as exc:
        raise RuntimeError("Local files root does not exist") from exc
    if not resolved.is_dir():
        raise RuntimeError("Local files root is not a directory")
    return resolved


def _clean_relative(value: str | None, *, default: str = ".") -> str:
    raw = default if value is None else value
    if not isinstance(raw, str):
        raise ValueError("File path must be text")
    clean = raw.strip() or default
    if "\x00" in clean:
        raise ValueError("File path is invalid")
    path = Path(clean)
    if path.is_absolute():
        raise ValueError("Only relative file paths are allowed")
    parts = [part for part in path.parts if part not in {"", "."}]
    if any(part == ".." for part in parts):
        raise ValueError("Parent path traversal is not allowed")
    if any(part.startswith(".") for part in parts):
        raise PermissionError("Hidden files and folders are not available")
    return str(Path(*parts)) if parts else "."


def _reject_symlink_components(root: Path, clean: str) -> None:
    if clean == ".":
        return
    current = root
    for part in Path(clean).parts:
        current = current / part
        # lexists-equivalent behaviour: is_symlink works even for a broken link.
        if current.is_symlink():
            raise PermissionError("Symlinks are not available")


def _resolve(relative: str | None, *, directory: bool | None = None) -> tuple[Path, Path, str]:
    root = _root()
    clean = _clean_relative(relative)
    _reject_symlink_components(root, clean)
    candidate = root if clean == "." else root / clean
    try:
        resolved = candidate.resolve(strict=True)
    except FileNotFoundError as exc:
        raise FileNotFoundError("File or folder not found") from exc
    if resolved != root and root not in resolved.parents:
        raise PermissionError("File path escapes the configured root")
    if directory is True and not resolved.is_dir():
        raise NotADirectoryError("Folder not found")
    if directory is False and not resolved.is_file():
        raise FileNotFoundError("File not found")
    return root, resolved, clean


def _relative(root: Path, path: Path) -> str:
    value = path.relative_to(root).as_posix()
    return value or "."


def _visible_entry(path: Path) -> bool:
    return not path.name.startswith(".") and not path.is_symlink()


def _text_candidate(path: Path) -> bool:
    return path.is_file() and not path.is_symlink() and path.suffix.casefold() in TEXT_SUFFIXES


def _read_bytes(path: Path, limit: int) -> tuple[bytes, bool]:
    size = path.stat().st_size
    with path.open("rb") as handle:
        data = handle.read(limit + 1)
    truncated = size > limit or len(data) > limit
    return data[:limit], truncated


def _decode_text(data: bytes) -> str:
    if b"\x00" in data:
        raise ValueError("Binary files are not readable through this integration")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("Only UTF-8 text files are readable through this integration") from exc


def list_directory(path: str = ".", limit: int = 50) -> dict:
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > MAX_LIST_ENTRIES:
        raise ValueError(f"File list limit must be between 1 and {MAX_LIST_ENTRIES}")
    root, folder, clean = _resolve(path, directory=True)
    entries = [entry for entry in folder.iterdir() if _visible_entry(entry)]
    entries.sort(key=lambda value: (not value.is_dir(), value.name.casefold()))
    items = []
    for entry in entries:
        kind = "folder" if entry.is_dir() else "file" if entry.is_file() else "other"
        if kind == "other":
            continue
        items.append({
            "name": entry.name,
            "path": _relative(root, entry),
            "kind": kind,
            "size": entry.stat().st_size if kind == "file" else None,
        })
        if len(items) >= limit:
            break
    return {"ok": True, "path": clean, "items": items, "read_only": True}


def read_file(path: str, max_chars: int = 12000) -> dict:
    if not isinstance(max_chars, int) or isinstance(max_chars, bool) or max_chars < 1 or max_chars > MAX_RETURN_CHARS:
        raise ValueError(f"max_chars must be between 1 and {MAX_RETURN_CHARS}")
    root, file_path, _ = _resolve(path, directory=False)
    if not _text_candidate(file_path):
        raise ValueError("This file type is not available through the text reader")
    byte_limit = max(1024, min(config.settings.files_max_read_bytes, 1024 * 1024))
    data, byte_truncated = _read_bytes(file_path, byte_limit)
    text = _decode_text(data)
    char_truncated = len(text) > max_chars
    content = text[:max_chars]
    return {
        "ok": True,
        "path": _relative(root, file_path),
        "content": content,
        "size": file_path.stat().st_size,
        "truncated": bool(byte_truncated or char_truncated),
        "read_only": True,
    }


def search_files(query: str, path: str = ".", limit: int = 10) -> dict:
    if not isinstance(query, str) or len(query.strip()) < 2 or len(query.strip()) > 200:
        raise ValueError("File search query must be between 2 and 200 characters")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > MAX_SEARCH_RESULTS:
        raise ValueError(f"File search limit must be between 1 and {MAX_SEARCH_RESULTS}")
    root, base, clean = _resolve(path, directory=True)
    needle = query.strip().casefold()
    results: list[dict] = []
    files_scanned = 0
    bytes_scanned = 0
    scan_truncated = False

    for current, dirs, files in os.walk(base, followlinks=False):
        current_path = Path(current)
        dirs[:] = [
            name for name in dirs
            if not name.startswith(".") and not (current_path / name).is_symlink()
        ]
        for name in sorted(files, key=str.casefold):
            candidate = current_path / name
            if name.startswith(".") or not _text_candidate(candidate):
                continue
            try:
                resolved = candidate.resolve(strict=True)
            except FileNotFoundError:
                continue
            if resolved != root and root not in resolved.parents:
                continue
            files_scanned += 1
            if files_scanned > MAX_SEARCH_FILES:
                scan_truncated = True
                break

            relative = _relative(root, resolved)
            filename_match = needle in name.casefold() or needle in relative.casefold()
            remaining = MAX_SEARCH_BYTES - bytes_scanned
            if remaining <= 0:
                scan_truncated = True
                break
            per_file_limit = min(max(1024, config.settings.files_max_read_bytes), remaining, 256 * 1024)
            data, _ = _read_bytes(resolved, per_file_limit)
            bytes_scanned += len(data)
            try:
                text = _decode_text(data)
            except ValueError:
                continue

            matched_content = False
            for line_number, line in enumerate(text.splitlines(), start=1):
                position = line.casefold().find(needle)
                if position < 0:
                    continue
                matched_content = True
                start = max(0, position - 80)
                end = min(len(line), position + len(needle) + 120)
                excerpt = line[start:end].strip()[:260]
                results.append({
                    "path": relative,
                    "line": line_number,
                    "excerpt": excerpt,
                })
                if len(results) >= limit:
                    break
            if len(results) >= limit:
                break
            if filename_match and not matched_content:
                results.append({"path": relative, "line": None, "excerpt": ""})
                if len(results) >= limit:
                    break
        if len(results) >= limit or scan_truncated:
            break

    return {
        "ok": True,
        "path": clean,
        "query": query.strip(),
        "results": results,
        "files_scanned": min(files_scanned, MAX_SEARCH_FILES),
        "scan_truncated": scan_truncated,
        "read_only": True,
    }


def health() -> dict:
    if not configured():
        return {"state": "not_configured", "reachable": False, "mode": "read_only"}
    try:
        root = _root()
        return {
            "state": "ready",
            "reachable": True,
            "mode": "read_only",
            "root_label": root.name or "files",
        }
    except Exception:
        return {"state": "unavailable", "reachable": False, "mode": "read_only"}
