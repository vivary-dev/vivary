#!/usr/bin/env python3
"""tropo - the filesystem is the schema.

A document's type is the folder it lives in; its metadata is only what cannot
be derived from where it sits and what it says. See SPEC.md for the normative
model. This engine implements spec v1: config resolution, folder-as-type,
derivation, validation, and the `signal` report.

Usage:
  tropo [check] [paths...] [--lenient | --strict] [--json] [--quiet]
  tropo signal [paths...]
  tropo types
  tropo stats
  tropo graph [--json]
  tropo blast <id> [--depth N] [--json]
  tropo view [graph | blast <id>] [--out FILE]
  tropo plan <change-spec.toml> [--json]
  tropo query <text> [--mode text|vector|semantic] [--type TYPE] [--path GLOB] [--edge FIELD[:TARGET]]
  tropo find <text> [--budget N | --governed [--max-claims N]] [--json]
  tropo map [PATH | --root PATH] [--depth N] [--max-entries N] [--json]

Config is TOML (`.vivary/workspace.toml` for thin-v0.3; legacy `tropo.toml`
remains readable). Content frontmatter is YAML.
Requires Python 3.11+ (for tomllib). Governed find uses vivary-core.
Exit codes: 0 = clean, 1 = errors found, 2 = config/usage problem.
"""

import argparse
import asyncio
import copy
import datetime
import hashlib
import importlib
import importlib.util
import json
import math
import os
import platform
import re
import stat
import subprocess
import sys
import sysconfig
import tempfile
import time
import tomllib
import unicodedata
from typing import Any, Sequence, TypedDict
from collections import Counter, deque
from fnmatch import fnmatchcase

if os.name == "nt":
    import ctypes
    import msvcrt
    from ctypes import wintypes

    class _PublicFileBasicInfo(ctypes.Structure):
        _fields_ = [
            ("creation_time", ctypes.c_longlong),
            ("last_access_time", ctypes.c_longlong),
            ("last_write_time", ctypes.c_longlong),
            ("change_time", ctypes.c_longlong),
            ("file_attributes", wintypes.DWORD),
        ]

    class _PublicByHandleFileInformation(ctypes.Structure):
        _fields_ = [
            ("file_attributes", wintypes.DWORD),
            ("creation_time", wintypes.FILETIME),
            ("last_access_time", wintypes.FILETIME),
            ("last_write_time", wintypes.FILETIME),
            ("volume_serial_number", wintypes.DWORD),
            ("file_size_high", wintypes.DWORD),
            ("file_size_low", wintypes.DWORD),
            ("number_of_links", wintypes.DWORD),
            ("file_index_high", wintypes.DWORD),
            ("file_index_low", wintypes.DWORD),
        ]

    _PUBLIC_KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _PUBLIC_CREATE_FILE = _PUBLIC_KERNEL32.CreateFileW
    _PUBLIC_CREATE_FILE.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    _PUBLIC_CREATE_FILE.restype = wintypes.HANDLE
    _PUBLIC_GET_FILE_INFO = _PUBLIC_KERNEL32.GetFileInformationByHandle
    _PUBLIC_GET_FILE_INFO.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(_PublicByHandleFileInformation),
    ]
    _PUBLIC_GET_FILE_INFO.restype = wintypes.BOOL
    _PUBLIC_GET_FILE_INFO_EX = _PUBLIC_KERNEL32.GetFileInformationByHandleEx
    _PUBLIC_GET_FILE_INFO_EX.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    _PUBLIC_GET_FILE_INFO_EX.restype = wintypes.BOOL
    _PUBLIC_CLOSE_HANDLE = _PUBLIC_KERNEL32.CloseHandle
    _PUBLIC_CLOSE_HANDLE.argtypes = [wintypes.HANDLE]
    _PUBLIC_CLOSE_HANDLE.restype = wintypes.BOOL
    _PUBLIC_INVALID_HANDLE = ctypes.c_void_p(-1).value
    _PUBLIC_FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
    _PUBLIC_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    _PUBLIC_FILE_READ_ATTRIBUTES = 0x00000080
    _PUBLIC_FILE_SHARE_ALL = 0x00000001 | 0x00000002 | 0x00000004
    _PUBLIC_OPEN_EXISTING = 3

__version__ = "0.5.2"
RECEIPT_ENV = "VIVARY_RECEIPT_LOG"
RECEIPT_SCHEMA = "vivary.run_receipt.v1"
COMMANDS = (
    "check", "signal", "types", "stats", "graph", "blast", "view", "plan",
    "fix", "init", "migrate", "query", "find", "map",
)
RECEIPT_VALUE_FLAGS = {
    "--receipt", "--depth", "--max-entries", "--max-claims", "--out", "--packs",
    "--root", "--config", "--from", "--to", "--k", "--type", "--path", "--edge",
    "--snippet", "--budget",
}
RECEIPT_KNOWN_FLAGS = RECEIPT_VALUE_FLAGS | {
    "--budget", "--dry-run", "--explain", "--governed", "--help", "--json",
    "--lenient", "--quiet", "--strict", "--version", "--yes", "-h",
}
RECEIPT_RESERVED_WINDOWS_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

# ---------------------------------------------------------------------------
# Minimal YAML-subset parser for frontmatter (zero-dependency).
# Supports nested maps, block/inline lists, quoted scalars, comments.
# ---------------------------------------------------------------------------


class YamlError(Exception):
    def __init__(self, msg, lineno):
        super().__init__(msg)
        self.lineno = lineno


def _split_comment(s):
    in_s = in_d = False
    for i, ch in enumerate(s):
        if ch == "'" and not in_d:
            in_s = not in_s
        elif ch == '"' and not in_s:
            in_d = not in_d
        elif ch == "#" and not in_s and not in_d:
            if i == 0 or s[i - 1] in " \t":
                return s[:i].rstrip()
    return s.rstrip()


def _scalar(raw):
    raw = raw.strip()
    if raw == "" or raw in ("~", "null", "Null", "NULL"):
        return None
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        return raw[1:-1]
    if raw in ("true", "True", "TRUE"):
        return True
    if raw in ("false", "False", "FALSE"):
        return False
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        pass
    return raw


def _inline_list(raw):
    inner = raw.strip()[1:-1].strip()
    if not inner:
        return []
    items, buf, depth, in_s, in_d = [], "", 0, False, False
    for ch in inner:
        if ch == "'" and not in_d:
            in_s = not in_s
        elif ch == '"' and not in_s:
            in_d = not in_d
        elif ch in "[{" and not in_s and not in_d:
            depth += 1
        elif ch in "]}" and not in_s and not in_d:
            depth -= 1
        if ch == "," and depth == 0 and not in_s and not in_d:
            items.append(buf)
            buf = ""
        else:
            buf += ch
    items.append(buf)
    return [_scalar(x) for x in items]


KEY_RE = re.compile(r"^([^:\s][^:]*?):(\s+(.*)|\s*)$")


def parse_yaml(text):
    raw_lines = text.split("\n")
    lines = []
    for n, raw in enumerate(raw_lines, 1):
        if "\t" in raw[: len(raw) - len(raw.lstrip())]:
            raise YamlError("tab character used for indentation", n)
        stripped = _split_comment(raw)
        if not stripped.strip():
            continue
        indent = len(stripped) - len(stripped.lstrip(" "))
        lines.append((n, indent, stripped.strip()))

    pos = [0]

    def parse_block(min_indent):
        if pos[0] >= len(lines):
            return None
        _, indent, content = lines[pos[0]]
        if indent < min_indent:
            return None
        if content.startswith("- ") or content == "-":
            return parse_list(indent)
        return parse_map(indent)

    def parse_value(rest, parent_indent):
        rest = rest.strip()
        if rest in ("|", ">", "|-", ">-", "|+", ">+"):
            chunks = []
            while pos[0] < len(lines):
                _, ind, c = lines[pos[0]]
                if ind <= parent_indent:
                    break
                chunks.append(c)
                pos[0] += 1
            return "\n".join(chunks)
        if rest.startswith("[") and rest.endswith("]"):
            return _inline_list(rest)
        if rest == "{}":
            return {}
        if rest == "":
            return parse_block(parent_indent + 1)
        return _scalar(rest)

    def parse_map(block_indent):
        result, order = {}, []
        while pos[0] < len(lines):
            lineno, indent, content = lines[pos[0]]
            if indent < block_indent:
                break
            if indent > block_indent:
                raise YamlError("unexpected indentation", lineno)
            if content.startswith("- "):
                raise YamlError("list item inside mapping", lineno)
            m = KEY_RE.match(content)
            if not m:
                raise YamlError(f"cannot parse line: {content!r}", lineno)
            key = m.group(1).strip().strip("\"'")
            rest = m.group(3) or ""
            if key in result:
                raise YamlError(f"duplicate key {key!r}", lineno)
            pos[0] += 1
            result[key] = parse_value(rest, block_indent)
            order.append((key, lineno))
        result["__lines__"] = dict(order) if order else {}
        return result

    def parse_list(block_indent):
        result = []
        while pos[0] < len(lines):
            lineno, indent, content = lines[pos[0]]
            if indent != block_indent or not (content.startswith("- ") or content == "-"):
                break
            item = content[1:].strip()
            pos[0] += 1
            if item == "":
                result.append(None)
            elif KEY_RE.match(item) and not item.startswith(("http:", "https:")):
                raise YamlError("mapping inside list is not supported in frontmatter", lineno)
            elif item.startswith("[") and item.endswith("]"):
                result.append(_inline_list(item))
            else:
                result.append(_scalar(item))
        return result

    doc = parse_block(0)
    if pos[0] < len(lines):
        raise YamlError("could not parse document past this line", lines[pos[0]][0])
    return doc if doc is not None else {}


def strip_meta(obj):
    if isinstance(obj, dict):
        return {k: strip_meta(v) for k, v in obj.items() if k != "__lines__"}
    if isinstance(obj, list):
        return [strip_meta(v) for v in obj]
    return obj


UTF8_BOM = "\ufeff"
FM_RE = re.compile(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(\r?\n|$)", re.S)


def _strip_leading_bom(text):
    return text[len(UTF8_BOM):] if text.startswith(UTF8_BOM) else text


def _frontmatter_match(text):
    normalized = _strip_leading_bom(text)
    return FM_RE.match(normalized), normalized


def extract_frontmatter(text):
    """Return (yaml_text, body) or (None, whole_text) when no block is present."""
    m, normalized = _frontmatter_match(text)
    if not normalized.startswith("---"):
        return None, normalized
    if not m:
        return None, normalized
    return m.group(1), normalized[m.end():]


# ---------------------------------------------------------------------------
# Field-type checks
# ---------------------------------------------------------------------------

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
URL_RE = re.compile(r"^https?://\S+$")


def check_field_type(value, spec):
    """Return an error string, or None if value conforms to spec."""
    if value is None:
        return None
    if spec == "any":
        return None
    if spec.startswith("enum:"):
        allowed = spec[5:].split("|")
        return None if str(value) in allowed else \
            f"expected one of [{', '.join(allowed)}], got {value!r}"
    if spec == "string":
        return None if not isinstance(value, (list, dict)) else \
            f"expected a string, got a {type(value).__name__}"
    if spec == "date":
        if isinstance(value, (list, dict)):
            return "expected a date (YYYY-MM-DD), got a " + type(value).__name__
        return None if DATE_RE.match(str(value)) else f"expected YYYY-MM-DD, got {value!r}"
    if spec == "datetime":
        return None if DATETIME_RE.match(str(value)) else f"expected ISO-8601 datetime, got {value!r}"
    if spec in ("slug", "ref"):
        return None if isinstance(value, str) and SLUG_RE.match(value) else \
            f"expected a {spec} (lowercase a-z 0-9 . _ -), got {value!r}"
    if spec == "url":
        return None if isinstance(value, str) and URL_RE.match(value) else \
            f"expected a URL (http/https), got {value!r}"
    if spec in ("list", "string-list", "ref-list"):
        if not isinstance(value, list):
            return f"expected a list, got {type(value).__name__} {value!r}"
        if spec in ("string-list", "ref-list"):
            for item in value:
                if isinstance(item, (list, dict)):
                    return "expected a flat list"
                if spec == "ref-list" and not (isinstance(item, str) and SLUG_RE.match(item)):
                    return f"expected a list of refs (slugs), got item {item!r}"
        return None
    if spec == "bool":
        return None if isinstance(value, bool) else f"expected true/false, got {value!r}"
    if spec == "number":
        return None if isinstance(value, (int, float)) and not isinstance(value, bool) else \
            f"expected a number, got {value!r}"
    return f"unknown field spec {spec!r}"


# ---------------------------------------------------------------------------
# Config: load, compose packs/overlays (tighten-only), build registry
# ---------------------------------------------------------------------------

CONFIG_NAME = "tropo.toml"
DERIVED_SPECS = {"id": "slug", "slug": "slug", "title": "string",
                 "created": "date", "updated": "date"}
DEFAULT_EXCLUDE = [".git", ".tropo", ".claude", "node_modules", ".obsidian"]
BUNDLED_PACKS = {
    "coordination": """
[base.optional]
assignee = "string"
""",
    "dev-project": """
[types.decision]
folder   = "decisions"
required = { status = "enum:proposed|accepted|superseded", date = "date" }
optional = { supersedes = "ref", superseded_by = "ref", deciders = "string-list" }

[types.runbook]
folder   = "runbooks"
required = { owner = "string" }
optional = { severity = "enum:low|medium|high|critical", last_drill = "date" }

[types.spec]
folder   = "specs"
required = { status = "enum:draft|review|stable|deprecated" }
optional = { supersedes = "ref" }
""",
    "repo-graph": """
[base]
allow_untyped = true

[base.optional]
id = "slug"
type = "string"
project = "string"
status = "enum:active|closed-local|closed|blocked|deferred|superseded|draft"
created = "date"
updated = "date"
tags = "string-list"
aliases = "string-list"
related = "string-list"
source_of_truth = "string-list"

[types.module]
folder = "modules"

[types.module.required]
project = "string"
status = "enum:active|closed-local|closed|blocked|deferred|superseded|draft"
module_area = "string"

[types.module.optional]
app_repo_path = "string"
source_files = "string-list"
test_files = "string-list"
related_modules = "string-list"
related_changes = "string-list"
verification = "any"
gates = "string-list"

[types.implementation_slice]
folder = "changes"

[types.implementation_slice.required]
project = "string"
status = "enum:active|closed-local|closed|blocked|deferred|superseded|draft"
slice = "string"

[types.implementation_slice.optional]
branch = "string"
app_repo_path = "string"
local_base_sha = "string"
remote_dev_sha_at_graph_creation = "string"
provider_spend = "string"
push_or_merge = "string"
related_modules = "string-list"
related_changes = "string-list"
verification = "any"
gates = "string-list"

[types.decision]
folder = "decisions"

[types.decision.required]
project = "string"
status = "enum:proposed|accepted|superseded|deferred"
date = "date"

[types.decision.optional]
supersedes = "string"
superseded_by = "string"
related_modules = "string-list"
related_changes = "string-list"
rationale = "string"

[types.verification]
folder = "verification"

[types.verification.required]
project = "string"
status = "enum:planned|passed|failed|blocked|deferred"
target = "string"

[types.verification.optional]
command = "string"
evidence = "any"
related_modules = "string-list"
related_changes = "string-list"

[types.gate]
folder = "gates"

[types.gate.required]
project = "string"
status = "enum:open|approved|rejected|deferred"
gate = "string"

[types.gate.optional]
approver = "string"
approved_at = "datetime"
command_intent = "string"
related_modules = "string-list"
related_changes = "string-list"
""",
}


class ConfigError(Exception):
    pass


def _enum_set(spec):
    return set(spec[5:].split("|")) if spec.startswith("enum:") else None


def _spec_tightens(old, new):
    """True if `new` is at least as strict as `old` (a legal tightening)."""
    if old == new:
        return True
    a, b = _enum_set(old), _enum_set(new)
    if a is not None and b is not None:
        return b <= a  # narrowing the allowed set is tighter
    return False  # any other spec change is a loosening/conflict -> forbidden


def _merge_type(base, add, type_name):
    """Merge type def `add` onto `base` in place, enforcing the tighten-only law."""
    base.setdefault("required", {})
    base.setdefault("optional", {})
    base.setdefault("folders", [])
    for f in add.get("folders", []):
        if f not in base["folders"]:
            base["folders"].append(f)
    for f, spec in (add.get("required") or {}).items():
        if f in base["optional"]:  # optional -> required is tighter
            del base["optional"][f]
        if f in base["required"] and not _spec_tightens(base["required"][f], spec):
            raise ConfigError(f"type {type_name!r} field {f!r}: {spec!r} loosens {base['required'][f]!r}")
        base["required"][f] = spec
    for f, spec in (add.get("optional") or {}).items():
        if f in base["required"]:
            raise ConfigError(f"type {type_name!r} field {f!r}: required->optional is a loosening")
        if f in base["optional"] and not _spec_tightens(base["optional"][f], spec):
            raise ConfigError(f"type {type_name!r} field {f!r}: {spec!r} loosens {base['optional'][f]!r}")
        base["optional"][f] = spec


def _normalize_type(name, raw):
    folder = raw.get("folder", name)
    folders = folder if isinstance(folder, list) else [folder]
    return {
        "folders": list(folders),
        "required": dict(raw.get("required") or {}),
        "optional": dict(raw.get("optional") or {}),
    }


def _merge_config(base, add):
    """Compose a partial config `add` onto `base` (tighten-only)."""
    b_base, a_base = base.setdefault("base", {}), add.get("base", {})
    b_base.setdefault("derive", [])
    b_base.setdefault("required", {})
    b_base.setdefault("optional", {})
    for d in a_base.get("derive", []):
        if d not in b_base["derive"]:
            b_base["derive"].append(d)
    for f, spec in (a_base.get("required") or {}).items():
        if f in b_base["optional"]:
            del b_base["optional"][f]
        if f in b_base["required"] and not _spec_tightens(b_base["required"][f], spec):
            raise ConfigError(f"base field {f!r}: {spec!r} loosens {b_base['required'][f]!r}")
        b_base["required"][f] = spec
    for f, spec in (a_base.get("optional") or {}).items():
        if f in b_base["required"]:
            raise ConfigError(f"base field {f!r}: required->optional is a loosening")
        if f in b_base["optional"] and not _spec_tightens(b_base["optional"][f], spec):
            raise ConfigError(f"base field {f!r}: {spec!r} loosens {b_base['optional'][f]!r}")
        b_base["optional"][f] = spec
    if "allow_untyped" in a_base:
        if b_base.get("allow_untyped") is False and a_base["allow_untyped"] is True:
            raise ConfigError("base.allow_untyped: true loosens an inherited false")
        b_base["allow_untyped"] = a_base["allow_untyped"]
    if "strict" in a_base:
        if b_base.get("strict") is True and a_base["strict"] is False:
            raise ConfigError("base.strict: false loosens an inherited true")
        b_base["strict"] = a_base["strict"]
    if "timezone" in a_base:
        b_base["timezone"] = a_base["timezone"]
    base.setdefault("exclude", [])
    for e in add.get("exclude", []):
        if e not in base["exclude"]:
            base["exclude"].append(e)
    types = base.setdefault("types", {})
    for name, raw in (add.get("types") or {}).items():
        _merge_type(types.setdefault(name, {}), _normalize_type(name, raw), name)
    return base


def _read_toml(path):
    try:
        with open(path, "rb") as fh:
            return tomllib.loads(fh.read().decode("utf-8-sig"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as e:
        raise ConfigError(f"{path}: {e}")


def _read_pack(name, root, script_dir):
    local_pack = os.path.join(root, ".tropo", "packs", name + ".toml")
    if os.path.isfile(local_pack):
        return _read_toml(local_pack)
    if name in BUNDLED_PACKS:
        try:
            return tomllib.loads(BUNDLED_PACKS[name])
        except tomllib.TOMLDecodeError as e:
            raise ConfigError(f"bundled pack {name!r}: {e}")
    repo_pack = os.path.join(script_dir, "packs", name + ".toml")
    if os.path.isfile(repo_pack):
        return _read_toml(repo_pack)
    raise ConfigError(f"pack {name!r} not found (looked in .tropo/packs and bundled packs)")


THIN_CONFIG_REL = os.path.join(".vivary", "workspace.toml")
THIN_WORKSPACE_CONTRACT = "thin-v0.3"
THIN_ADAPTERS = {"agents", "claude"}
THIN_CAPABILITIES = {"cocoindex-code"}


def _workspace_relative_path(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"workspace.{field} must be a non-empty relative path")
    normalized = value.replace("\\", "/")
    if (
        normalized.startswith("/")
        or re.match(r"^[A-Za-z]:", normalized)
        or any(part in ("", ".", "..") for part in normalized.split("/"))
    ):
        raise ConfigError(f"workspace.{field} must stay inside the workspace")
    return normalized.rstrip("/")


def _validate_thin_workspace(raw, thin_path, root):
    if os.path.islink(thin_path):
        raise ConfigError(f"{thin_path}: thin workspace config cannot be a symlink")
    root_real = os.path.realpath(root)
    thin_real = os.path.realpath(thin_path)
    try:
        inside = os.path.commonpath([root_real, thin_real]) == root_real
    except ValueError:
        inside = False
    if not inside:
        raise ConfigError(f"{thin_path}: thin workspace config escapes its workspace")
    if raw.get("version") != 1 or isinstance(raw.get("version"), bool):
        raise ConfigError(f"{thin_path}: version must be 1")
    workspace = raw.get("workspace")
    if not isinstance(workspace, dict):
        raise ConfigError(f"{thin_path}: missing [workspace] metadata")
    if workspace.get("contract") != THIN_WORKSPACE_CONTRACT:
        raise ConfigError(
            f"{thin_path}: workspace.contract must be {THIN_WORKSPACE_CONTRACT!r}"
        )
    preset = workspace.get("preset")
    if not isinstance(preset, str) or not preset:
        raise ConfigError(f"{thin_path}: workspace.preset must be a non-empty string")
    _workspace_relative_path(workspace.get("state"), "state")

    protected = []
    for field in ("private", "runtime"):
        values = workspace.get(field)
        if not isinstance(values, list) or not values:
            raise ConfigError(f"{thin_path}: workspace.{field} must be a non-empty list")
        protected.extend(_workspace_relative_path(value, field) for value in values)
    adapters = workspace.get("adapters")
    if (
        not isinstance(adapters, list)
        or any(not isinstance(adapter, str) or adapter not in THIN_ADAPTERS for adapter in adapters)
        or len(set(adapters)) != len(adapters)
    ):
        raise ConfigError(
            f"{thin_path}: workspace.adapters may contain agents and claude once each"
        )
    capabilities = workspace.get("capabilities", [])
    if (
        not isinstance(capabilities, list)
        or any(
            not isinstance(capability, str) or capability not in THIN_CAPABILITIES
            for capability in capabilities
        )
        or len(set(capabilities)) != len(capabilities)
    ):
        raise ConfigError(
            f"{thin_path}: workspace.capabilities may contain cocoindex-code once"
        )

    excludes = raw.get("exclude")
    if not isinstance(excludes, list) or any(not isinstance(item, str) for item in excludes):
        raise ConfigError(f"{thin_path}: exclude must be a list of paths")
    normalized_excludes = {item.replace("\\", "/").strip("/") for item in excludes}
    missing = [path for path in protected if path not in normalized_excludes]
    if missing:
        raise ConfigError(
            f"{thin_path}: exclude must protect workspace private/runtime paths: "
            + ", ".join(missing)
        )


def _competing_thin_ancestor(root):
    current = os.path.dirname(os.path.abspath(root))
    while True:
        candidate = os.path.join(current, THIN_CONFIG_REL)
        if os.path.isfile(candidate):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def find_root(start):
    """Walk up to the nearest legacy or thin-v0.3 workspace root."""
    d = os.path.abspath(start)
    if os.path.isfile(d):
        d = os.path.dirname(d)
    thin_roots = []
    nearest_legacy = None
    while True:
        if os.path.isfile(os.path.join(d, THIN_CONFIG_REL)):
            thin_roots.append(d)
        if nearest_legacy is None and os.path.isfile(os.path.join(d, CONFIG_NAME)):
            nearest_legacy = d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    if len(thin_roots) > 1:
        raise ConfigError(
            "competing thin-v0.3 roots: " + ", ".join(thin_roots)
        )
    if thin_roots:
        return thin_roots[0]
    return nearest_legacy


class Config:
    def __init__(self, data, root):
        self.root = root
        base = data.get("base", {})
        self.derive = base.get("derive", [])
        self.base_required = base.get("required", {})
        self.base_optional = base.get("optional", {})
        self.allow_untyped = base.get("allow_untyped", True)
        self.strict = base.get("strict", True)
        self.types = data.get("types", {})
        self.exclude = DEFAULT_EXCLUDE + [e for e in data.get("exclude", [])
                                          if e not in DEFAULT_EXCLUDE]
        # folder basename -> type name
        self.folder_map = {}
        for name, t in self.types.items():
            for folder in t.get("folders", []):
                if folder in self.folder_map and self.folder_map[folder] != name:
                    raise ConfigError(
                        f"folder {folder!r} maps to both {self.folder_map[folder]!r} and {name!r}")
                self.folder_map[folder] = name

    def fields_for(self, type_name):
        required = dict(self.base_required)
        known = dict(self.base_optional)
        known.update(required)
        for d in self.derive:
            known[d] = DERIVED_SPECS.get(d, "any")
        t = self.types.get(type_name)
        if t:
            type_required = dict(t.get("required", {}))
            required.update(type_required)
            known.update(type_required)
            known.update(t.get("optional", {}))
        return required, known


def _compose(root, script_dir, config_path=None):
    thin_path = os.path.join(root, THIN_CONFIG_REL)
    selected_path = config_path or (
        thin_path if os.path.isfile(thin_path) else os.path.join(root, CONFIG_NAME)
    )
    raw = _read_toml(selected_path)
    if (
        config_path is None
        and os.path.normcase(os.path.abspath(selected_path))
        == os.path.normcase(os.path.abspath(thin_path))
    ):
        ancestor = _competing_thin_ancestor(root)
        if ancestor is not None:
            raise ConfigError(
                f"competing thin-v0.3 roots: {os.path.abspath(root)}, {ancestor}"
            )
        _validate_thin_workspace(raw, thin_path, root)
    composed = {"base": {}, "types": {}, "exclude": []}
    for pack in raw.get("packs", []):
        _merge_config(composed, _read_pack(pack, root, script_dir))
    _merge_config(composed, raw)  # _merge_config normalizes each type's raw `folder`
    root_overlay = os.path.join(root, CONFIG_NAME)
    if (
        config_path is None
        and os.path.normcase(os.path.abspath(selected_path))
        == os.path.normcase(os.path.abspath(thin_path))
        and os.path.isfile(root_overlay)
    ):
        _merge_config(composed, _read_toml(root_overlay))
    return composed


def _rebase_overlay_config(raw, overlay_path, root):
    data = copy.deepcopy(raw)
    overlay_dir = os.path.dirname(os.path.abspath(overlay_path))
    root_abs = os.path.abspath(root)
    overlay_rel = os.path.relpath(overlay_dir, root_abs)
    if overlay_rel in (".", "") or overlay_rel.startswith(".."):
        return data
    rebased = []
    for pattern in data.get("exclude", []):
        if not isinstance(pattern, str):
            rebased.append(pattern)
            continue
        normalized = pattern.replace("\\", "/").strip()
        if not normalized or normalized.startswith("/") or "/" not in normalized:
            rebased.append(pattern)
            continue
        if normalized.startswith("./"):
            normalized = normalized[2:]
        rebased.append(f"{overlay_rel.replace(os.sep, '/')}/{normalized}")
    if rebased:
        data["exclude"] = rebased
    return data


def load_config(root, script_dir, config_path=None):
    return Config(_compose(root, script_dir, config_path), root)


def _overlay_paths(dirpath, root):
    """Nested tropo.toml between root (exclusive) and dirpath (inclusive)."""
    root_abs = os.path.abspath(root)
    rel = os.path.relpath(os.path.abspath(dirpath), root_abs)
    if rel in (".", "") or rel.startswith(".."):
        return []
    out, d = [], root_abs
    for part in rel.split(os.sep):
        d = os.path.join(d, part)
        nested_thin = os.path.join(d, THIN_CONFIG_REL)
        if os.path.isfile(nested_thin):
            raise ConfigError(f"competing nested thin-v0.3 root: {d}")
        cfg = os.path.join(d, CONFIG_NAME)
        if os.path.isfile(cfg):
            out.append(cfg)
    return out


class ConfigResolver:
    """Resolves the effective Config at any directory by composing overlays
    (nested tropo.toml, SPEC §5.5) onto the root config — tighten-only, cached."""

    def __init__(self, root, script_dir, config_path=None):
        self.root = os.path.abspath(root)
        self.script_dir = script_dir
        self._base_dict = _compose(root, script_dir, config_path)
        self.base = Config(copy.deepcopy(self._base_dict), self.root)
        self._cache = {}

    def for_dir(self, dirpath):
        key = os.path.normcase(os.path.abspath(dirpath))
        if key not in self._cache:
            overlays = _overlay_paths(dirpath, self.root)
            if overlays:
                composed = copy.deepcopy(self._base_dict)
                for ov in overlays:
                    _merge_config(composed, _rebase_overlay_config(_read_toml(ov), ov, self.root))
                self._cache[key] = Config(composed, self.root)
            else:
                self._cache[key] = self.base
        return self._cache[key]


class _StaticResolver:
    """Wraps a single Config so analyze() can treat it like a resolver."""

    def __init__(self, config):
        self.base = config
        self.root = config.root

    def for_dir(self, dirpath):
        return self.base


# ---------------------------------------------------------------------------
# Type resolution + derivation
# ---------------------------------------------------------------------------

def slugify(name):
    s = re.sub(r"\.(md|markdown)$", "", os.path.basename(name)).lower()
    s = re.sub(r"[^a-z0-9._-]+", "-", s).strip("-")
    return s or "untitled"


def type_for(full, config):
    d = os.path.dirname(os.path.abspath(full))
    root = os.path.abspath(config.root)
    while True:
        if os.path.basename(d) in config.folder_map:
            return config.folder_map[os.path.basename(d)]
        if os.path.normcase(os.path.normpath(d)) == os.path.normcase(os.path.normpath(root)):
            return None
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def _git_dates(full):
    try:
        out = subprocess.run(
            ["git", "-C", os.path.dirname(full), "log", "--format=%ad",
             "--date=short", "--", os.path.basename(full)],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None, None
    lines = [ln for ln in out.stdout.splitlines() if ln.strip()]
    if not lines:
        return None, None
    return lines[-1], lines[0]  # created (oldest), updated (newest)


INDEX_NAMES = ("readme", "index", "_index")


def _derive_id(full):
    """A document's id is its filename slug — except an *index document*
    (README/index, or a file named after its folder) takes the folder's id,
    because such a document *is* its folder (e.g. projects/tropo/README.md → tropo)."""
    base = re.sub(r"\.(md|markdown)$", "", os.path.basename(full), flags=re.I)
    parent = os.path.basename(os.path.dirname(os.path.abspath(full)))
    if base.lower() in INDEX_NAMES or base.lower() == parent.lower():
        return slugify(parent)
    return slugify(base)


def derive(full, body, *, use_git_dates=True):
    created, updated = _git_dates(full) if use_git_dates else (None, None)
    if not updated:
        st = os.stat(full)
        created = datetime.date.fromtimestamp(min(st.st_mtime, st.st_ctime)).isoformat()
        updated = datetime.date.fromtimestamp(st.st_mtime).isoformat()
    sid = _derive_id(full)
    m = re.search(r"^#\s+(.+)$", body, re.M)
    title = m.group(1).strip() if m else sid.replace("-", " ").title()
    return {"id": sid, "slug": sid, "title": title, "created": created, "updated": updated}


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

class Finding:
    __slots__ = ("path", "line", "level", "code", "message")

    def __init__(self, path, line, level, code, message):
        self.path, self.line, self.level = path, line, level
        self.code, self.message = code, message

    def render(self):
        loc = f"{self.path}:{self.line}" if self.line else self.path
        return f"{loc}: {self.level} {self.code}: {self.message}"

    def as_dict(self):
        return {"path": self.path, "line": self.line, "level": self.level,
                "code": self.code, "message": self.message}


class Doc:
    __slots__ = ("full", "rel", "type", "fields", "derived", "declared",
                 "refs", "findings", "noise")


def is_excluded(relpath, patterns):
    rel = relpath.replace("\\", "/")
    parts = rel.split("/")
    for pat in patterns:
        pat = pat.replace("\\", "/").rstrip("/")
        if pat.endswith("/**"):
            pat = pat[:-3]
        if rel == pat or rel.startswith(pat + "/"):
            return True
        if "/" not in pat and pat in parts:
            return True
    return False


def _realpath_within(root_real, path):
    try:
        path_real = os.path.normcase(os.path.realpath(path))
        return os.path.commonpath([root_real, path_real]) == root_real
    except ValueError:
        return False


def iter_markdown(root, paths, exclude):
    targets = paths or [root]
    root_real = os.path.normcase(os.path.realpath(root))
    seen = set()
    seen_dirs = set()
    for target in targets:
        target = os.path.abspath(target)
        if not _realpath_within(root_real, target):
            continue
        if os.path.isfile(target):
            rel = os.path.relpath(target, root)
            if target.endswith((".md", ".markdown")) and not is_excluded(rel, exclude) \
                    and target not in seen and _realpath_within(root_real, target):
                seen.add(target)
                yield target, rel
            continue
        for dirpath, dirnames, filenames in os.walk(target):
            dir_real = os.path.normcase(os.path.realpath(dirpath))
            if not _realpath_within(root_real, dirpath) or dir_real in seen_dirs:
                dirnames[:] = []
                continue
            seen_dirs.add(dir_real)
            reldir = os.path.relpath(dirpath, root)
            reldir = "" if reldir == "." else reldir
            kept_dirs = []
            for d in sorted(dirnames):
                child = os.path.join(dirpath, d)
                child_real = os.path.normcase(os.path.realpath(child))
                if is_excluded(os.path.join(reldir, d), exclude):
                    continue
                if not _realpath_within(root_real, child):
                    continue
                if child_real in seen_dirs:
                    continue
                kept_dirs.append(d)
            dirnames[:] = kept_dirs
            for f in sorted(filenames):
                if not f.endswith((".md", ".markdown")):
                    continue
                rel = os.path.join(reldir, f) if reldir else f
                if is_excluded(rel, exclude):
                    continue
                full = os.path.join(dirpath, f)
                if full not in seen and _realpath_within(root_real, full):
                    seen.add(full)
                    yield full, rel


def analyze_file(full, rel, config, *, text=None, use_git_dates=True):
    doc = Doc()
    doc.full, doc.rel = full, rel
    doc.findings, doc.refs, doc.declared, doc.noise = [], [], {}, []
    rel = rel.replace("\\", "/")

    if text is None:
        try:
            with open(full, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError as e:
            doc.findings.append(Finding(rel, 0, "error", "E000", f"cannot read file: {e}"))
            doc.type, doc.fields, doc.derived = None, {}, {}
            return doc

    yaml_text, body = extract_frontmatter(text)
    doc.derived = derive(full, body, use_git_dates=use_git_dates)

    fields, key_lines = {}, {}
    if yaml_text is not None:
        try:
            data = parse_yaml(yaml_text)
        except YamlError as e:
            doc.findings.append(Finding(rel, e.lineno + 1, "error", "E001",
                                        f"frontmatter is not valid YAML: {e}"))
            doc.type, doc.fields = type_for(full, config), {}
            return doc
        if not isinstance(data, dict):
            doc.findings.append(Finding(rel, 2, "error", "E001",
                                        "frontmatter must be a mapping of key: value"))
            doc.type, doc.fields = type_for(full, config), {}
            return doc
        key_lines = data.get("__lines__", {})
        fields = strip_meta(data)
    doc.fields = fields

    def line_of(k):
        return key_lines.get(k, 1) + 1

    doc.type = type_for(full, config)
    if doc.type is None and not config.allow_untyped:
        doc.findings.append(Finding(
            rel, 1, "error", "W201",
            "untyped document (no ancestor folder is a registered type)"))

    required, known = config.fields_for(doc.type)

    for key, spec in required.items():
        if key not in fields:
            doc.findings.append(Finding(rel, 1, "error", "E101",
                                        f"missing required field {key!r} for type {doc.type!r}"))
        elif fields[key] is None or fields[key] == "":
            doc.findings.append(Finding(rel, line_of(key), "error", "E102",
                                        f"required field {key!r} is empty"))

    for key, value in fields.items():
        if key in config.derive:
            if value == doc.derived.get(key):
                doc.noise.append(key)
                doc.findings.append(Finding(rel, line_of(key), "warning", "W210",
                                            f"field {key!r} equals its derived value (noise)"))
            continue
        spec = known.get(key)
        if spec is None:
            if doc.type is not None:
                doc.findings.append(Finding(
                    rel, line_of(key), "warning", "W202",
                    f"unknown field {key!r} for type {doc.type!r}"))
            continue
        if spec in ("ref", "ref-list") and value is not None:
            targets = value if isinstance(value, list) else [value]
            for t in targets:
                doc.refs.append((key, t, line_of(key)))
        err = check_field_type(value, spec)
        if err:
            doc.findings.append(Finding(rel, line_of(key), "error", "E103",
                                        f"field {key!r}: {err}"))
        else:
            doc.declared[key] = value
    return doc


def analyze(root, paths, config):
    resolver = config if hasattr(config, "for_dir") else _StaticResolver(config)
    docs = []
    for full, rel in iter_markdown(root, paths, resolver.base.exclude):
        effective = resolver.for_dir(os.path.dirname(full))
        if is_excluded(rel, effective.exclude):
            continue
        docs.append(analyze_file(full, rel, effective))
    ids = set()
    for d in docs:
        ids.add(d.derived.get("id"))
    for d in docs:
        for key, target, line in d.refs:
            if isinstance(target, str) and target not in ids:
                d.findings.append(Finding(d.rel.replace("\\", "/"), line, "warning", "W220",
                                          f"field {key!r}: ref {target!r} matches no document id"))
    return docs


# ---------------------------------------------------------------------------
# Graph: the typed edges (ref/ref-list) as a navigable graph
# ---------------------------------------------------------------------------

def build_graph(docs):
    """Build the typed graph from analyzed docs.

    Nodes are documents keyed by their derived `id`; edges are the `ref`/`ref-list`
    fields already collected in `Doc.refs`. An edge whose target matches no node
    id is `broken` (the same condition `check` reports as W220). Returns
    `(nodes, edges)`:
      nodes: dict id -> {"id", "type", "path"}
      edges: list of {"from", "field", "to", "broken"}, sorted for stable output
    """
    nodes = {}
    for d in docs:
        nid = d.derived.get("id")
        if nid is None:  # unreadable file (E000) — no node
            continue
        nodes.setdefault(nid, {"id": nid, "type": d.type,
                               "path": d.rel.replace("\\", "/")})
    edges = []
    for d in docs:
        src = d.derived.get("id")
        if src is None:
            continue
        for field, target, _line in d.refs:
            if not isinstance(target, str):
                continue
            edges.append({"from": src, "field": field, "to": target,
                          "broken": target not in nodes})
    edges.sort(key=lambda e: (e["from"], e["field"], e["to"]))
    return nodes, edges


def blast_radius(edges, target, max_depth=None):
    """Inbound-edge transitive closure: every node that (transitively) refs
    `target` — what a change to `target` could touch. Reverse BFS over the edge
    list. Returns dict id -> {"distance", "via"} (nearest distance wins),
    excluding `target` itself even if a cycle leads back to it."""
    rev = {}
    for e in edges:
        rev.setdefault(e["to"], []).append((e["from"], e["field"]))
    impacted = {}
    queue = deque((src, 1, field) for src, field in rev.get(target, []))
    while queue:
        nid, dist, via = queue.popleft()
        if nid == target:
            continue
        if max_depth is not None and dist > max_depth:
            continue
        prev = impacted.get(nid)
        if prev is not None and prev["distance"] <= dist:
            continue
        impacted[nid] = {"distance": dist, "via": via}
        for src, field in rev.get(nid, []):
            queue.append((src, dist + 1, field))
    return impacted


def apply_change(nodes, edges, spec):
    """Apply a change-spec to a graph, in memory, returning a NEW (nodes, edges)
    — the disk is never touched. Spec keys (all optional):
      remove = ["id", ...]                  delete nodes (and their outbound edges)
      retype = { id = "newtype", ... }      change a node's type
      break  = [{from, to, field?}, ...]    delete matching edges
      add    = [{from, field, to}, ...]     add edges
    `broken` is recomputed against the proposed node set."""
    nodes = {k: dict(v) for k, v in nodes.items()}
    edges = [dict(e) for e in edges]
    removed = set(spec.get("remove") or [])
    for nid in removed:
        nodes.pop(nid, None)
    edges = [e for e in edges if e["from"] not in removed]  # gone docs make no refs
    for nid, t in (spec.get("retype") or {}).items():
        if nid in nodes:
            nodes[nid]["type"] = t
    for b in spec.get("break") or []:
        frm, to, fld = b.get("from"), b.get("to"), b.get("field")
        edges = [e for e in edges if not (e["from"] == frm and e["to"] == to
                                          and (fld is None or e["field"] == fld))]
    for a in spec.get("add") or []:
        edges.append({"from": a["from"], "field": a.get("field", "ref"),
                      "to": a["to"], "broken": False})
    ids = set(nodes)
    for e in edges:
        e["broken"] = e["to"] not in ids
    edges.sort(key=lambda e: (e["from"], e["field"], e["to"]))
    return nodes, edges


def graph_diff(old_nodes, old_edges, new_nodes, new_edges):
    """Semantic delta between two graphs: nodes added/removed/retyped and edges
    added/removed/newly-broken — the structural change a text diff can't show.
    `edges_newly_broken` is the actionable set: edges that *survived* the change
    but now point at nothing (e.g. their target was removed)."""
    def key(e):
        return (e["from"], e["field"], e["to"])
    old_e = {key(e): e for e in old_edges}
    new_e = {key(e): e for e in new_edges}
    retyped = [{"id": n, "from": old_nodes[n]["type"], "to": new_nodes[n]["type"]}
               for n in new_nodes
               if n in old_nodes and old_nodes[n]["type"] != new_nodes[n]["type"]]
    return {
        "nodes_added": sorted(set(new_nodes) - set(old_nodes)),
        "nodes_removed": sorted(set(old_nodes) - set(new_nodes)),
        "nodes_retyped": sorted(retyped, key=lambda r: r["id"]),
        "edges_added": [new_e[k] for k in new_e if k not in old_e],
        "edges_removed": [old_e[k] for k in old_e if k not in new_e],
        "edges_newly_broken": [new_e[k] for k in new_e
                               if k in old_e and new_e[k]["broken"] and not old_e[k]["broken"]],
    }


# ---------------------------------------------------------------------------
# View: a self-contained HTML render of the graph (zero external assets)
# ---------------------------------------------------------------------------

_PALETTE = ["#4f7cff", "#23b26d", "#e0823d", "#b455d6", "#d6455a", "#2bb8c4", "#9a8c2b"]
_CANVAS_W, _CANVAS_H, _NODE_R = 960, 640, 22


def _color_for(type_name):
    if not type_name:
        return "#8a8f99"
    return _PALETTE[sum(map(ord, type_name)) % len(_PALETTE)]


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _layout(node_ids, ranks, cx, cy, span):
    """Position nodes. `ranks` maps id -> ring index (0 = centre); when every
    node shares rank 0 (the whole-graph view) they fall on one circle."""
    pos, by_rank = {}, {}
    for nid in node_ids:
        by_rank.setdefault(ranks.get(nid, 0), []).append(nid)
    max_rank = max(by_rank, default=0)
    for rank, ids in by_rank.items():
        ids = sorted(ids)
        n = len(ids)
        if rank == 0 and n == 1:
            pos[ids[0]] = (cx, cy)
            continue
        r = span if max_rank == 0 else span * rank / max_rank
        r = r or span  # single ring (whole graph) sits on the outer circle
        for i, nid in enumerate(ids):
            ang = (2 * math.pi * i / n if n > 1 else 0) - math.pi / 2
            pos[nid] = (cx + r * math.cos(ang), cy + r * math.sin(ang))
    return pos


def render_graph_html(title, nodes, edges, ranks=None):
    """A complete, self-contained HTML document drawing `nodes`/`edges` as an
    SVG (inline data, no CDN/library). `ranks` (id -> ring) drives the blast
    concentric layout; absent, the whole graph is laid out on one circle."""
    ranks = ranks or {}
    cx, cy = _CANVAS_W / 2, _CANVAS_H / 2
    span = min(cx, cy) - 90
    pos = _layout(list(nodes), ranks, cx, cy, span)

    edge_svg = []
    for e in edges:
        if e["from"] not in pos or e["to"] not in pos:
            continue
        x1, y1 = pos[e["from"]]
        x2, y2 = pos[e["to"]]
        dx, dy = x2 - x1, y2 - y1
        d = math.hypot(dx, dy) or 1
        ux, uy = dx / d, dy / d
        cls = "edge broken" if e["broken"] else "edge"
        edge_svg.append(
            f'<line class="{cls}" data-from="{_esc(e["from"])}" data-to="{_esc(e["to"])}" '
            f'x1="{x1 + ux * _NODE_R:.1f}" y1="{y1 + uy * _NODE_R:.1f}" '
            f'x2="{x2 - ux * _NODE_R:.1f}" y2="{y2 - uy * _NODE_R:.1f}" '
            f'marker-end="url(#arrow)"><title>{_esc(e["from"])} --{_esc(e["field"])}--> '
            f'{_esc(e["to"])}{" (broken)" if e["broken"] else ""}</title></line>')

    node_svg = []
    for nid, n in sorted(nodes.items()):
        x, y = pos[nid]
        color = _color_for(n["type"])
        node_svg.append(
            f'<g class="node" data-id="{_esc(nid)}" transform="translate({x:.1f},{y:.1f})">'
            f'<circle r="{_NODE_R}" fill="{color}"></circle>'
            f'<text class="lbl" y="{_NODE_R + 14}">{_esc(nid)}</text>'
            f'<title>{_esc(nid)} [{_esc(n["type"] or "untyped")}]\n{_esc(n["path"])}</title></g>')

    types = sorted({n["type"] for n in nodes.values()}, key=lambda t: (t is None, t))
    legend = "".join(
        f'<span class="key"><i style="background:{_color_for(t)}"></i>{_esc(t or "untyped")}</span>'
        for t in types)
    broken = sum(1 for e in edges if e["broken"])
    sub = (f"{len(nodes)} node(s) · {len(edges)} edge(s)"
           + (f" · {broken} broken" if broken else ""))

    return _HTML_SHELL.format(
        title=_esc(title), sub=_esc(sub), legend=legend,
        w=_CANVAS_W, h=_CANVAS_H,
        edges="\n".join(edge_svg), nodes="\n".join(node_svg))


_HTML_SHELL = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>tropo · {title}</title>
<style>
  :root {{ color-scheme: dark light; }}
  body {{ margin: 0; font: 14px/1.4 ui-sans-serif, system-ui, sans-serif;
          background: #14161c; color: #e6e8ee; }}
  header {{ padding: 14px 20px; border-bottom: 1px solid #2a2e38; }}
  header h1 {{ margin: 0; font-size: 16px; }}
  header .sub {{ color: #9aa0ad; font-size: 12px; }}
  .legend {{ padding: 8px 20px; display: flex; gap: 16px; flex-wrap: wrap; }}
  .key {{ display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #c4c9d4; }}
  .key i {{ width: 12px; height: 12px; border-radius: 3px; display: inline-block; }}
  svg {{ display: block; width: 100%; height: auto; }}
  .edge {{ stroke: #5b6270; stroke-width: 1.5; }}
  .edge.broken {{ stroke: #d6455a; stroke-dasharray: 5 4; }}
  .node circle {{ stroke: #14161c; stroke-width: 2; cursor: pointer; }}
  .lbl {{ text-anchor: middle; fill: #c4c9d4; font-size: 11px; pointer-events: none; }}
  svg.dim .node, svg.dim .edge {{ opacity: .12; }}
  svg.dim .node.hi, svg.dim .edge.hi {{ opacity: 1; }}
  #arrow {{ fill: #5b6270; }}
</style></head>
<body>
<header><h1>tropo · {title}</h1><div class="sub">{sub}</div></header>
<div class="legend">{legend}</div>
<svg viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="3"
    orient="auto" markerUnits="strokeWidth">
    <path d="M0,0 L7,3 L0,6 z" fill="#5b6270"></path></marker></defs>
  <g class="edges">{edges}</g>
  <g class="nodes">{nodes}</g>
</svg>
<script>
  const svg = document.querySelector('svg');
  const sel = id => svg.querySelector('.node[data-id="' + (window.CSS ? CSS.escape(id) : id) + '"]');
  svg.querySelectorAll('.node').forEach(node => {{
    node.addEventListener('mouseenter', () => {{
      const id = node.dataset.id;
      svg.classList.add('dim'); node.classList.add('hi');
      svg.querySelectorAll('.edge').forEach(e => {{
        if (e.dataset.from === id || e.dataset.to === id) {{
          e.classList.add('hi');
          sel(e.dataset.from) && sel(e.dataset.from).classList.add('hi');
          sel(e.dataset.to) && sel(e.dataset.to).classList.add('hi');
        }}
      }});
    }});
    node.addEventListener('mouseleave', () => {{
      svg.classList.remove('dim');
      svg.querySelectorAll('.hi').forEach(x => x.classList.remove('hi'));
    }});
  }});
</script>
</body></html>
"""


# ---------------------------------------------------------------------------
# Storage layer
# ---------------------------------------------------------------------------

STORAGE_DIR = ".vivary"
STORAGE_CONFIG_NAME = "storage.toml"
MEMORY_CONFIG_NAME = "memory.toml"
_CONTENT_PREVIEW_CHARS = 1000
_DEFAULT_SNIPPET_CHARS = 160
_DEFAULT_FIND_BUDGET = 1200
_MAX_GOVERNED_QUERY_TERMS = 16
_DEFAULT_VECTOR_DIMENSIONS = 128
_MIN_VECTOR_DIMENSIONS = 16
_MAX_VECTOR_DIMENSIONS = 4096
_VECTOR_CONTENT_CHARS = 4000
_LOCAL_VECTOR_PROVIDER = "local-hash"
_LOCAL_VECTOR_VERSION = "local-hash-v2"
_VECTOR_QUERY_MAX_VALIDATE_ROWS = 10_000
_VECTOR_QUERY_MAX_CANDIDATES = 250
_PUBLIC_MAX_SCAN_ENTRIES = 50_000
_PUBLIC_MAX_MARKDOWN_FILES = 5_000
_PUBLIC_MAX_FILE_BYTES = 1 * 1024 * 1024
_PUBLIC_MAX_AGGREGATE_BYTES = 32 * 1024 * 1024
_PUBLIC_MAX_FINDINGS = 200
_PUBLIC_MAX_SNIPPET_CHARS = 1_000
_VECTOR_QUERY_FILTER_OVERFETCH = 5
_VECTOR_METADATA_COLUMNS = [
    "id",
    "embedding_provider",
    "embedding_dimensions",
    "embedding_version",
    "embedding_scope",
    "embedding_text_fingerprint",
    "source_fingerprint",
]
_QUERY_STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for",
    "from", "how", "i", "in", "is", "it", "of", "on", "or", "our", "the",
    "this", "to", "we", "what", "where", "which", "who", "why",
}


def _load_storage_document(root):
    path = os.path.join(root, STORAGE_DIR, STORAGE_CONFIG_NAME)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8-sig") as fh:
            return tomllib.loads(fh.read())
    except OSError as e:
        detail = e.strerror or e.__class__.__name__
        raise ConfigError(f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME}: {detail}")
    except (tomllib.TOMLDecodeError, UnicodeDecodeError) as e:
        raise ConfigError(f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME}: {e}")


def _load_storage_config(root):
    data = _load_storage_document(root)
    storage = data.get("storage", {"backend": "file"})
    if storage is None:
        storage = {"backend": "file"}
    if not isinstance(storage, dict):
        raise ConfigError(f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME}: storage must be a TOML table")
    return storage


def _storage_path_has_link_or_junction_ancestor(root, path):
    root_abs = os.path.abspath(root)
    current = os.path.abspath(path if os.path.lexists(path) else os.path.dirname(path))
    while True:
        if os.path.lexists(current) and (
            os.path.islink(current)
            or (
                hasattr(os.path, "isjunction")
                and os.path.isjunction(current)
            )
        ):
            return True
        if os.path.normcase(os.path.abspath(current)) == os.path.normcase(root_abs):
            return False
        parent = os.path.dirname(current)
        if parent == current:
            return False
        current = parent


def _resolve_embedded_storage_config(root, storage):
    embedded = storage.get("embedded", {})
    if embedded is None:
        embedded = {}
    if not isinstance(embedded, dict):
        raise ConfigError(
            f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME}: storage.embedded must be a TOML table"
        )

    provider = embedded.get("provider", "lancedb")
    if not isinstance(provider, str):
        raise ConfigError(
            f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME}: storage.embedded.provider must be a string"
        )

    raw_path = embedded.get("path", os.path.join(STORAGE_DIR, "data"))
    if not isinstance(raw_path, str) or not raw_path:
        raise ConfigError(
            f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME}: storage.embedded.path must be a non-empty string"
        )

    root_abs = os.path.abspath(root)
    path = raw_path if os.path.isabs(raw_path) else os.path.join(root_abs, raw_path)
    path = os.path.abspath(path)
    root_real = os.path.normcase(os.path.realpath(root_abs))
    if not _realpath_within(root_real, path):
        raise ConfigError(
            f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME}: storage.embedded.path must stay inside the workspace"
        )
    if _storage_path_has_link_or_junction_ancestor(root_abs, path):
        raise ConfigError(
            f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME}: storage.embedded.path must not use symlink or junction directories"
        )

    return {"provider": provider.strip().lower(), "path": path}


def _vector_config_error(detail, provider="unknown"):
    return {
        "enabled": False,
        "provider": provider,
        "status": "misconfigured",
        "detail": detail,
    }


def _vector_config_fallback(detail):
    return {
        "enabled": False,
        "provider": "none",
        "status": "fallback",
        "fallback": "text",
        "detail": detail,
    }


def _load_vector_query_config(root):
    try:
        data = _load_storage_document(root)
    except ConfigError as e:
        return _vector_config_error(str(e))
    storage = data.get("storage", {})
    if storage is None:
        storage = {}
    if not isinstance(storage, dict):
        return _vector_config_error(f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME}: storage must be a TOML table")

    embedding = storage.get("embedding")
    if embedding is None:
        return _vector_config_fallback(
            f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME} does not enable local vector search"
        )
    if not isinstance(embedding, dict):
        return _vector_config_error(
            f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME}: embedding must be a TOML table"
        )

    enabled = embedding.get("enabled", False)
    if not isinstance(enabled, bool):
        return _vector_config_error(
            f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME}: embedding.enabled must be true or false"
        )
    provider = embedding.get("provider", _LOCAL_VECTOR_PROVIDER)
    if not isinstance(provider, str):
        return _vector_config_error(
            f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME}: embedding.provider must be a string"
        )
    provider = provider.strip().lower()
    if not enabled:
        return _vector_config_fallback(
            f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME} embedding is disabled"
        )
    if provider != _LOCAL_VECTOR_PROVIDER:
        return _vector_config_error(
            f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME}: embedding.provider {provider!r} is not supported by tropo",
            provider=provider,
        )

    dimensions = embedding.get("dimensions", _DEFAULT_VECTOR_DIMENSIONS)
    if isinstance(dimensions, bool) or not isinstance(dimensions, int):
        return _vector_config_error(
            f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME}: embedding.dimensions must be an integer",
            provider=provider,
        )
    if dimensions < _MIN_VECTOR_DIMENSIONS or dimensions > _MAX_VECTOR_DIMENSIONS:
        return _vector_config_error(
            f"{STORAGE_DIR}/{STORAGE_CONFIG_NAME}: embedding.dimensions must be between {_MIN_VECTOR_DIMENSIONS} and {_MAX_VECTOR_DIMENSIONS}",
            provider=provider,
        )

    return {
        "enabled": True,
        "provider": provider,
        "status": "ok",
        "detail": "",
        "dimensions": dimensions,
    }


def _load_memory_query_config(root):
    path = os.path.join(root, STORAGE_DIR, MEMORY_CONFIG_NAME)
    if not os.path.isfile(path):
        return {
            "enabled": False,
            "provider": "none",
            "status": "disabled",
            "detail": f"{STORAGE_DIR}/{MEMORY_CONFIG_NAME} does not enable semantic memory",
        }
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            data = tomllib.loads(handle.read())
    except OSError as e:
        return {
            "enabled": False,
            "provider": "none",
            "status": "misconfigured",
            "detail": (
                f"cannot read {STORAGE_DIR}/{MEMORY_CONFIG_NAME}: "
                f"{e.strerror or e.__class__.__name__}"
            ),
        }
    except (tomllib.TOMLDecodeError, UnicodeDecodeError) as e:
        return {
            "enabled": False,
            "provider": "none",
            "status": "misconfigured",
            "detail": f"invalid {STORAGE_DIR}/{MEMORY_CONFIG_NAME}: {e}",
        }
    memory = data.get("memory", {})
    if not isinstance(memory, dict):
        return {
            "enabled": False,
            "provider": "unknown",
            "status": "misconfigured",
            "detail": f"{STORAGE_DIR}/{MEMORY_CONFIG_NAME}: memory must be a TOML table",
        }
    enabled = memory.get("enabled", False)
    provider = memory.get("provider", "none")
    if not isinstance(enabled, bool):
        return {
            "enabled": False,
            "provider": "unknown",
            "status": "misconfigured",
            "detail": f"{STORAGE_DIR}/{MEMORY_CONFIG_NAME}: memory.enabled must be true or false",
        }
    if not isinstance(provider, str):
        return {
            "enabled": False,
            "provider": "unknown",
            "status": "misconfigured",
            "detail": f"{STORAGE_DIR}/{MEMORY_CONFIG_NAME}: memory.provider must be a string",
        }
    if not enabled or provider == "none":
        return {
            "enabled": enabled,
            "provider": provider,
            "status": "disabled",
            "detail": f"{STORAGE_DIR}/{MEMORY_CONFIG_NAME} does not enable semantic memory",
        }
    cognee = memory.get("cognee", {})
    allow_network = (
        cognee.get("allow_network", False) if isinstance(cognee, dict) else None
    )
    if not isinstance(allow_network, bool):
        allow_network = None
    return {
        "enabled": True,
        "provider": provider,
        "status": "configured",
        "detail": "",
        "_allow_network": allow_network,
    }


def _file_body(full_path, limit=_CONTENT_PREVIEW_CHARS):
    try:
        with open(full_path, encoding="utf-8", errors="replace") as fh:
            if limit is None:
                text = fh.read()
            else:
                read_limit = max(0, limit) + 8192
                text = fh.read(read_limit)
    except OSError:
        return ""
    m, text = _frontmatter_match(text)
    if m:
        body = text[m.end():]
    elif limit is not None and text.startswith("---\n") and len(text) >= read_limit:
        body = ""
    else:
        body = text
    return body if limit is None else body[:limit]


def _local_hash_features(text):
    tokens = re.findall(r"[a-z0-9]+", (text or "").lower())
    tokens = [token for token in tokens if token not in _QUERY_STOPWORDS]
    for token in tokens:
        yield f"tok:{token}", 1.0
        if len(token) >= 5:
            yield f"prefix5:{token[:5]}", 0.75
        if len(token) >= 4:
            for index in range(0, len(token) - 3):
                yield f"gram:{token[index:index + 4]}", 0.25


def _local_hash_vector(text, dimensions=_DEFAULT_VECTOR_DIMENSIONS):
    vector = [0.0] * dimensions
    features = list(_local_hash_features(text))
    if not features:
        return vector
    for feature, weight in features:
        digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
        index = int.from_bytes(digest, "big") % dimensions
        vector[index] += weight
    norm = math.sqrt(sum(value * value for value in vector))
    if norm <= 0:
        return vector
    return [round(value / norm, 6) for value in vector]


def _cosine_score(left, right):
    return sum(a * b for a, b in zip(left, right))


def _coerce_vector(value):
    if hasattr(value, "tolist"):
        value = value.tolist()
    if not isinstance(value, (list, tuple)):
        return None
    vector = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            return None
        number = float(item)
        if not math.isfinite(number):
            return None
        vector.append(number)
    return vector


def _record_vector_text(record):
    edge_text = " ".join(f"{edge['field']} {edge['to']}" for edge in record["edges"])
    return " ".join(
        str(value or "")
        for value in (
            record.get("id"),
            record.get("type"),
            record.get("path"),
            record.get("title"),
            record.get("frontmatter_text"),
            edge_text,
            record.get("body"),
        )
    )


def _typed_result_edges(record):
    return [
        {"from": record["id"], "field": edge["field"], "to": edge["to"]}
        for edge in record.get("edges", [])
    ]


def _doc_to_node(d):
    return {
        "id":      d.derived.get("id", ""),
        "type":    d.type or "",
        "path":    d.rel.replace("\\", "/"),
        "title":   d.derived.get("title", ""),
        "content": _file_body(d.full),
    }


def _sha256_bytes(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _sha256_text(text):
    return _sha256_bytes((text or "").encode("utf-8"))


def _source_fingerprint(doc, fallback_record):
    if doc is not None:
        try:
            digest = hashlib.sha256()
            with open(doc.full, "rb") as fh:
                for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                    digest.update(chunk)
            return "sha256:" + digest.hexdigest()
        except OSError:
            pass
    stable = json.dumps(fallback_record, ensure_ascii=False, sort_keys=True)
    return _sha256_text(stable)


def _embedding_summary(config, embedded=0):
    if config["status"] == "ok":
        return {
            "status": "ok",
            "provider": config["provider"],
            "dimensions": config.get("dimensions", _DEFAULT_VECTOR_DIMENSIONS),
            "embedded": embedded,
        }
    if config["status"] == "fallback":
        return {
            "status": "disabled",
            "embedded": 0,
            "detail": config["detail"],
        }
    return {
        "status": config["status"],
        "provider": config.get("provider", "unknown"),
        "embedded": 0,
        "detail": config.get("detail", ""),
    }


def _migrate_nodes_with_embeddings(docs, config):
    graph_nodes, graph_edges = build_graph(docs)
    plain_by_id = {
        d.derived.get("id", ""): _doc_to_node(d)
        for d in docs
        if d.derived.get("id", "") is not None
    }
    if config["status"] != "ok":
        return [plain_by_id[node_id] for node_id in sorted(plain_by_id)]

    docs_by_id = {d.derived.get("id"): d for d in docs if d.derived.get("id") is not None}
    dimensions = config.get("dimensions", _DEFAULT_VECTOR_DIMENSIONS)
    records = _build_search_records(docs, graph_nodes, graph_edges, body_limit=_VECTOR_CONTENT_CHARS)
    nodes = []
    for record in records:
        node = dict(plain_by_id.get(record["id"], {
            "id": record["id"],
            "type": record.get("type") or "",
            "path": record.get("path", ""),
            "title": record.get("title", ""),
            "content": record.get("body", ""),
        }))
        text = _record_vector_text(record)
        node.update({
            "vector": _local_hash_vector(text, dimensions),
            "embedding_provider": config["provider"],
            "embedding_dimensions": dimensions,
            "embedding_version": _LOCAL_VECTOR_VERSION,
            "embedding_scope": "typed-node",
            "embedding_text_fingerprint": _sha256_text(text),
            "source_fingerprint": _source_fingerprint(docs_by_id.get(record["id"]), record),
        })
        nodes.append(node)
    return nodes


class _FileBackend:
    """Default: file-system graph is the store. query() is a text grep over .md files."""
    def __init__(self, root):
        self._root = root

    def upsert(self, nodes):
        pass  # FS is the source of truth

    def get(self, node_id):
        return None

    def delete(self, node_id):
        pass

    def query(self, text, k=10, filters=None):
        results = []
        text_lower = text.lower()
        for dirpath, dirs, filenames in os.walk(self._root):
            dirs[:] = [d for d in dirs if d not in (".git", ".vivary", "__pycache__")]
            for fname in filenames:
                if not fname.endswith((".md", ".markdown")):
                    continue
                full = os.path.join(dirpath, fname)
                body = _file_body(full)
                body_lower = body.lower()
                if text_lower not in body_lower:
                    continue
                rel = os.path.relpath(full, self._root).replace("\\", "/")
                score = body_lower.count(text_lower)
                results.append({
                    "id":    os.path.splitext(fname)[0].lower(),
                    "type":  None,
                    "path":  rel,
                    "title": os.path.splitext(fname)[0],
                    "score": score,
                })
        results.sort(key=lambda r: -r["score"])
        return results[:k]

    def close(self):
        pass


class _LanceBackend:
    """Embedded backend (LanceDB on disk, no server). Requires vivary-tropo[embedded]."""
    def __init__(self, path):
        try:
            import lancedb as _ldb  # noqa: PLC0415
            self._ldb = _ldb
        except ImportError:
            raise ConfigError(
                "LanceDB is not installed. Run: pip install vivary-tropo[embedded]"
            )
        os.makedirs(path, exist_ok=True)
        self._db = self._ldb.connect(path)
        self._tbl = None

    def _table(self):
        if self._tbl is not None:
            return self._tbl
        try:
            self._tbl = self._db.open_table("nodes")
        except Exception:
            pass
        return self._tbl

    def upsert(self, nodes):
        if not nodes:
            return
        tbl = self._table()
        if tbl is None:
            self._tbl = self._db.create_table("nodes", data=nodes)
            return
        try:
            (tbl.merge_insert("id")
                .when_matched_update_all()
                .when_not_matched_insert_all()
                .execute(nodes))
        except AttributeError:
            tbl.add(nodes, mode="overwrite")
        except ValueError as e:
            if "not found in target schema" not in str(e):
                raise
            tbl.add(nodes, mode="overwrite")

    def replace_all(self, nodes):
        if self._table() is not None:
            self._db.drop_table("nodes")
            self._tbl = None
        if nodes:
            self._tbl = self._db.create_table("nodes", data=nodes)

    def get(self, node_id):
        tbl = self._table()
        if tbl is None:
            return None
        rows = tbl.search().where(f"id = '{node_id}'").limit(1).to_list()
        return rows[0] if rows else None

    def all_nodes(self):
        tbl = self._table()
        if tbl is None:
            return []
        return tbl.to_arrow().to_pylist()

    def count_nodes(self):
        tbl = self._table()
        if tbl is None:
            return 0
        return tbl.count_rows()

    def node_metadata(self, limit=None):
        tbl = self._table()
        if tbl is None:
            return []
        query = tbl.search().select(_VECTOR_METADATA_COLUMNS)
        if limit is not None:
            query = query.limit(limit)
        return query.to_list()

    def vector_query(self, query_vector, k=10):
        tbl = self._table()
        if tbl is None:
            return []
        limit = max(0, k)
        if limit == 0:
            return []
        return tbl.search(query_vector).select(["id", "vector", "_distance"]).limit(limit).to_list()

    def delete(self, node_id):
        tbl = self._table()
        if tbl:
            tbl.delete(f"id = '{node_id}'")

    def query(self, text, k=10, filters=None):
        tbl = self._table()
        if tbl is None:
            return []
        text_lower = text.lower()
        try:
            rows = tbl.search(text, query_type="fts").limit(k).to_list()
        except Exception:
            rows = [
                r for r in tbl.to_arrow().to_pylist()
                if text_lower in (r.get("content") or "").lower()
                or text_lower in (r.get("title") or "").lower()
            ][:k]
        return [
            {
                "id":    r.get("id", ""),
                "type":  r.get("type") or None,
                "path":  r.get("path", ""),
                "title": r.get("title", ""),
                "score": r.get("_relevance_score", 1.0),
            }
            for r in rows
        ]

    def close(self):
        self._tbl = None
        self._db = None


def get_backend(root, *, allow_auto_fallback=True):
    """Return the configured StorageBackend for the workspace at root."""
    cfg = _load_storage_config(root)
    backend = cfg.get("backend", "file")

    if backend == "file":
        return _FileBackend(root)

    if backend in ("embedded", "auto"):
        emb = _resolve_embedded_storage_config(root, cfg)
        path = emb["path"]
        provider = emb["provider"]
        if provider == "lancedb":
            try:
                return _LanceBackend(path)
            except ConfigError:
                if backend == "auto" and allow_auto_fallback:
                    print("tropo: lancedb not installed, falling back to file backend",
                          file=sys.stderr)
                    return _FileBackend(root)
                raise
        raise ConfigError(f"unknown embedded provider: {provider!r}")

    if backend == "cloud":
        raise ConfigError(
            "cloud backend not yet implemented — configure a cloud adapter in 0.3.x"
        )

    raise ConfigError(f"unknown storage backend: {backend!r}")


# ---------------------------------------------------------------------------
# Graph search: shared by `query` and context-packet `find`
# ---------------------------------------------------------------------------
class TropoFacadeError(RuntimeError):
    """Base class for public read-only facade failures."""

    reason = "producer_unavailable"

    def __init__(self):
        super().__init__(self.reason)


class PathRefusedError(TropoFacadeError):
    reason = "path_refused"


class PrivacyPolicyUnavailableError(TropoFacadeError):
    reason = "privacy_policy_unavailable"


class WorkLimitExceededError(TropoFacadeError):
    reason = "work_limit_exceeded"


class ProducerUnavailableError(TropoFacadeError):
    reason = "producer_unavailable"

def _public_cancel_if_requested(cancelled):
    if cancelled is None:
        return
    try:
        if cancelled():
            raise ProducerUnavailableError()
    except ProducerUnavailableError:
        raise
    except Exception:
        raise ProducerUnavailableError() from None


class PublicOmission(TypedDict):
    kind: str
    reason: str
    count: int


class PublicQueryHit(TypedDict):
    id: str
    type: str | None
    path: str
    title: str
    score: int
    snippet: str | None
    reasons: list[str]
    edges: list[dict[str, str]]


class PublicFindHit(TypedDict):
    id: str
    type: str | None
    path: str
    reason: str
    snippet: str | None
    edges: list[dict[str, str]]


class QueryContextResult(TypedDict):
    schema: str
    query: str
    k: int
    filters: dict[str, list[str]]
    results: list[PublicQueryHit]
    complete: bool
    workspace_fingerprint: str | None
    omissions: list[PublicOmission]


class FindContextResult(TypedDict):
    schema: str
    query: str
    k: int
    budget: int
    estimated_tokens: int
    filters: dict[str, list[str]]
    results: list[PublicFindHit]
    complete: bool
    workspace_fingerprint: str | None
    omissions: list[PublicOmission]


class CheckWorkspaceResult(TypedDict):
    schema: str
    checked: int
    clean: int
    errors: int
    warnings: int
    findings: list[dict[str, Any]]
    strict: bool
    complete: bool
    workspace_fingerprint: str | None
    omissions: list[PublicOmission]


_PUBLIC_SENSITIVE_PATH_PARTS = {
    ".aws",
    ".env",
    ".gnupg",
    ".ssh",
    "credentials",
    "private",
    "secrets",
}
_PUBLIC_SENSITIVE_NAME_TOKENS = (
    "api-key",
    "apikey",
    "credential",
    "private-key",
    "secret",
    "token",
)

# Public producer facades deliberately do not reuse the CLI's open-ended
# filesystem/configuration paths.  They are an adapter boundary for optional
# transports, so they operate on one bounded, descriptor-verified snapshot.
_PUBLIC_QUERY_SCHEMA = "vivary.query-result/v0"
_PUBLIC_FIND_SCHEMA = "vivary.find-result/v0"
_PUBLIC_CHECK_SCHEMA = "vivary.check-result/v0"
_PUBLIC_MAX_FILESYSTEM_ENTRIES = 50_000
_PUBLIC_MAX_MARKDOWN_FILES = 5_000
_PUBLIC_MAX_FILE_BYTES = 1 * 1024 * 1024
_PUBLIC_MAX_AGGREGATE_BYTES = 32 * 1024 * 1024
_PUBLIC_MAX_FINDINGS = 200
_PUBLIC_MAX_RESULTS = 20
_PUBLIC_MAX_QUERY_CHARS = 4_096
_PUBLIC_MAX_FILTERS = 16
_PUBLIC_MAX_CHECK_PATHS = 200
_PUBLIC_MAX_PATH_CHARS = 512
_PUBLIC_MAX_TYPE_FILTER_CHARS = 128
_PUBLIC_MAX_EDGE_FILTER_CHARS = 256
_PUBLIC_MAX_SNIPPET_CHARS = 1_000
_PUBLIC_MAX_FIND_BUDGET = 4_000
_PUBLIC_MIN_FIND_BUDGET = 64
_PUBLIC_MAX_OMISSIONS = 16
_PUBLIC_MAX_EDGES_PER_DOCUMENT = 64
_PUBLIC_MAX_TITLE_CHARS = 512
_PUBLIC_MAX_FRONTMATTER_CHARS = 4_096
_PUBLIC_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
_PUBLIC_CREDENTIAL_ASSIGNMENT_RE = re.compile(
    r"""(?ix)
    \b(?:api[_-]?key|access[_-]?key|auth(?:orization)?|credential|password|
       passwd|private[_ -]?key|secret|token)\b
    \s*(?:=|:)\s*["']?([^\s"',;}\]]+)
    """
)
_PUBLIC_CREDENTIAL_URL_RE = re.compile(
    r"[A-Za-z][A-Za-z0-9+.-]*://[^\s/@:]+:[^\s/@]+@"
)
_PUBLIC_TOKEN_RE = re.compile(
    r"\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b"
)
_PUBLIC_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----"
)
_PUBLIC_ABSOLUTE_VALUE_RE = re.compile(r"^(?:/|[A-Za-z]:[\\/])")
_PUBLIC_MACHINE_PATH_RE = re.compile(
    r"""(?ix)
    (?:^|[^\w/])
    (?:
        [A-Z]:[\\/]
        | \\\\[^\s\\/]+[\\/][^\s\\/]+
        | /(?!/)[^\s/"'<>()\[\]{}]+(?:/[^\s"'<>()\[\]{}]+)*
    )
    """
)
_PUBLIC_SAFE_CONFIG_VALUES = frozenset(
    {
        "any", "boolean", "bool", "date", "datetime", "float", "integer",
        "number", "null", "ref", "ref-list", "slug", "string", "url",
    }
)
_PUBLIC_FINDING_MESSAGES = {
    "E001": "invalid frontmatter",
    "E101": "required field missing",
    "E102": "required field empty",
    "E103": "field value invalid",
    "W201": "untyped document",
    "W202": "unknown field",
    "W210": "redundant derived field",
    "W220": "unresolved reference",
}


def _public_closed_schema(properties, required):
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


def _public_string_array_schema(max_items, max_length):
    return {
        "type": "array",
        "items": {"type": "string", "minLength": 1, "maxLength": max_length},
        "maxItems": max_items,
        "uniqueItems": True,
    }


def _public_omission_schema():
    return _public_closed_schema(
        {
            "kind": {"type": "string", "minLength": 1, "maxLength": 64},
            "reason": {"type": "string", "minLength": 1, "maxLength": 64},
            "count": {"type": "integer", "minimum": 1},
        },
        ["kind", "reason", "count"],
    )


def _public_filters_schema():
    return _public_closed_schema(
        {
            "type": _public_string_array_schema(
                _PUBLIC_MAX_FILTERS, _PUBLIC_MAX_TYPE_FILTER_CHARS
            ),
            "path": _public_string_array_schema(
                _PUBLIC_MAX_FILTERS, _PUBLIC_MAX_PATH_CHARS
            ),
            "edge": _public_string_array_schema(
                _PUBLIC_MAX_FILTERS, _PUBLIC_MAX_EDGE_FILTER_CHARS
            ),
        },
        ["type", "path", "edge"],
    )


def _public_edge_schema():
    return _public_closed_schema(
        {
            "field": {"type": "string", "minLength": 1, "maxLength": 128},
            "to": {
                "type": "string",
                "minLength": 1,
                "maxLength": _PUBLIC_MAX_EDGE_FILTER_CHARS,
            },
        },
        ["field", "to"],
    )


def _public_hit_schema(kind):
    properties = {
        "id": {"type": "string", "minLength": 1, "maxLength": 512},
        "type": {
            "oneOf": [
                {"type": "string", "minLength": 1, "maxLength": 128},
                {"type": "null"},
            ]
        },
        "path": {"type": "string", "minLength": 1, "maxLength": _PUBLIC_MAX_PATH_CHARS},
        "snippet": {
            "oneOf": [
                {"type": "string", "minLength": 1, "maxLength": _PUBLIC_MAX_SNIPPET_CHARS + 6},
                {"type": "null"},
            ]
        },
        "edges": {
            "type": "array",
            "items": _public_edge_schema(),
            "maxItems": _PUBLIC_MAX_EDGES_PER_DOCUMENT,
        },
    }
    if kind == "query":
        properties.update(
            {
                "title": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": _PUBLIC_MAX_TITLE_CHARS,
                },
                "score": {"type": "integer", "minimum": 1},
                "reasons": {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1, "maxLength": 64},
                    "maxItems": 8,
                },
            }
        )
        required = [
            "id", "type", "path", "title", "score", "snippet", "reasons", "edges"
        ]
    else:
        properties["reason"] = {
            "type": "string",
            "minLength": 1,
            "maxLength": 128,
        }
        required = ["id", "type", "path", "reason", "snippet", "edges"]
    return _public_closed_schema(properties, required)


def _public_base_result_properties(schema):
    return {
        "schema": {"const": schema},
        "complete": {"type": "boolean"},
        "workspace_fingerprint": {
            "type": "string",
            "pattern": r"^sha256:[0-9a-f]{64}$",
        },
        "omissions": {
            "type": "array",
            "items": _public_omission_schema(),
            "maxItems": _PUBLIC_MAX_OMISSIONS,
        },
    }


def query_result_json_schema():
    properties = _public_base_result_properties(_PUBLIC_QUERY_SCHEMA)
    properties.update(
        {
            "query": {"type": "string", "minLength": 1, "maxLength": _PUBLIC_MAX_QUERY_CHARS},
            "k": {"type": "integer", "minimum": 1, "maximum": _PUBLIC_MAX_RESULTS},
            "filters": _public_filters_schema(),
            "results": {
                "type": "array",
                "items": _public_hit_schema("query"),
                "maxItems": _PUBLIC_MAX_RESULTS,
            },
        }
    )
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        **_public_closed_schema(
            properties,
            [
                "schema", "query", "k", "filters", "results", "complete",
                "workspace_fingerprint", "omissions",
            ],
        ),
    }


def find_result_json_schema():
    properties = _public_base_result_properties(_PUBLIC_FIND_SCHEMA)
    properties.update(
        {
            "query": {"type": "string", "minLength": 1, "maxLength": _PUBLIC_MAX_QUERY_CHARS},
            "k": {"type": "integer", "minimum": 1, "maximum": _PUBLIC_MAX_RESULTS},
            "budget": {
                "type": "integer",
                "minimum": _PUBLIC_MIN_FIND_BUDGET,
                "maximum": _PUBLIC_MAX_FIND_BUDGET,
            },
            "estimated_tokens": {
                "type": "integer",
                "minimum": 0,
                "maximum": _PUBLIC_MAX_FIND_BUDGET,
            },
            "filters": _public_filters_schema(),
            "results": {
                "type": "array",
                "items": _public_hit_schema("find"),
                "maxItems": _PUBLIC_MAX_RESULTS,
            },
        }
    )
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        **_public_closed_schema(
            properties,
            [
                "schema", "query", "k", "budget", "estimated_tokens", "filters",
                "results", "complete", "workspace_fingerprint", "omissions",
            ],
        ),
    }


def check_result_json_schema():
    finding = _public_closed_schema(
        {
            "path": {"type": "string", "minLength": 1, "maxLength": _PUBLIC_MAX_PATH_CHARS},
            "line": {"type": "integer", "minimum": 0},
            "level": {"enum": ["error", "warning"]},
            "code": {"type": "string", "minLength": 1, "maxLength": 16},
            "message": {"type": "string", "minLength": 1, "maxLength": 256},
        },
        ["path", "line", "level", "code", "message"],
    )
    properties = _public_base_result_properties(_PUBLIC_CHECK_SCHEMA)
    properties.update(
        {
            "checked": {"type": "integer", "minimum": 0, "maximum": _PUBLIC_MAX_MARKDOWN_FILES},
            "clean": {"type": "integer", "minimum": 0, "maximum": _PUBLIC_MAX_MARKDOWN_FILES},
            "errors": {"type": "integer", "minimum": 0},
            "warnings": {"type": "integer", "minimum": 0},
            "findings": {
                "type": "array",
                "items": finding,
                "maxItems": _PUBLIC_MAX_FINDINGS,
            },
            "strict": {"type": "boolean"},
        }
    )
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        **_public_closed_schema(
            properties,
            [
                "schema", "checked", "clean", "errors", "warnings", "findings",
                "strict", "complete", "workspace_fingerprint", "omissions",
            ],
        ),
    }


def _public_sort_key(value):
    """Use the same portable ordering basis as Core's public path policy."""
    return value.encode("utf-16-be", "surrogatepass")


def _public_add_omission(omissions, kind, reason, count=1):
    if count <= 0:
        return
    key = (kind, reason)
    omissions[key] = omissions.get(key, 0) + count


def _public_omission_rows(omissions):
    rows = [
        {"kind": kind, "reason": reason, "count": count}
        for (kind, reason), count in sorted(
            omissions.items(),
            key=lambda item: (_public_sort_key(item[0][0]), _public_sort_key(item[0][1])),
        )
        if count > 0
    ]
    if len(rows) <= _PUBLIC_MAX_OMISSIONS:
        return rows
    kept = rows[:_PUBLIC_MAX_OMISSIONS - 1]
    remaining = sum(row["count"] for row in rows[_PUBLIC_MAX_OMISSIONS - 1:])
    kept.append(
        {
            "kind": "snapshot",
            "reason": "omissions_truncated",
            "count": remaining,
        }
    )
    return kept


def _public_safe_text(value, maximum):
    if not isinstance(value, str) or not value or len(value) > maximum:
        return False
    if any(not character.isprintable() for character in value):
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _public_safe_relative_path(path, *, maximum=_PUBLIC_MAX_PATH_CHARS):
    if not _public_safe_text(path, maximum) or "\\" in path or path.startswith("/"):
        return False
    if re.match(r"^[A-Za-z]:", path):
        return False
    return all(part not in ("", ".", "..") for part in path.split("/"))


def _public_path_is_sensitive(relpath):
    parts = [part.casefold() for part in relpath.split("/")]
    for part in parts:
        if part in _PUBLIC_SENSITIVE_PATH_PARTS or part.startswith(".env"):
            return True
        if any(token in part for token in _PUBLIC_SENSITIVE_NAME_TOKENS):
            return True
    return False


def _public_link_or_reparse(info):
    return (
        stat.S_ISLNK(info.st_mode)
        or bool(getattr(info, "st_reparse_tag", 0))
        or bool(getattr(info, "st_file_attributes", 0) & _PUBLIC_REPARSE_POINT)
    )


def _public_is_regular_single_link(info):
    return stat.S_ISREG(info.st_mode) and getattr(info, "st_nlink", 1) == 1


def _public_security_text(text):
    normalized = unicodedata.normalize("NFKD", text)
    return "".join(
        character
        for character in normalized
        if not unicodedata.category(character).startswith(("C", "M"))
    )


def _public_text_has_credential(text):
    security_text = _public_security_text(text)
    if (
        _PUBLIC_CREDENTIAL_URL_RE.search(security_text)
        or _PUBLIC_TOKEN_RE.search(security_text)
        or _PUBLIC_PRIVATE_KEY_RE.search(security_text)
    ):
        return True
    for match in _PUBLIC_CREDENTIAL_ASSIGNMENT_RE.finditer(security_text):
        value = match.group(1).strip().casefold()
        if value not in _PUBLIC_SAFE_CONFIG_VALUES:
            return True
    return False


def _public_output_text_is_safe(value, maximum):
    return (
        _public_safe_text(value, maximum)
        and not _public_text_has_credential(value)
        and _PUBLIC_MACHINE_PATH_RE.search(_public_security_text(value)) is None
    )


def _public_contains_workspace_path(text, root):
    normalized_text = unicodedata.normalize("NFKC", text)
    normalized_root = unicodedata.normalize("NFKC", root).replace("\\", "/")
    variants = {normalized_root, normalized_root.replace("/", "\\")}
    if os.name == "nt":
        lowered = normalized_text.casefold()
        return any(variant.casefold() in lowered for variant in variants if variant)
    return any(variant in normalized_text for variant in variants if variant)

def _public_trim_text(value, maximum):
    if not isinstance(value, str):
        return ""
    if len(value) <= maximum:
        return value
    return value[:max(0, maximum - 3)].rstrip() + "..."


def _public_core_api():
    try:
        from vivary_core import (
            ContentPrivacyPathRefusedError,
            ContentPrivacyPolicyUnavailableError,
            content_privacy_policy,
            is_canonical_absolute_path,
            normalize_path,
        )
    except Exception:
        raise PrivacyPolicyUnavailableError() from None
    return {
        "path_error": ContentPrivacyPathRefusedError,
        "policy_error": ContentPrivacyPolicyUnavailableError,
        "policy": content_privacy_policy,
        "is_canonical_absolute_path": is_canonical_absolute_path,
        "normalize_path": normalize_path,
    }


def _public_require_root(root, allowlist, core):
    if (
        not isinstance(root, str)
        or type(allowlist) is not list
        or len(allowlist) != 1
        or allowlist[0] != root
        or not core["is_canonical_absolute_path"](root)
        or core["normalize_path"](root) != root
    ):
        raise PathRefusedError()
    try:
        info = os.lstat(root)
        resolved = core["normalize_path"](os.path.realpath(root))
    except (OSError, ValueError):
        raise PathRefusedError() from None
    if (
        not stat.S_ISDIR(info.st_mode)
        or _public_link_or_reparse(info)
        or resolved != root
    ):
        raise PathRefusedError()


def _public_candidate_from_info(rel, kind, info, full_path=None):
    if not _public_safe_relative_path(rel):
        return None, "unsafe_path"
    if _public_path_is_sensitive(rel):
        return None, "sensitive_name"
    if _public_link_or_reparse(info):
        return None, "link_or_reparse"
    if not _public_is_regular_single_link(info):
        return None, "hard_link_or_nonregular"
    if info.st_size < 0 or info.st_size > _PUBLIC_MAX_FILE_BYTES:
        return None, "file_size_limit"
    if full_path is None:
        change_marker = None if os.name == "nt" else _public_stat_ns(info, "ctime")
    else:
        change_marker = _public_path_change_marker(full_path, info)
        if change_marker is None:
            return None, "unavailable"
    return {
        "rel": rel,
        "kind": kind,
        "size": info.st_size,
        "device": info.st_dev,
        "inode": info.st_ino,
        "mtime": info.st_mtime,
        "ctime": info.st_ctime,
        "mtime_ns": getattr(info, "st_mtime_ns", int(info.st_mtime * 1_000_000_000)),
        "change_marker": change_marker,
    }, None


def _public_root_config_candidates(root, omissions):
    thin_rel = THIN_CONFIG_REL.replace(os.sep, "/")
    thin_path = os.path.join(root, THIN_CONFIG_REL)
    legacy_path = os.path.join(root, CONFIG_NAME)
    thin_exists = os.path.lexists(thin_path)
    legacy_exists = os.path.lexists(legacy_path)
    if not thin_exists and not legacy_exists:
        return [], True

    # A root tropo.toml beside thin-v0.3 is an explicit tighten-only overlay,
    # not an ambiguous second configuration. Both descriptors must enter the
    # privacy-admitted candidate set and both fail closed if either changes or
    # becomes unreadable. A legacy-only config retains its omission-compatible
    # public behavior.
    descriptors = (
        [(thin_rel, thin_path, True)]
        + ([(CONFIG_NAME, legacy_path, True)] if legacy_exists else [])
        if thin_exists
        else [(CONFIG_NAME, legacy_path, False)]
    )
    candidates = []
    complete = True
    for config_rel, config_path, required in descriptors:
        try:
            info = os.lstat(config_path)
        except OSError:
            if required:
                raise PrivacyPolicyUnavailableError() from None
            _public_add_omission(omissions, "config", "unavailable")
            complete = False
            continue
        candidate, reason = _public_candidate_from_info(
            config_rel,
            "config",
            info,
            config_path,
        )
        if candidate is None:
            if required:
                raise PrivacyPolicyUnavailableError()
            if reason == "file_size_limit":
                raise WorkLimitExceededError()
            _public_add_omission(omissions, "config", reason)
            continue
        candidates.append(candidate)
    return candidates, complete


def _public_enumerate_markdown(root, omissions, cancelled=None):
    """Enumerate metadata only; content cannot be opened before Core approves it."""
    markdown = []
    complete = True
    entries = 0
    pending = [("", root)]
    while pending:
        _public_cancel_if_requested(cancelled)
        rel_dir, full_dir = pending.pop()
        try:
            with os.scandir(full_dir) as iterator:
                children = []
                for entry in iterator:
                    _public_cancel_if_requested(cancelled)
                    if entries + len(children) >= _PUBLIC_MAX_FILESYSTEM_ENTRIES:
                        raise WorkLimitExceededError()
                    children.append(entry)
                children.sort(key=lambda entry: _public_sort_key(entry.name))
        except OSError:
            _public_add_omission(omissions, "filesystem", "directory_unavailable")
            complete = False
            continue
        directories = []
        for entry in children:
            _public_cancel_if_requested(cancelled)
            if entries >= _PUBLIC_MAX_FILESYSTEM_ENTRIES:
                raise WorkLimitExceededError()
            entries += 1
            name = entry.name
            rel = f"{rel_dir}/{name}" if rel_dir else name
            if not _public_safe_relative_path(rel):
                _public_add_omission(omissions, "filesystem", "unsafe_path")
                continue
            try:
                info = os.lstat(entry.path)
            except OSError:
                _public_add_omission(omissions, "filesystem", "entry_unavailable")
                complete = False
                continue
            if _public_link_or_reparse(info):
                _public_add_omission(omissions, "filesystem", "link_or_reparse")
                continue
            if stat.S_ISDIR(info.st_mode):
                if _public_path_is_sensitive(rel):
                    _public_add_omission(omissions, "filesystem", "sensitive_name")
                elif not is_excluded(rel, DEFAULT_EXCLUDE):
                    directories.append((rel, entry.path))
                continue
            if rel == CONFIG_NAME:
                continue
            if not stat.S_ISREG(info.st_mode):
                continue
            if not name.casefold().endswith((".md", ".markdown")):
                continue
            candidate, reason = _public_candidate_from_info(
                rel,
                "markdown",
                info,
                entry.path,
            )
            if candidate is None:
                if reason == "file_size_limit":
                    raise WorkLimitExceededError()
                _public_add_omission(omissions, "document", reason)
                continue


            if len(markdown) >= _PUBLIC_MAX_MARKDOWN_FILES:
                raise WorkLimitExceededError()
            markdown.append(candidate)
        pending.extend(reversed(directories))
    markdown.sort(key=lambda candidate: _public_sort_key(candidate["rel"]))
    return markdown, complete


def _public_stat_ns(info, name):
    return getattr(
        info,
        f"st_{name}_ns",
        int(getattr(info, f"st_{name}") * 1_000_000_000),
    )


def _public_path_change_marker(path, expected):
    if os.name != "nt":
        return _public_stat_ns(expected, "ctime")
    handle = _PUBLIC_CREATE_FILE(
        path,
        _PUBLIC_FILE_READ_ATTRIBUTES,
        _PUBLIC_FILE_SHARE_ALL,
        None,
        _PUBLIC_OPEN_EXISTING,
        _PUBLIC_FILE_FLAG_OPEN_REPARSE_POINT,
        None,
    )
    if handle == _PUBLIC_INVALID_HANDLE:
        return None
    try:
        basic = _PublicFileBasicInfo()
        identity = _PublicByHandleFileInformation()
        if (
            not _PUBLIC_GET_FILE_INFO_EX(
                handle,
                0,
                ctypes.byref(basic),
                ctypes.sizeof(basic),
            )
            or not _PUBLIC_GET_FILE_INFO(handle, ctypes.byref(identity))
        ):
            return None
        inode = (identity.file_index_high << 32) | identity.file_index_low
        size = (identity.file_size_high << 32) | identity.file_size_low
        if (
            identity.file_attributes & _PUBLIC_FILE_ATTRIBUTE_REPARSE_POINT
            or identity.number_of_links != 1
            or inode != expected.st_ino
            or size != expected.st_size
        ):
            return None
        return int(basic.change_time)
    finally:
        _PUBLIC_CLOSE_HANDLE(handle)


def _public_open_change_marker(file_fd, info):
    if os.name != "nt":
        return _public_stat_ns(info, "ctime")
    try:
        handle = wintypes.HANDLE(msvcrt.get_osfhandle(file_fd))
        basic = _PublicFileBasicInfo()
        if not _PUBLIC_GET_FILE_INFO_EX(
            handle,
            0,
            ctypes.byref(basic),
            ctypes.sizeof(basic),
        ):
            return None
        return int(basic.change_time)
    except OSError:
        return None


def _public_candidate_identity_matches(info, candidate, change_marker):
    return (
        _public_is_regular_single_link(info)
        and info.st_dev == candidate["device"]
        and info.st_ino == candidate["inode"]
        and info.st_size == candidate["size"]
        and _public_stat_ns(info, "mtime") == candidate["mtime_ns"]
        and change_marker is not None
        and change_marker == candidate["change_marker"]
    )


def _public_open_identity_matches(before, after, before_change, after_change):
    return (
        _public_is_regular_single_link(after)
        and before.st_dev == after.st_dev
        and before.st_ino == after.st_ino
        and before.st_size == after.st_size
        and _public_stat_ns(before, "mtime") == _public_stat_ns(after, "mtime")
        and before_change is not None
        and before_change == after_change
    )


def _public_read_candidate(root, candidate, cancelled=None):
    """Read a previously lstat'd single-link file through a checked descriptor."""
    root_fd = -1
    parent_fd = -1
    file_fd = -1
    try:
        _public_cancel_if_requested(cancelled)
        file_flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
        nofollow = getattr(os, "O_NOFOLLOW", 0)
        supports_dir_fd = os.open in getattr(os, "supports_dir_fd", set())
        pieces = candidate["rel"].split("/")
        if supports_dir_fd:
            directory_flags = (
                os.O_RDONLY
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_CLOEXEC", 0)
                | nofollow
            )
            root_fd = os.open(root, directory_flags)
            parent_fd = root_fd
            for piece in pieces[:-1]:
                _public_cancel_if_requested(cancelled)
                next_fd = os.open(piece, directory_flags, dir_fd=parent_fd)
                if parent_fd != root_fd:
                    os.close(parent_fd)
                parent_fd = next_fd
            file_fd = os.open(pieces[-1], file_flags | nofollow, dir_fd=parent_fd)
        else:
            current = root
            for index, piece in enumerate(pieces):
                _public_cancel_if_requested(cancelled)
                current = os.path.join(current, piece)
                info = os.lstat(current)
                if _public_link_or_reparse(info):
                    return None, "link_or_reparse"
                if index < len(pieces) - 1 and not stat.S_ISDIR(info.st_mode):
                    return None, "unavailable"
            file_fd = os.open(current, file_flags | nofollow)
        info = os.fstat(file_fd)
        change_marker = _public_open_change_marker(file_fd, info)
        if (
            not _public_candidate_identity_matches(info, candidate, change_marker)
            or info.st_size > _PUBLIC_MAX_FILE_BYTES
        ):
            return None, "changed"
        remaining = _PUBLIC_MAX_FILE_BYTES + 1
        chunks = []
        while remaining:
            _public_cancel_if_requested(cancelled)
            chunk = os.read(file_fd, min(65_536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(file_fd)
        after_change_marker = _public_open_change_marker(file_fd, after)
        if not _public_open_identity_matches(
            info,
            after,
            change_marker,
            after_change_marker,
        ):
            return None, "changed"
        data = b"".join(chunks)
        if len(data) > _PUBLIC_MAX_FILE_BYTES:
            return None, "file_size_limit"
        return data, None
    except OSError:
        return None, "unavailable"
    finally:
        if file_fd >= 0:
            os.close(file_fd)
        if parent_fd >= 0 and parent_fd != root_fd:
            os.close(parent_fd)
        if root_fd >= 0:
            os.close(root_fd)


def _public_apply_privacy_policy(root, candidates, core, cancelled=None):
    candidate_paths = [candidate["rel"] for candidate in candidates]
    _public_cancel_if_requested(cancelled)
    try:
        result = core["policy"](
            root,
            candidate_paths,
            allowlist=[root],
            cancelled=cancelled,
        )
    except core["path_error"]:
        _public_cancel_if_requested(cancelled)
        raise PathRefusedError() from None
    except core["policy_error"]:
        _public_cancel_if_requested(cancelled)
        raise PrivacyPolicyUnavailableError() from None
    except Exception:
        _public_cancel_if_requested(cancelled)
        raise PrivacyPolicyUnavailableError() from None
    _public_cancel_if_requested(cancelled)
    allowed_paths = result.get("allowed_paths") if type(result) is dict else None
    omission_rows = result.get("omissions") if type(result) is dict else None
    if (
        type(result) is not dict
        or result.get("schema") != "vivary.content-privacy-policy/v0"
        or result.get("status") != "known"
        or result.get("complete") is not True
        or re.fullmatch(r"sha256:[0-9a-f]{64}", result.get("privacy_fingerprint", ""))
        is None
        or type(allowed_paths) is not list
        or allowed_paths != sorted(allowed_paths, key=_public_sort_key)
        or any(path not in candidate_paths for path in allowed_paths)
        or len(set(allowed_paths)) != len(allowed_paths)
        or type(omission_rows) is not list
        or len(omission_rows) > _PUBLIC_MAX_OMISSIONS
        or any(
            type(row) is not dict
            or set(row) != {"kind", "reason", "count"}
            or row.get("kind") != "privacy_excluded"
            or row.get("reason") not in {"git_ignored", "sensitive_name"}
            or isinstance(row.get("count"), bool)
            or not isinstance(row.get("count"), int)
            or row["count"] < 1
            for row in omission_rows
        )
        or len(allowed_paths) + sum(row["count"] for row in omission_rows)
        != len(candidate_paths)
    ):
        raise PrivacyPolicyUnavailableError()
    omissions = {
        (row["kind"], row["reason"]): row["count"] for row in omission_rows
    }
    return (
        set(allowed_paths),
        [result["privacy_fingerprint"]],
        omissions,
    )


def _public_config_shape_is_safe(raw):
    if type(raw) is not dict:
        return False
    packs = raw.get("packs", [])
    exclude = raw.get("exclude", [])
    base = raw.get("base", {})
    types = raw.get("types", {})
    if (
        type(packs) is not list
        or len(packs) > _PUBLIC_MAX_FILTERS
        or any(not _public_safe_text(value, 128) for value in packs)
        or type(exclude) is not list
        or len(exclude) > 128
        or any(not _public_safe_text(value, _PUBLIC_MAX_PATH_CHARS) for value in exclude)
        or type(base) is not dict
        or type(types) is not dict
        or len(types) > 128
    ):
        return False
    if "derive" in base and (
        type(base["derive"]) is not list
        or len(base["derive"]) > 64
        or any(not _public_safe_text(value, 128) for value in base["derive"])
    ):
        return False
    for field_name in ("required", "optional"):
        if field_name in base and (
            type(base[field_name]) is not dict or len(base[field_name]) > 128
        ):
            return False
    for name, definition in types.items():
        if not _public_safe_text(name, 128) or type(definition) is not dict:
            return False
        for field_name in ("required", "optional"):
            fields = definition.get(field_name, {})
            if type(fields) is not dict or len(fields) > 128:
                return False
        folders = definition.get("folder", name)
        folders = folders if type(folders) is list else [folders]
        if (
            len(folders) > _PUBLIC_MAX_FILTERS
            or any(not _public_safe_text(folder, _PUBLIC_MAX_PATH_CHARS) for folder in folders)
        ):
            return False
    return True


def _public_default_config(root):
    return Config({"base": {}, "types": {}, "exclude": []}, root)


def _public_config_from_candidates(
    root,
    candidates,
    allowed,
    omissions,
    cancelled=None,
):
    """Compose privacy-admitted thin/base TOML and a tighten-only root overlay."""
    if not candidates:
        return _public_default_config(root), None, True
    thin_rel = THIN_CONFIG_REL.replace(os.sep, "/")
    has_thin = candidates[0].get("rel") == thin_rel
    parsed = []
    try:
        for candidate in candidates:
            if candidate["rel"] not in allowed:
                if has_thin:
                    raise PrivacyPolicyUnavailableError()
                _public_add_omission(omissions, "config", "git_ignored")
                return _public_default_config(root), None, False
            data, reason = _public_read_candidate(root, candidate, cancelled)
            if data is None:
                if reason == "file_size_limit":
                    raise WorkLimitExceededError()
                if has_thin:
                    raise PrivacyPolicyUnavailableError()
                _public_add_omission(omissions, "config", reason)
                return _public_default_config(root), None, False
            text = data.decode("utf-8", errors="replace")
            if _public_text_has_credential(text) or _public_contains_workspace_path(text, root):
                if has_thin:
                    raise PrivacyPolicyUnavailableError()
                _public_add_omission(omissions, "config", "sensitive_content")
                return _public_default_config(root), None, False
            try:
                raw = tomllib.loads(text.lstrip(UTF8_BOM))
            except (TypeError, ValueError, tomllib.TOMLDecodeError):
                if has_thin:
                    raise PrivacyPolicyUnavailableError() from None
                _public_add_omission(omissions, "config", "invalid")
                return _public_default_config(root), None, False
            if not _public_config_shape_is_safe(raw):
                if has_thin:
                    raise PrivacyPolicyUnavailableError()
                _public_add_omission(omissions, "config", "unsupported")
                return _public_default_config(root), None, False
            if candidate["rel"] == thin_rel:
                _validate_thin_workspace(
                    raw,
                    os.path.join(root, THIN_CONFIG_REL),
                    root,
                )
            parsed.append((candidate, raw, data))

        composed = {"base": {}, "types": {}, "exclude": []}
        base_raw = parsed[0][1]
        for pack in base_raw.get("packs", []):
            if pack not in BUNDLED_PACKS:
                _public_add_omission(omissions, "config", "local_pack_excluded")
                continue
            _merge_config(composed, tomllib.loads(BUNDLED_PACKS[pack]))
        for _candidate, raw, _data in parsed:
            _merge_config(composed, raw)
        config = Config(composed, root)
    except (AttributeError, ConfigError, TypeError, ValueError, tomllib.TOMLDecodeError):
        if has_thin:
            raise PrivacyPolicyUnavailableError() from None
        _public_add_omission(omissions, "config", "invalid")
        return _public_default_config(root), None, False
    if len(parsed) == 1:
        # Preserve the established fingerprint for legacy-only and thin-only
        # workspaces; only the newly supported two-file composition needs a
        # composite identity.
        digest = hashlib.sha256(parsed[0][2]).hexdigest()
    else:
        digest_payload = [
            {
                "path": candidate["rel"],
                "sha256": hashlib.sha256(data).hexdigest(),
            }
            for candidate, _raw, data in parsed
        ]
        digest = hashlib.sha256(
            json.dumps(
                digest_payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
    return config, digest, True


def _public_derived_fields(full, body, info):
    try:
        created = datetime.date.fromtimestamp(
            min(info.st_mtime, info.st_ctime)
        ).isoformat()
        updated = datetime.date.fromtimestamp(info.st_mtime).isoformat()
    except (OverflowError, OSError, ValueError):
        created = updated = "1970-01-01"
    sid = _derive_id(full)
    heading = re.search(r"^#\s+(.+)$", body, re.M)
    title = heading.group(1).strip() if heading else sid.replace("-", " ").title()
    return {
        "id": sid,
        "slug": sid,
        "title": _public_trim_text(title, _PUBLIC_MAX_TITLE_CHARS),
        "created": created,
        "updated": updated,
    }


def _public_add_finding(doc, state, finding_state, level, code, line):
    state["total"] += 1
    state[level] += 1
    if not state["collect"]:
        return
    if finding_state["emitted"] >= _PUBLIC_MAX_FINDINGS:
        raise WorkLimitExceededError()
    doc.findings.append(
        Finding(
            doc.rel,
            max(0, int(line or 0)),
            level,
            code,
            _PUBLIC_FINDING_MESSAGES.get(code, "document validation finding"),
        )
    )
    finding_state["emitted"] += 1

def _public_safe_edge_value(field, target):
    return (
        _public_output_text_is_safe(field, 128)
        and _public_output_text_is_safe(
            target, _PUBLIC_MAX_EDGE_FILTER_CHARS
        )
        and not _PUBLIC_ABSOLUTE_VALUE_RE.match(target)
    )


def _public_analyze_document(full, rel, config, text, info, *, collect, finding_state):
    """Analyze safe bytes without delegating to path-opening legacy helpers."""
    doc = Doc()
    doc.full, doc.rel = full, rel
    doc.findings, doc.refs, doc.declared, doc.noise = [], [], {}, []
    state = {"collect": collect, "total": 0, "error": 0, "warning": 0}
    edge_omitted = 0
    yaml_text, body = extract_frontmatter(text)
    doc.derived = _public_derived_fields(full, body, info)
    fields, key_lines = {}, {}
    if yaml_text is not None:
        try:
            parsed = parse_yaml(yaml_text)
        except YamlError as error:
            _public_add_finding(doc, state, finding_state, "error", "E001", error.lineno + 1)
            doc.type, doc.fields = type_for(full, config), {}
            return doc, state, edge_omitted
        if not isinstance(parsed, dict):
            _public_add_finding(doc, state, finding_state, "error", "E001", 2)
            doc.type, doc.fields = type_for(full, config), {}
            return doc, state, edge_omitted
        key_lines = parsed.get("__lines__", {})
        fields = strip_meta(parsed)
    doc.fields = fields

    def line_of(key):
        value = key_lines.get(key, 1)
        return value + 1 if isinstance(value, int) else 1

    doc.type = type_for(full, config)
    if doc.type is None and not config.allow_untyped:
        _public_add_finding(
            doc,
            state,
            finding_state,
            "error",
            "W201",
            1,
        )
    required, known = config.fields_for(doc.type)
    for key, spec in required.items():
        if key not in fields:
            _public_add_finding(doc, state, finding_state, "error", "E101", 1)
        elif fields[key] is None or fields[key] == "":
            _public_add_finding(doc, state, finding_state, "error", "E102", line_of(key))
    for key, value in fields.items():
        if key in config.derive:
            if value == doc.derived.get(key):
                doc.noise.append(key)
                _public_add_finding(doc, state, finding_state, "warning", "W210", line_of(key))
            continue
        spec = known.get(key)
        if spec is None:
            if doc.type is not None:
                _public_add_finding(
                    doc,
                    state,
                    finding_state,
                    "warning",
                    "W202",
                    line_of(key),
                )
            continue
        if spec in ("ref", "ref-list") and value is not None:
            targets = value if isinstance(value, list) else [value]
            for target in targets:
                if not isinstance(target, str) or not _public_safe_edge_value(key, target):
                    edge_omitted += 1
                    _public_add_finding(doc, state, finding_state, "error", "E103", line_of(key))
                elif len(doc.refs) < _PUBLIC_MAX_EDGES_PER_DOCUMENT:
                    doc.refs.append((key, target, line_of(key)))
                else:
                    edge_omitted += 1
        error = check_field_type(value, spec)
        if error:
            _public_add_finding(doc, state, finding_state, "error", "E103", line_of(key))
        else:
            doc.declared[key] = value
    return doc, state, edge_omitted


def _public_path_selected(rel, paths):
    return not paths or any(rel == path or rel.startswith(path + "/") for path in paths)


def _public_snapshot_fingerprint(documents, config_digest, privacy_fingerprints, omissions, complete):
    payload = {
        "schema": "vivary.tropo-document-snapshot/v0",
        "config": config_digest or "default",
        "documents": [
            {
                "path": record["doc"].rel,
                "content": hashlib.sha256(record["body"].encode("utf-8")).hexdigest(),
            }
            for record in documents
        ],
        "privacy": privacy_fingerprints,
        "omissions": _public_omission_rows(omissions),
        "complete": complete,
    }
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _public_document_snapshot(
    root,
    *,
    allowlist,
    validation_paths=None,
    cancelled=None,
):
    core = _public_core_api()
    _public_require_root(root, allowlist, core)
    _public_cancel_if_requested(cancelled)
    omissions = {}
    config_candidates, config_candidate_complete = _public_root_config_candidates(root, omissions)
    markdown, enumeration_complete = _public_enumerate_markdown(
        root,
        omissions,
        cancelled,
    )
    candidates = config_candidates + markdown
    candidates.sort(key=lambda candidate: _public_sort_key(candidate["rel"]))
    allowed, privacy_fingerprints, privacy_omissions = _public_apply_privacy_policy(
        root,
        candidates,
        core,
        cancelled,
    )
    for (kind, reason), count in privacy_omissions.items():
        _public_add_omission(omissions, kind, reason, count)
    config, config_digest, config_complete = _public_config_from_candidates(
        root,
        config_candidates,
        allowed,
        omissions,
        cancelled,
    )
    remaining_bytes = _PUBLIC_MAX_AGGREGATE_BYTES
    for config_candidate in config_candidates:
        if config_candidate["rel"] in allowed:
            # Configs have already been descriptor-read above. Account for the
            # descriptor-verified size even when a legacy config was omitted.
            remaining_bytes -= config_candidate["size"]
    documents = []
    finding_state = {"emitted": 0, "suppressed": 0}
    complete = (
        config_candidate_complete
        and enumeration_complete
        and config_complete
    )
    for candidate in markdown:
        _public_cancel_if_requested(cancelled)
        rel = candidate["rel"]
        if rel not in allowed:
            continue
        if is_excluded(rel, config.exclude):
            _public_add_omission(omissions, "document", "config_excluded")
            continue
        if candidate["size"] > remaining_bytes:
            raise WorkLimitExceededError()
        data, reason = _public_read_candidate(root, candidate, cancelled)
        if data is None:
            if reason == "file_size_limit":
                raise WorkLimitExceededError()
            _public_add_omission(omissions, "document", reason)
            complete = False
            continue
        remaining_bytes -= len(data)
        text = data.decode("utf-8", errors="replace")
        if _public_text_has_credential(text) or _public_contains_workspace_path(text, root):
            _public_add_omission(omissions, "document", "sensitive_content")
            continue
        full = os.path.join(root, *rel.split("/"))
        try:
            doc_info = type(
                "_PublicStat",
                (),
                {
                    "st_mtime": candidate["mtime"],
                    "st_ctime": candidate["ctime"],
                },
            )()
            doc, state, edge_omitted = _public_analyze_document(
                full,
                rel,
                config,
                text,
                doc_info,
                collect=(
                    validation_paths is not None
                    and _public_path_selected(rel, validation_paths)
                ),
                finding_state=finding_state,
            )
        except WorkLimitExceededError:
            raise
        except Exception:
            _public_add_omission(omissions, "document", "analysis_unavailable")
            complete = False
            continue
        if edge_omitted:
            _public_add_omission(omissions, "edge", "edge_limit_or_unsafe", edge_omitted)
            complete = False
        documents.append({"doc": doc, "body": text, "findings": state})
    documents.sort(key=lambda record: _public_sort_key(record["doc"].rel))
    revalidated = _public_apply_privacy_policy(
        root,
        candidates,
        core,
        cancelled,
    )
    # Bind both the policy identity and its canonical exclusion accounting. The
    # latter stays fail-closed even if a provider returns an inconsistent body
    # and fingerprint.
    if revalidated != (allowed, privacy_fingerprints, privacy_omissions):
        raise PrivacyPolicyUnavailableError()
    if validation_paths is not None:
        selected = [
            record for record in documents
            if _public_path_selected(record["doc"].rel, validation_paths)
        ]
        ids = {record["doc"].derived.get("id") for record in selected}
        for record in selected:
            doc = record["doc"]
            for _key, target, line in doc.refs:
                if target not in ids:
                    _public_add_finding(
                        doc, record["findings"], finding_state, "warning", "W220", line
                    )
    fingerprint = _public_snapshot_fingerprint(
        documents, config_digest, privacy_fingerprints, omissions, complete
    )
    return {
        "config": config,
        "complete": complete,
        "documents": documents,
        "fingerprint": fingerprint,
        "finding_suppressed": finding_state["suppressed"],
        "omissions": omissions,
    }


def _public_query_value(root, value):
    if (
        not _public_output_text_is_safe(value, _PUBLIC_MAX_QUERY_CHARS)
        or _public_contains_workspace_path(value, root)
    ):
        raise PathRefusedError()
    return value


def _public_bounded_integer(value, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("integer argument required")
    if value < minimum or value > maximum:
        raise ValueError("integer argument outside the public bound")
    return value


def _public_filter_values(values, maximum_length, *, paths=False, edges=False):
    if values is None:
        return []
    if not isinstance(values, (list, tuple)) or len(values) > _PUBLIC_MAX_FILTERS:
        raise ValueError("filter list outside the public bound")
    result = []
    for value in values:
        if not _public_output_text_is_safe(value, maximum_length):
            raise PathRefusedError() if paths else ValueError("unsafe filter")
        if paths and (
            "\\" in value
            or value.startswith("/")
            or re.match(r"^[A-Za-z]:", value)
            or any(part in ("", ".", "..") for part in value.split("/"))
            or _public_path_is_sensitive(value)
        ):
            raise PathRefusedError()
        if edges:
            field, separator, target = value.partition(":")
            if (
                not field
                or not _public_output_text_is_safe(field, 128)
                or (
                    separator
                    and not _public_output_text_is_safe(
                        target, _PUBLIC_MAX_EDGE_FILTER_CHARS
                    )
                )
                or (separator and _PUBLIC_ABSOLUTE_VALUE_RE.match(target))
            ):
                raise PathRefusedError()
        if value in result:
            raise ValueError("duplicate filter")
        result.append(value)
    return result


def _public_validation_paths(paths):
    if paths is None:
        return []
    if (
        not isinstance(paths, (list, tuple))
        or len(paths) > _PUBLIC_MAX_CHECK_PATHS
    ):
        raise PathRefusedError()
    result = []
    for path in paths:
        if (
            not _public_safe_relative_path(path)
            or _public_path_is_sensitive(path)
            or path in result
        ):
            raise PathRefusedError()
        result.append(path)
    return result


def _public_filters(type_filters, path_filters, edge_filters):
    return {
        "type": _public_filter_values(
            type_filters, _PUBLIC_MAX_TYPE_FILTER_CHARS
        ),
        "path": _public_filter_values(
            path_filters, _PUBLIC_MAX_PATH_CHARS, paths=True
        ),
        "edge": _public_filter_values(
            edge_filters, _PUBLIC_MAX_EDGE_FILTER_CHARS, edges=True
        ),
    }


def _public_search_hits(
    snapshot,
    text,
    *,
    k,
    filters,
    snippet_chars,
    explain,
    cancelled=None,
):
    documents = snapshot["documents"]
    docs = [record["doc"] for record in documents]
    bodies = {record["doc"].full: record["body"] for record in documents}
    try:
        ranked = _search_docs(
            docs,
            text,
            k=k,
            type_filters=filters["type"],
            path_filters=filters["path"],
            edge_filters=filters["edge"],
            snippet_chars=snippet_chars,
            explain=True,
            body_lookup=bodies,
            cancelled=cancelled,
        )
    except Exception:
        raise ProducerUnavailableError() from None
    hits = []
    for result in ranked:
        _public_cancel_if_requested(cancelled)
        path = result.get("path")
        identifier = result.get("id")
        if (
            not _public_safe_relative_path(path)
            or not _public_output_text_is_safe(identifier, 512)
        ):
            raise ProducerUnavailableError()
        title = result.get("title")
        if not _public_output_text_is_safe(title, _PUBLIC_MAX_TITLE_CHARS):
            title = identifier
        result_type = result.get("type")
        if result_type is not None and not _public_output_text_is_safe(
            result_type, _PUBLIC_MAX_TYPE_FILTER_CHARS
        ):
            result_type = None
        snippet = result.get("snippet")
        if snippet is not None and not _public_output_text_is_safe(
            snippet, _PUBLIC_MAX_SNIPPET_CHARS + 6
        ):
            snippet = None
        edges = []
        for edge in result.get("edges", []):
            _public_cancel_if_requested(cancelled)
            field = edge.get("field") if type(edge) is dict else None
            target = edge.get("to") if type(edge) is dict else None
            if not _public_safe_edge_value(field, target):
                raise ProducerUnavailableError()
            edges.append({"field": field, "to": target})
        reasons = [
            reason
            for reason in result.get("reasons", [])
            if _public_output_text_is_safe(reason, 64)
        ]
        hits.append(
            {
                "id": identifier,
                "type": result_type,
                "path": path,
                "title": title,
                "score": result["score"],
                "snippet": snippet,
                "reasons": reasons if explain else [],
                "edges": edges if explain or filters["edge"] else [],
            }
        )
    hits.sort(
        key=lambda hit: (
            -hit["score"],
            _public_sort_key(hit["path"]),
            _public_sort_key(hit["id"]),
        )
    )
    return hits


def query_context(
    root,
    text,
    *,
    k=10,
    type_filters=(),
    path_filters=(),
    edge_filters=(),
    snippet_chars=160,
    explain=False,
    allowlist=None,
    cancelled=None,
):
    """Query one bounded, privacy-filtered Markdown snapshot."""

    text = _public_query_value(root, text)
    k = _public_bounded_integer(k, 1, _PUBLIC_MAX_RESULTS)
    snippet_chars = _public_bounded_integer(
        snippet_chars, 0, _PUBLIC_MAX_SNIPPET_CHARS
    )
    if type(explain) is not bool:
        raise ValueError("explain must be boolean")
    filters = _public_filters(type_filters, path_filters, edge_filters)
    snapshot = _public_document_snapshot(
        root,
        allowlist=allowlist,
        cancelled=cancelled,
    )
    results = _public_search_hits(
        snapshot,
        text,
        k=k,
        filters=filters,
        snippet_chars=snippet_chars,
        explain=explain,
        cancelled=cancelled,
    )
    return {
        "schema": _PUBLIC_QUERY_SCHEMA,
        "query": text,
        "k": k,
        "filters": filters,
        "results": results,
        "complete": snapshot["complete"],
        "workspace_fingerprint": snapshot["fingerprint"],
        "omissions": _public_omission_rows(snapshot["omissions"]),
    }


def find_context(
    root,
    question,
    *,
    k=5,
    budget=1_200,
    type_filters=(),
    path_filters=(),
    edge_filters=(),
    snippet_chars=320,
    allowlist=None,
    cancelled=None,
):
    """Return a budgeted context packet from one governed document snapshot."""

    question = _public_query_value(root, question)
    k = _public_bounded_integer(k, 1, _PUBLIC_MAX_RESULTS)
    budget = _public_bounded_integer(
        budget, _PUBLIC_MIN_FIND_BUDGET, _PUBLIC_MAX_FIND_BUDGET
    )
    snippet_chars = _public_bounded_integer(
        snippet_chars, 0, _PUBLIC_MAX_SNIPPET_CHARS
    )
    filters = _public_filters(type_filters, path_filters, edge_filters)
    snapshot = _public_document_snapshot(
        root,
        allowlist=allowlist,
        cancelled=cancelled,
    )
    ranked = _public_search_hits(
        snapshot,
        question,
        k=k,
        filters=filters,
        snippet_chars=snippet_chars,
        explain=True,
        cancelled=cancelled,
    )
    results = []
    estimated_tokens = 0
    omissions = dict(snapshot["omissions"])
    for index, hit in enumerate(ranked):
        _public_cancel_if_requested(cancelled)
        projected = {
            "id": hit["id"],
            "type": hit["type"],
            "path": hit["path"],
            "reason": hit["reasons"][0] if hit["reasons"] else "typed context match",
            "snippet": hit["snippet"],
            "edges": hit["edges"],
        }
        encoded = json.dumps(
            projected, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        projected_tokens = (len(encoded) + 3) // 4
        if estimated_tokens + projected_tokens > budget:
            _public_add_omission(
                omissions, "result", "budget_limit", len(ranked) - index
            )
            break
        results.append(projected)
        estimated_tokens += projected_tokens
    complete = snapshot["complete"] and len(results) == len(ranked)
    return {
        "schema": _PUBLIC_FIND_SCHEMA,
        "query": question,
        "k": k,
        "budget": budget,
        "estimated_tokens": estimated_tokens,
        "filters": filters,
        "results": results,
        "complete": complete,
        "workspace_fingerprint": snapshot["fingerprint"],
        "omissions": _public_omission_rows(omissions),
    }


def check_workspace(
    root,
    *,
    paths=(),
    strict=None,
    allowlist=None,
    cancelled=None,
):
    """Validate one bounded, privacy-filtered Markdown snapshot."""

    selected_paths = _public_validation_paths(paths)
    if strict is not None and type(strict) is not bool:
        raise ValueError("strict must be boolean")
    snapshot = _public_document_snapshot(
        root,
        allowlist=allowlist,
        validation_paths=selected_paths,
        cancelled=cancelled,
    )
    strict_value = snapshot["config"].strict if strict is None else strict
    if type(strict_value) is not bool:
        raise ProducerUnavailableError()
    selected = []
    for record in snapshot["documents"]:
        _public_cancel_if_requested(cancelled)
        if _public_path_selected(record["doc"].rel, selected_paths):
            selected.append(record)
    omissions = dict(snapshot["omissions"])
    missing = 0
    for path in selected_paths:
        _public_cancel_if_requested(cancelled)
        found = False
        for record in selected:
            _public_cancel_if_requested(cancelled)
            relative = record["doc"].rel
            if relative == path or relative.startswith(path + "/"):
                found = True
                break
        if not found:
            missing += 1
    _public_add_omission(omissions, "selection", "path_not_found", missing)
    findings = []
    for record in selected:
        _public_cancel_if_requested(cancelled)
        for finding in record["doc"].findings:
            findings.append(finding.as_dict())
    findings.sort(
        key=lambda finding: (
            _public_sort_key(finding["path"]),
            finding["line"],
            finding["level"],
            finding["code"],
        )
    )
    errors = 0
    warnings = 0
    clean = 0
    for record in selected:
        _public_cancel_if_requested(cancelled)
        errors += record["findings"]["error"]
        warnings += record["findings"]["warning"]
        clean += record["findings"]["total"] == 0
    return {
        "schema": _PUBLIC_CHECK_SCHEMA,
        "checked": len(selected),
        "clean": clean,
        "errors": errors,
        "warnings": warnings,
        "findings": findings,
        "strict": strict_value,
        "complete": snapshot["complete"] and missing == 0,
        "workspace_fingerprint": snapshot["fingerprint"],
        "omissions": _public_omission_rows(omissions),
    }

def _stringify_field_value(value):
    if isinstance(value, list):
        return ", ".join(_stringify_field_value(v) for v in value)
    if isinstance(value, dict):
        return " ".join(
            f"{k}: {_stringify_field_value(v)}" for k, v in sorted(value.items())
            if k != "__lines__"
        )
    return "" if value is None else str(value)


def _query_terms(text):
    raw = re.findall(r"[a-z0-9]+", text.lower())
    terms = [t for t in raw if t not in _QUERY_STOPWORDS]
    return terms or raw


def _governed_query_terms(text):
    raw = re.findall(r"[^\W_]+", text.lower(), flags=re.UNICODE)
    terms = [
        term
        for term in raw
        if term not in _QUERY_STOPWORDS
        and (len(term) > 1 or not term.isascii())
    ]
    bounded = []
    for term in terms:
        if term not in bounded:
            bounded.append(term)
            if len(bounded) == _MAX_GOVERNED_QUERY_TERMS:
                break
    return bounded


def _normalize_glob(pattern):
    return pattern.replace("\\", "/")


def _edge_filter_matches(edges, spec):
    if ":" in spec:
        field, target = spec.split(":", 1)
    else:
        field, target = spec, ""
    field = field.strip()
    target = target.strip()
    for edge in edges:
        if field and edge["field"] != field:
            continue
        if target and edge["to"] != target:
            continue
        return True
    return False


def _build_search_records(
    docs,
    nodes,
    edges,
    body_limit=None,
    body_lookup=None,
    cancelled=None,
):
    docs_by_id = {d.derived.get("id"): d for d in docs if d.derived.get("id") is not None}
    outbound = {}
    for edge in edges:
        _public_cancel_if_requested(cancelled)
        if edge["broken"]:
            continue
        outbound.setdefault(edge["from"], []).append({
            "field": edge["field"],
            "to": edge["to"],
        })
    records = []
    for nid in sorted(nodes):
        _public_cancel_if_requested(cancelled)
        doc = docs_by_id.get(nid)
        node = nodes[nid]
        fields = doc.fields if doc is not None else {}
        frontmatter_text = " ".join(
            f"{key}: {_stringify_field_value(value)}"
            for key, value in sorted(fields.items())
        )
        if doc is None:
            body = ""
        elif body_lookup is not None:
            body = body_lookup.get(doc.full, "")
        else:
            body = _file_body(doc.full, limit=body_limit)
        title = (doc.derived.get("title") if doc is not None else "") or nid
        records.append({
            "id": nid,
            "type": node.get("type"),
            "path": node.get("path", ""),
            "title": title,
            "frontmatter_text": frontmatter_text,
            "body": body,
            "edges": outbound.get(nid, []),
        })
    return records


def _score_source(
    query,
    terms,
    source,
    phrase_weight,
    term_weight,
    cancelled=None,
):
    if not source:
        return 0, False
    source_l = source.lower()
    query_l = query.lower().strip()
    score = 0
    matched = False
    if query_l and query_l in source_l:
        score += phrase_weight
        matched = True
    for term in terms:
        _public_cancel_if_requested(cancelled)
        count = len(re.findall(rf"\b{re.escape(term)}\b", source_l))
        if count:
            score += count * term_weight
            matched = True
    return score, matched


def _best_snippet(record, query, terms, limit, cancelled=None):
    if limit is None:
        limit = _DEFAULT_SNIPPET_CHARS
    if limit <= 0:
        return None
    source = record.get("body") or record.get("frontmatter_text") or record.get("title") or ""
    text = re.sub(r"\s+", " ", source).strip()
    if not text:
        return None
    lower = text.lower()
    needles = [query.lower().strip(), *terms]
    starts = []
    for needle in needles:
        _public_cancel_if_requested(cancelled)
        if not needle:
            continue
        start = lower.find(needle)
        if start >= 0:
            starts.append(start)
    start = min(starts) if starts else 0
    if len(text) <= limit:
        return text
    half = max(0, limit // 2)
    left = max(0, start - half)
    right = min(len(text), left + limit)
    if right - left < limit:
        left = max(0, right - limit)
    snippet = text[left:right].strip()
    if left > 0:
        snippet = "..." + snippet
    if right < len(text):
        snippet += "..."
    return snippet


def _passes_search_filters(record, type_filters, path_filters, edge_filters):
    if type_filters and (record.get("type") or "") not in set(type_filters):
        return False
    if path_filters:
        path = record.get("path", "")
        if not any(fnmatchcase(path, _normalize_glob(p)) for p in path_filters):
            return False
    if edge_filters and not all(
        _edge_filter_matches(record.get("edges", []), e) for e in edge_filters
    ):
        return False
    return True


def _rank_search_records(
    records, text, *, k=10, type_filters=None,
    path_filters=None, edge_filters=None,
    snippet_chars=_DEFAULT_SNIPPET_CHARS, explain=False, cancelled=None,
):
    terms = _query_terms(text)
    type_filters = type_filters or []
    path_filters = path_filters or []
    edge_filters = edge_filters or []
    results = []

    for record in records:
        _public_cancel_if_requested(cancelled)
        if not _passes_search_filters(record, type_filters, path_filters, edge_filters):
            continue

        score = 0
        reasons = []
        id_title = f"{record['id']} {record['title']}"
        s, matched = _score_source(
            text, terms, id_title, 120, 40, cancelled
        )
        if matched:
            score += s
            reasons.append("title/id match")
        s, matched = _score_source(
            text, terms, record["frontmatter_text"], 80, 24, cancelled
        )
        if matched:
            score += s
            reasons.append("frontmatter match")
        s, matched = _score_source(
            text, terms, record["path"], 60, 16, cancelled
        )
        if matched:
            score += s
            reasons.append("path match")
        s, matched = _score_source(
            text, terms, record["body"], 40, 10, cancelled
        )
        if matched:
            score += s
            reasons.append("body match")
        edge_text = " ".join(f"{e['field']} {e['to']}" for e in record["edges"])
        s, matched = _score_source(
            text, terms, edge_text, 30, 8, cancelled
        )
        if matched:
            score += s
            reasons.append("edge context match")
        if edge_filters:
            score += 20 * len(edge_filters)
            reasons.append("edge filter match")

        if score <= 0:
            continue
        result = {
            "id": record["id"],
            "type": record["type"],
            "path": record["path"],
            "title": record["title"],
            "score": score,
        }
        snippet = _best_snippet(
            record, text, terms, snippet_chars, cancelled
        )
        if snippet:
            result["snippet"] = snippet
        if explain:
            result["reasons"] = reasons
        if explain or edge_filters:
            result["edges"] = record["edges"]
        results.append(result)

    results.sort(key=lambda r: (-r["score"], r["path"], r["id"]))
    return results[:max(0, k)]


def _search_docs(
    docs, text, *, k=10, type_filters=None, path_filters=None,
    edge_filters=None, snippet_chars=_DEFAULT_SNIPPET_CHARS,
    explain=False, body_lookup=None, cancelled=None,
):
    nodes, edges = build_graph(docs)
    records = _build_search_records(
        docs,
        nodes,
        edges,
        body_limit=None,
        body_lookup=body_lookup,
        cancelled=cancelled,
    )
    return _rank_search_records(
        records,
        text,
        k=k,
        type_filters=type_filters,
        path_filters=path_filters,
        edge_filters=edge_filters,
        snippet_chars=snippet_chars,
        explain=explain,
        cancelled=cancelled,
    )


def search_graph(resolver, text, *, k=10, type_filters=None, path_filters=None,
                 edge_filters=None, snippet_chars=_DEFAULT_SNIPPET_CHARS,
                 explain=False):
    docs = analyze(resolver.root, [], resolver)
    return _search_docs(
        docs,
        text,
        k=k,
        type_filters=type_filters,
        path_filters=path_filters,
        edge_filters=edge_filters,
        snippet_chars=snippet_chars,
        explain=explain,
    )


def _text_vector_fallback(resolver, text, k, type_filters, path_filters, edge_filters,
                          snippet_chars, explain, config, detail=None):
    vector = dict(config)
    vector["status"] = "fallback"
    vector["fallback"] = "text"
    vector["source"] = "text"
    if detail:
        vector["detail"] = detail
    results = search_graph(
        resolver,
        text,
        k=k,
        type_filters=type_filters,
        path_filters=path_filters,
        edge_filters=edge_filters,
        snippet_chars=snippet_chars,
        explain=explain,
    )
    return 0, results, vector


def _vector_result(record, score, config, source, snippet_chars, explain, edge_filters, query_text):
    result = {
        "id": record["id"],
        "type": record["type"],
        "path": record["path"],
        "title": record["title"],
        "score": round(score, 6),
        "reason": f"{source} typed vector match via {config['provider']}",
        "provider": config["provider"],
        "source": source,
    }
    snippet = _best_snippet(record, query_text, _query_terms(query_text), snippet_chars)
    if snippet:
        result["snippet"] = snippet
    if explain:
        result["reasons"] = [
            f"{source} typed vector match",
            f"provider: {config['provider']}",
            f"dimensions: {config.get('dimensions', _DEFAULT_VECTOR_DIMENSIONS)}",
        ]
    if explain or edge_filters:
        result["edges"] = _typed_result_edges(record)
    return result


def _computed_vector_query(resolver, text, *, k, type_filters, path_filters, edge_filters,
                           snippet_chars, explain, config):
    dimensions = config.get("dimensions", _DEFAULT_VECTOR_DIMENSIONS)
    query_vector = _local_hash_vector(text, dimensions)
    vector = dict(config)
    vector.update({
        "source": "computed",
        "index": "file-graph",
        "embedding_version": _LOCAL_VECTOR_VERSION,
    })
    if not any(query_vector):
        vector["matched"] = 0
        return 0, [], vector

    docs = analyze(resolver.root, [], resolver)
    nodes, edges = build_graph(docs)
    records = _build_search_records(docs, nodes, edges, body_limit=_VECTOR_CONTENT_CHARS)
    type_filters = type_filters or []
    path_filters = path_filters or []
    edge_filters = edge_filters or []
    results = []

    for record in records:
        if not _passes_search_filters(record, type_filters, path_filters, edge_filters):
            continue
        record_vector = _local_hash_vector(_record_vector_text(record), dimensions)
        score = _cosine_score(query_vector, record_vector)
        if score <= 0:
            continue
        results.append(_vector_result(
            record,
            score,
            config,
            "computed",
            snippet_chars,
            explain,
            edge_filters,
            text,
        ))

    results.sort(key=lambda r: (-r["score"], r["path"], r["id"]))
    results = results[:max(0, k)]
    vector["indexed"] = len(records)
    vector["matched"] = len(results)
    return 0, results, vector


def _redact_workspace_detail(detail, root):
    detail = str(detail or "")
    root_abs = os.path.abspath(root)
    root_real = os.path.realpath(root)
    replacements = {
        root_abs,
        root_real,
        root,
        "\\\\?\\" + root_abs,
        "\\\\?\\" + root_real,
    }
    for value in sorted((v for v in replacements if v), key=len, reverse=True):
        for variant in {value, value.replace("\\", "/")}:
            detail = re.sub(re.escape(variant), "<workspace>", detail, flags=re.IGNORECASE)
    return detail


def _storage_backend_is_embedded(root):
    try:
        storage = _load_storage_config(root)
    except ConfigError as e:
        return False, str(e)
    backend = storage.get("backend", "file")
    return backend in ("embedded", "auto"), ""


def _stored_vector_fallback(resolver, text, k, type_filters, path_filters, edge_filters,
                            snippet_chars, explain, config, detail):
    return _text_vector_fallback(
        resolver,
        text,
        k,
        type_filters,
        path_filters,
        edge_filters,
        snippet_chars,
        explain,
        config,
        detail,
    )


def _vector_candidate_limit(k, row_count, filters_present):
    requested = max(0, k)
    if requested == 0 or row_count <= 0:
        return 0
    if filters_present:
        requested = max(
            requested * _VECTOR_QUERY_FILTER_OVERFETCH,
            requested + 20,
            50,
        )
    return min(row_count, requested, _VECTOR_QUERY_MAX_CANDIDATES)


def _stored_vector_query(resolver, text, *, k, type_filters, path_filters, edge_filters,
                         snippet_chars, explain, config):
    try:
        backend = get_backend(resolver.root, allow_auto_fallback=False)
    except ConfigError as e:
        detail = _redact_workspace_detail(e, resolver.root)
        return _stored_vector_fallback(
            resolver,
            text,
            k,
            type_filters,
            path_filters,
            edge_filters,
            snippet_chars,
            explain,
            config,
            f"embedded vector index unavailable: {detail}",
        )
    except Exception as e:
        detail = _redact_workspace_detail(e, resolver.root) or e.__class__.__name__
        return _stored_vector_fallback(
            resolver,
            text,
            k,
            type_filters,
            path_filters,
            edge_filters,
            snippet_chars,
            explain,
            config,
            f"embedded vector index unavailable: {detail}",
        )

    try:
        if not hasattr(backend, "count_nodes") or not hasattr(backend, "node_metadata"):
            return _stored_vector_fallback(
                resolver,
                text,
                k,
                type_filters,
                path_filters,
                edge_filters,
                snippet_chars,
                explain,
                config,
                "embedded backend does not expose stored node metadata",
            )

        try:
            row_count = backend.count_nodes()
        except Exception as e:
            detail = _redact_workspace_detail(e, resolver.root) or e.__class__.__name__
            return _stored_vector_fallback(
                resolver,
                text,
                k,
                type_filters,
                path_filters,
                edge_filters,
                snippet_chars,
                explain,
                config,
                f"embedded vector index row count could not be read: {detail}",
            )

        docs = analyze(resolver.root, [], resolver)
        docs_by_id = {
            d.derived.get("id"): d
            for d in docs
            if d.derived.get("id") is not None
        }
        nodes, edges = build_graph(docs)
        records = _build_search_records(docs, nodes, edges, body_limit=_VECTOR_CONTENT_CHARS)
        records_by_id = {record["id"]: record for record in records}
        if not records_by_id:
            if row_count == 0:
                vector = dict(config)
                vector.update({
                    "source": "stored",
                    "index": "embedded",
                    "embedding_version": _LOCAL_VECTOR_VERSION,
                    "indexed": 0,
                    "matched": 0,
                })
                return 0, [], vector
            return _stored_vector_fallback(
                resolver,
                text,
                k,
                type_filters,
                path_filters,
                edge_filters,
                snippet_chars,
                explain,
                config,
                f"embedded vector index is stale; contains {row_count} deleted node(s)",
            )
        if row_count == 0:
            return _stored_vector_fallback(
                resolver,
                text,
                k,
                type_filters,
                path_filters,
                edge_filters,
                snippet_chars,
                explain,
                config,
                "embedded vector index is empty; run tropo migrate --from file --to embedded --yes",
            )
        if row_count > _VECTOR_QUERY_MAX_VALIDATE_ROWS:
            return _stored_vector_fallback(
                resolver,
                text,
                k,
                type_filters,
                path_filters,
                edge_filters,
                snippet_chars,
                explain,
                config,
                f"embedded vector index has {row_count} row(s), above the conservative validation cap",
            )

        current_count = len(records_by_id)
        if row_count != current_count:
            detail = "embedded vector index is stale"
            if row_count < current_count:
                detail += f"; missing {current_count - row_count} current node(s)"
            if row_count > current_count:
                detail += f"; contains {row_count - current_count} deleted node(s)"
            return _stored_vector_fallback(
                resolver,
                text,
                k,
                type_filters,
                path_filters,
                edge_filters,
                snippet_chars,
                explain,
                config,
                detail,
            )

        try:
            metadata_rows = backend.node_metadata(limit=row_count + 1)
        except Exception as e:
            detail = _redact_workspace_detail(e, resolver.root) or e.__class__.__name__
            return _stored_vector_fallback(
                resolver,
                text,
                k,
                type_filters,
                path_filters,
                edge_filters,
                snippet_chars,
                explain,
                config,
                f"embedded vector index metadata could not be read: {detail}",
            )
        if len(metadata_rows) != row_count:
            return _stored_vector_fallback(
                resolver,
                text,
                k,
                type_filters,
                path_filters,
                edge_filters,
                snippet_chars,
                explain,
                config,
                "embedded vector index metadata row count does not match the table row count",
            )

        rows_by_id = {}
        malformed_rows = 0
        for row in metadata_rows:
            node_id = str(row.get("id") or "")
            if not node_id or node_id in rows_by_id:
                malformed_rows += 1
                continue
            rows_by_id[node_id] = row
        if malformed_rows:
            return _stored_vector_fallback(
                resolver,
                text,
                k,
                type_filters,
                path_filters,
                edge_filters,
                snippet_chars,
                explain,
                config,
                "embedded vector index contains malformed or duplicate node rows",
            )

        current_ids = set(records_by_id)
        stored_ids = set(rows_by_id)
        missing = sorted(current_ids - stored_ids)
        extra = sorted(stored_ids - current_ids)
        if missing or extra:
            detail = "embedded vector index is stale"
            if missing:
                detail += f"; missing {len(missing)} current node(s)"
            if extra:
                detail += f"; contains {len(extra)} deleted node(s)"
            return _stored_vector_fallback(
                resolver,
                text,
                k,
                type_filters,
                path_filters,
                edge_filters,
                snippet_chars,
                explain,
                config,
                detail,
            )

        dimensions = config.get("dimensions", _DEFAULT_VECTOR_DIMENSIONS)
        for node_id, record in records_by_id.items():
            row = rows_by_id[node_id]
            expected_metadata = {
                "embedding_provider": config["provider"],
                "embedding_dimensions": dimensions,
                "embedding_version": _LOCAL_VECTOR_VERSION,
                "embedding_scope": "typed-node",
                "source_fingerprint": _source_fingerprint(docs_by_id.get(node_id), record),
                "embedding_text_fingerprint": _sha256_text(_record_vector_text(record)),
            }
            for key, expected in expected_metadata.items():
                if row.get(key) != expected:
                    return _stored_vector_fallback(
                        resolver,
                        text,
                        k,
                        type_filters,
                        path_filters,
                        edge_filters,
                        snippet_chars,
                        explain,
                        config,
                        f"stored vector for {node_id!r} has stale {key}",
                    )

        query_vector = _local_hash_vector(text, dimensions)
        vector_status = dict(config)
        vector_status.update({
            "source": "stored",
            "index": "embedded",
            "embedding_version": _LOCAL_VECTOR_VERSION,
            "indexed": len(rows_by_id),
        })
        if not any(query_vector):
            vector_status["matched"] = 0
            return 0, [], vector_status

        filters_present = bool(type_filters or path_filters or edge_filters)
        candidate_limit = _vector_candidate_limit(k, row_count, filters_present)
        try:
            ranked_rows = backend.vector_query(query_vector, k=candidate_limit)
        except Exception as e:
            detail = _redact_workspace_detail(e, resolver.root) or e.__class__.__name__
            return _stored_vector_fallback(
                resolver,
                text,
                k,
                type_filters,
                path_filters,
                edge_filters,
                snippet_chars,
                explain,
                config,
                f"embedded vector backend search failed: {detail}",
            )
        ranked_ids = []
        seen = set()
        vectors_by_id = {}
        for row in ranked_rows:
            node_id = str(row.get("id") or "")
            if not node_id or node_id not in rows_by_id:
                return _stored_vector_fallback(
                    resolver,
                    text,
                    k,
                    type_filters,
                    path_filters,
                    edge_filters,
                    snippet_chars,
                    explain,
                    config,
                    "embedded vector backend returned an unknown node candidate",
                )
            if node_id in seen:
                continue
            vector = _coerce_vector(row.get("vector"))
            if vector is None or len(vector) != dimensions:
                return _stored_vector_fallback(
                    resolver,
                    text,
                    k,
                    type_filters,
                    path_filters,
                    edge_filters,
                    snippet_chars,
                    explain,
                    config,
                    f"stored vector for {node_id!r} is missing, non-finite, or has the wrong dimensions",
                )
            ranked_ids.append(node_id)
            vectors_by_id[node_id] = vector
            seen.add(node_id)

        type_filters = type_filters or []
        path_filters = path_filters or []
        edge_filters = edge_filters or []
        results = []
        for node_id in ranked_ids:
            record = records_by_id[node_id]
            if not _passes_search_filters(record, type_filters, path_filters, edge_filters):
                continue
            score = _cosine_score(query_vector, vectors_by_id[node_id])
            if score <= 0:
                continue
            results.append(_vector_result(
                record,
                score,
                config,
                "stored",
                snippet_chars,
                explain,
                edge_filters,
                text,
            ))

        results.sort(key=lambda r: (-r["score"], r["path"], r["id"]))
        results = results[:max(0, k)]
        vector_status["matched"] = len(results)
        vector_status["candidate_limit"] = candidate_limit
        vector_status["candidates"] = len(ranked_rows)
        return 0, results, vector_status
    finally:
        close = getattr(backend, "close", None)
        if callable(close):
            close()


def vector_query(resolver, text, *, k=10, type_filters=None, path_filters=None,
                 edge_filters=None, snippet_chars=_DEFAULT_SNIPPET_CHARS,
                 explain=False):
    """Typed vector search with stored embedded rows when they are current."""
    config = _load_vector_query_config(resolver.root)
    if config["status"] == "fallback":
        return _text_vector_fallback(
            resolver,
            text,
            k,
            type_filters,
            path_filters,
            edge_filters,
            snippet_chars,
            explain,
            config,
            config.get("detail"),
        )
    if config["status"] != "ok":
        return 1, [], config

    embedded, detail = _storage_backend_is_embedded(resolver.root)
    if embedded:
        return _stored_vector_query(
            resolver,
            text,
            k=k,
            type_filters=type_filters,
            path_filters=path_filters,
            edge_filters=edge_filters,
            snippet_chars=snippet_chars,
            explain=explain,
            config=config,
        )
    if detail:
        return _stored_vector_fallback(
            resolver,
            text,
            k,
            type_filters,
            path_filters,
            edge_filters,
            snippet_chars,
            explain,
            config,
            detail,
        )
    return _computed_vector_query(
        resolver,
        text,
        k=k,
        type_filters=type_filters,
        path_filters=path_filters,
        edge_filters=edge_filters,
        snippet_chars=snippet_chars,
        explain=explain,
        config=config,
    )


def _estimate_tokens(value):
    text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    return max(0, math.ceil(len(text) / 4))


def _context_results(query_results):
    context = []
    for result in query_results:
        reasons = result.get("reasons") or []
        reason = "; ".join(reasons) if reasons else "matches the task query"
        item = {
            "id": result["id"],
            "type": result["type"],
            "path": result["path"],
            "reason": reason,
        }
        if result.get("snippet"):
            item["snippet"] = result["snippet"]
        if result.get("edges"):
            item["edges"] = result["edges"]
        context.append(item)
    return context


def _trim_context_to_budget(results, budget):
    if budget is None or budget <= 0:
        return results, _estimate_tokens(results)
    trimmed = [dict(r) for r in results]
    while _estimate_tokens(trimmed) > budget and any("snippet" in r for r in trimmed):
        for r in trimmed:
            if "snippet" not in r:
                continue
            snippet = r["snippet"]
            if len(snippet) <= 80:
                r.pop("snippet", None)
            else:
                r["snippet"] = snippet[:max(40, len(snippet) // 2)].rstrip()
    while _estimate_tokens(trimmed) > budget and any("edges" in r for r in trimmed):
        for r in trimmed:
            r.pop("edges", None)
    while _estimate_tokens(trimmed) > budget and len(trimmed) > 1:
        trimmed.pop()
    for r in trimmed:
        if not isinstance(r.get("reason"), str):
            continue
        if _estimate_tokens(trimmed) > budget and ";" in r["reason"]:
            r["reason"] = r["reason"].split(";", 1)[0]
        if _estimate_tokens(trimmed) > budget and len(r["reason"]) > 24:
            r["reason"] = "query match"
        elif len(r["reason"]) > 80:
            r["reason"] = r["reason"][:77].rstrip() + "..."
    return trimmed, _estimate_tokens(trimmed)


def _load_cognee_adapter_from_path(path):
    module_name = "_vivary_cognee_adapter"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError("cannot load vivary-memory-cognee adapter")
    module = importlib.util.module_from_spec(spec)
    previous = sys.modules.get(module_name)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        if previous is None:
            sys.modules.pop(module_name, None)
        else:
            sys.modules[module_name] = previous
        raise
    return module


def _adapter_origin_is_unsafe(origin, workspace_root, allowed_source):
    if not origin:
        return True
    origin_real = os.path.realpath(origin)
    allowed_real = os.path.realpath(allowed_source)
    if origin_real == allowed_real:
        return False
    install_roots = {
        os.path.realpath(path)
        for key, path in sysconfig.get_paths().items()
        if key in {"purelib", "platlib"} and path
    }
    untrusted_roots = [os.path.realpath(workspace_root), os.path.realpath(os.getcwd())]
    if any(_is_within(root, origin_real) for root in install_roots) and not any(
        _is_within(root, origin_real) for root in untrusted_roots
    ):
        return False
    return any(_is_within(root, origin_real) for root in untrusted_roots)


def _version_tuple(value):
    parts = []
    for part in str(value or "").split("."):
        match = re.match(r"(\d+)", part)
        if not match:
            break
        parts.append(int(match.group(1)))
    return tuple(parts)


def _validate_cognee_adapter(module):
    try:
        adapter_api = int(getattr(module, "TROPO_SEMANTIC_ADAPTER_API", 0))
    except (TypeError, ValueError):
        raise ImportError("vivary-memory-cognee adapter is too old for semantic query")
    if adapter_api < 1:
        raise ImportError("vivary-memory-cognee adapter is too old for semantic query")
    if getattr(module, "REQUIRES_EXPLICIT_PROVIDER_GATES", None) is not True:
        raise ImportError("vivary-memory-cognee adapter lacks provider safety gates")
    if _version_tuple(getattr(module, "__version__", "")) < (0, 1, 1):
        raise ImportError("vivary-memory-cognee 0.1.1 or newer is required")
    if not callable(getattr(module, "CogneeMemoryAdapter", None)):
        raise ImportError("vivary-memory-cognee adapter is missing CogneeMemoryAdapter")
    return module


def _import_optional_cognee_adapter(workspace_root):
    package_file = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "memory-cognee", "vivary_cognee.py")
    )
    existing = sys.modules.get("vivary_cognee")
    if existing is not None:
        origin = getattr(existing, "__file__", None)
        if _adapter_origin_is_unsafe(origin, workspace_root, package_file):
            raise ImportError("refusing workspace-local vivary_cognee adapter")
        return _validate_cognee_adapter(existing)
    if os.path.isfile(package_file):
        return _validate_cognee_adapter(_load_cognee_adapter_from_path(package_file))
    spec = importlib.util.find_spec("vivary_cognee")
    if spec is None or spec.origin is None:
        raise ImportError("vivary-memory-cognee is not installed")
    if _adapter_origin_is_unsafe(spec.origin, workspace_root, package_file):
        raise ImportError("refusing workspace-local vivary_cognee adapter")
    return _validate_cognee_adapter(importlib.import_module("vivary_cognee"))


def _hit_value(hit, name, default=None):
    if isinstance(hit, dict):
        return hit.get(name, default)
    return getattr(hit, name, default)


def _semantic_edge_context(hit):
    edges = _hit_value(hit, "edge_context", []) or []
    out = []
    for edge in edges:
        if isinstance(edge, dict):
            source = edge.get("source_id")
            field = edge.get("field")
            target = edge.get("target_id")
        else:
            source = getattr(edge, "source_id", None)
            field = getattr(edge, "field", None)
            target = getattr(edge, "target_id", None)
        if source is not None and field is not None and target is not None:
            out.append({"from": source, "field": field, "to": target})
    return out


def semantic_query(resolver, text, *, k=10, type_filters=None, path_filters=None,
                   edge_filters=None):
    """Search through an explicitly configured optional semantic-memory provider."""
    config = _load_memory_query_config(resolver.root)
    provider = config.get("provider", "none")
    if config["status"] != "configured":
        return 1, [], config
    if provider != "cognee":
        return 1, [], {
            "enabled": True,
            "provider": provider,
            "status": "unsupported",
            "detail": f"semantic query provider {provider!r} is not supported by tropo",
        }
    try:
        vivary_cognee = _import_optional_cognee_adapter(resolver.root)
    except ImportError:
        return 1, [], {
            "enabled": True,
            "provider": "cognee",
            "status": "unavailable",
            "detail": "install vivary-memory-cognee and index the workspace before semantic query",
        }

    type_filters = type_filters or []
    path_filters = path_filters or []
    edge_filters = edge_filters or []
    filters_present = bool(type_filters or path_filters or edge_filters)
    requested_k = max(0, k)
    if requested_k == 0:
        return 0, [], {
            "enabled": True,
            "provider": "cognee",
            "status": "ok",
            "detail": "",
        }
    provider_k = min(
        requested_k if not filters_present else max(requested_k * 5, requested_k + 20, 50),
        250,
    )
    try:
        hits = asyncio.run(
            vivary_cognee.CogneeMemoryAdapter(resolver.root).recall(text, k=provider_k)
        )
    except Exception as e:
        policy_detail = ""
        if config.get("_allow_network") is False:
            policy_detail = (
                "; workspace policy: memory.cognee.allow_network is false "
                "(default deny)"
            )
        return 1, [], {
            "enabled": True,
            "provider": "cognee",
            "status": "unavailable",
            "detail": (
                "semantic-memory provider query failed "
                f"({e.__class__.__name__}){policy_detail}"
            ),
        }
    results = []
    for hit in hits:
        result = {
            "id": _hit_value(hit, "node_id", ""),
            "type": _hit_value(hit, "type"),
            "path": _hit_value(hit, "path", ""),
            "score": _hit_value(hit, "score", 0),
            "reason": _hit_value(hit, "reason", "semantic provider match"),
            "provider": _hit_value(hit, "provider", provider),
        }
        edges = _semantic_edge_context(hit)
        if edges:
            result["edges"] = edges
        if not _passes_search_filters(result, type_filters, path_filters, edge_filters):
            continue
        results.append(result)
    return 0, results[:max(0, k)], {
        "enabled": True,
        "provider": "cognee",
        "status": "ok",
        "detail": "",
    }


# ---------------------------------------------------------------------------
# Filesystem map: read-only inventory of a large tree (no tropo.toml required)
# ---------------------------------------------------------------------------

MAP_DEFAULT_DEPTH = 3
MAP_SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv",
    "dist", "build", ".astro", ".next", "target",
}
MAP_INDEX_NAMES = ("index.md", "readme.md")
_MAP_TOP_EXTENSIONS = 10
_MAP_LARGEST_FILES = 10


def _map_skip_patterns(root):
    """Fixed skip list, plus the workspace's own tropo.toml `exclude` patterns
    (the same `Config.exclude`/`is_excluded` mechanism `check`/`graph` use) when
    a config happens to be found walking up from `root`. A missing or broken
    config never blocks the (read-only) map.

    Config excludes are anchored at the *config* root, but map paths are
    relative to the *map* root — when mapping a subtree, path-anchored patterns
    are rebased onto the map root (prefix dropped; patterns that cannot apply
    under the subtree are discarded). Bare-name patterns match any level and
    pass through unchanged."""
    patterns = set(MAP_SKIP_DIRS)
    root_abs = os.path.abspath(root)
    cfg_root = find_root(root_abs)
    if cfg_root:
        try:
            config = load_config(cfg_root, os.path.dirname(os.path.abspath(__file__)))
        except ConfigError:
            config = None
        if config is not None:
            rel = os.path.relpath(root_abs, cfg_root).replace("\\", "/")
            prefix = "" if rel in (".", "") else rel + "/"
            for pat in config.exclude:
                p = pat.replace("\\", "/").rstrip("/")
                if not p:
                    continue
                if "/" not in p or not prefix:
                    patterns.add(p)  # bare name (any level) or map root == config root
                elif p.startswith(prefix):
                    rebased = p[len(prefix):]
                    if rebased:
                        patterns.add(rebased)
                # else: anchored outside this subtree — cannot match, drop it
    return sorted(patterns)


def _map_is_index(filename):
    return filename.lower() in MAP_INDEX_NAMES


def _is_link_or_reparse(path):
    try:
        st = os.lstat(path)
    except OSError:
        return False
    if stat.S_ISLNK(st.st_mode):
        return True
    attrs = getattr(st, "st_file_attributes", 0)
    return bool(attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def _map_walk(root, skip_patterns):
    """Walk the full tree from `root` (no depth limit — aggregate counts need
    the whole tree). Reuses `is_excluded` so skip semantics match `check`/`graph`
    (dotted dir-name patterns and path-anchored patterns both work). Directories
    whose *real* path was already visited, or whose real path resolves outside
    `root`, are pruned before recursing — so NTFS junctions and symlink cycles
    never loop, double-count, or leak outside-root content into the inventory
    (os.walk's followlinks=False alone does not stop junctions — Windows does
    not classify them as symlinks). Files that are themselves links/reparse
    points, or whose real path resolves outside `root`, are skipped for that same
    reason: each is an alternate route to content the walk may already have counted.
    Hard-linked files are *not* skipped — a hard link is an ordinary directory entry,
    not an alternate route the walk can arrive at twice, so omitting them only
    undercounted the tree. Consequently `map` counts paths and sums per-path sizes;
    it does not report disk usage, and two hard links to one inode count twice.
    Yields (dirpath, reldir, dirnames, filenames) with dirnames/filenames pruned in
    place."""
    root_abs = os.path.abspath(root)
    root_real = os.path.normcase(os.path.realpath(root_abs))
    seen = set()
    for dirpath, dirnames, filenames in os.walk(root_abs):
        real = os.path.normcase(os.path.realpath(dirpath))
        if not _realpath_within(root_real, dirpath) or real in seen:
            dirnames[:] = []  # outside root or already inventoried under its real path
            continue
        seen.add(real)
        reldir = os.path.relpath(dirpath, root_abs)
        reldir = "" if reldir == "." else reldir.replace("\\", "/")
        keep_dirs = []
        for d in sorted(dirnames):
            rel_child = f"{reldir}/{d}" if reldir else d
            full_child = os.path.join(dirpath, d)
            if _is_link_or_reparse(full_child):
                continue
            if is_excluded(rel_child, skip_patterns):
                continue
            if not _realpath_within(root_real, full_child):
                continue
            real_child = os.path.normcase(os.path.realpath(full_child))
            if real_child in seen:
                continue
            keep_dirs.append(d)
        dirnames[:] = keep_dirs
        keep_files = []
        for f in sorted(filenames):
            rel_file = f"{reldir}/{f}" if reldir else f
            if is_excluded(rel_file, skip_patterns):
                continue
            full_file = os.path.join(dirpath, f)
            if _is_link_or_reparse(full_file):
                continue
            if not _realpath_within(root_real, full_file):
                continue
            keep_files.append(f)
        filenames[:] = keep_files
        yield dirpath, reldir, dirnames, filenames


def build_filesystem_map(root, skip_patterns):
    """Inventory `root`: per-directory stats plus a repo-level summary. Depth is
    applied only when rendering the table — counts here always cover the full
    (non-skipped) tree. Read-only: only os.walk/os.stat are used. Returns a dict
    with stable, sortable structures so callers can slice by depth and render
    deterministically."""
    root = os.path.abspath(root)
    # reldir ("" = root) -> own (non-recursive) {files, size, ext_counts, has_index}
    own = {}
    ext_counts = Counter()
    all_files = []  # (relpath, size)
    index_files = []
    total_files = 0
    total_dirs = 0

    for dirpath, reldir, dirnames, filenames in _map_walk(root, skip_patterns):
        total_dirs += 1
        entry = own.setdefault(
            reldir, {"files": 0, "size": 0, "ext_counts": Counter(), "has_index": False})
        for fname in filenames:
            rel = f"{reldir}/{fname}" if reldir else fname
            if is_excluded(rel, skip_patterns):
                continue  # file-level excludes count for files, not just dirs
            full = os.path.join(dirpath, fname)
            try:
                size = os.path.getsize(full)
            except OSError:
                size = 0
            ext = os.path.splitext(fname)[1].lower() or "(none)"

            total_files += 1
            ext_counts[ext] += 1
            all_files.append((rel, size))

            entry["files"] += 1
            entry["size"] += size
            entry["ext_counts"][ext] += 1
            if _map_is_index(fname):
                entry["has_index"] = True
                index_files.append(rel)

    # os.walk visits every non-skipped directory, so `own` already has one entry
    # per directory in the tree (including empty ones). Roll each directory's
    # own counts up into every ancestor to get recursive totals, deepest first
    # so a parent only ever sums already-finalized child totals.
    recursive = {d: {"files": v["files"], "size": v["size"],
                     "ext_counts": Counter(v["ext_counts"]), "has_index": v["has_index"]}
                for d, v in own.items()}
    deepest_first = sorted(own, key=lambda d: (-(d.count("/") + 1) if d else 0, d))
    for d in deepest_first:
        if d == "":
            continue
        parent = "/".join(d.split("/")[:-1])
        recursive[parent]["files"] += recursive[d]["files"]
        recursive[parent]["size"] += recursive[d]["size"]
        recursive[parent]["ext_counts"].update(recursive[d]["ext_counts"])

    ext_top = sorted(ext_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:_MAP_TOP_EXTENSIONS]
    largest = sorted(all_files, key=lambda fs: (-fs[1], fs[0]))[:_MAP_LARGEST_FILES]
    index_files.sort()

    likely_modules_without_index = []
    for d, entry in recursive.items():
        if d == "":
            continue
        depth = d.count("/") + 1
        if depth not in (1, 2):
            continue
        if entry["files"] >= 5 and not own[d]["has_index"]:
            likely_modules_without_index.append(d)
    likely_modules_without_index.sort()

    return {
        "root": root,
        "total_files": total_files,
        "total_dirs": total_dirs,
        "extensions_top": ext_top,
        "largest_files": largest,
        "index_files": index_files,
        "likely_modules_without_index": likely_modules_without_index,
        "dir_stats": recursive,      # reldir -> recursive {files, size, ext_counts, has_index}
        "skip_patterns": skip_patterns,
    }


def _map_directory_rows(map_data, depth):
    """Directory rows for the table, limited to `depth` (root = depth 0)."""
    rows = []
    for d, entry in map_data["dir_stats"].items():
        if d == "":
            d_depth, label = 0, "."
        else:
            d_depth, label = d.count("/") + 1, d
        if d_depth > depth:
            continue
        dom_ext = sorted(entry["ext_counts"].items(), key=lambda kv: (-kv[1], kv[0]))[:3]
        rows.append({
            "path": label,
            "depth": d_depth,
            "files": entry["files"],
            "size": entry["size"],
            "dominant_extensions": dom_ext,
            "has_index": entry["has_index"],
        })
    rows.sort(key=lambda r: (r["depth"], r["path"]))
    return rows


def _human_size(n):
    size = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.0f}{unit}" if unit == "B" else f"{size:.1f}{unit}"
        size /= 1024
    return f"{size:.1f}TB"


def _map_root_label(root):
    """Shareable label for the mapped root: its basename only. Every other path
    in the map is root-relative; the absolute local path (which may contain a
    username) must not leak into output that is pitched as safe to share."""
    root = os.path.abspath(root)
    return os.path.basename(root) or root.replace("\\", "/").rstrip("/") or "/"


def _md_cell(s):
    """Escape a value for a Markdown table cell: a literal '|' would split the
    cell and a newline would break the row (POSIX filenames may contain both).
    JSON output needs no such escaping — json.dumps already handles it."""
    return str(s).replace("\r", " ").replace("\n", " ").replace("|", "\\|")


def render_map_json(map_data, depth, max_entries=None):
    rows = _map_directory_rows(map_data, depth)
    if max_entries is not None and max_entries >= 0:
        rows = rows[:max_entries]
    return {
        "root": _map_root_label(map_data["root"]),
        "depth": depth,
        "summary": {
            "total_files": map_data["total_files"],
            "total_dirs": map_data["total_dirs"],
            "extensions_top": [{"extension": ext, "count": c}
                               for ext, c in map_data["extensions_top"]],
            "largest_files": [{"path": p, "size": s} for p, s in map_data["largest_files"]],
            "index_files": map_data["index_files"],
            "likely_modules_without_index": map_data["likely_modules_without_index"],
        },
        "directories": [
            {
                "path": r["path"],
                "depth": r["depth"],
                "files": r["files"],
                "size": r["size"],
                "dominant_extensions": [{"extension": ext, "count": c}
                                        for ext, c in r["dominant_extensions"]],
                "has_index": r["has_index"],
            }
            for r in rows
        ],
        "skip_patterns": map_data["skip_patterns"],
    }


def render_map_markdown(map_data, depth, max_entries=None):
    rows = _map_directory_rows(map_data, depth)
    if max_entries is not None and max_entries >= 0:
        rows = rows[:max_entries]

    lines = [f"# tropo map: {_md_cell(_map_root_label(map_data['root']))}", ""]
    lines.append(
        f"{map_data['total_files']} file(s), {map_data['total_dirs']} "
        f"director(y/ies), depth ≤ {depth}"
    )
    lines.append("")

    lines.append("## Directories")
    lines.append("")
    lines.append("| Path | Depth | Files | Size | Dominant extensions | Index? |")
    lines.append("|---|---|---|---|---|---|")
    for r in rows:
        dom = ", ".join(f"{_md_cell(ext)} ({c})" for ext, c in r["dominant_extensions"]) or "-"
        lines.append(
            f"| {_md_cell(r['path'])} | {r['depth']} | {r['files']} | {_human_size(r['size'])} "
            f"| {dom} | {'yes' if r['has_index'] else 'no'} |"
        )
    lines.append("")

    lines.append("## File extensions (top 10)")
    lines.append("")
    if map_data["extensions_top"]:
        for ext, c in map_data["extensions_top"]:
            lines.append(f"- `{_md_cell(ext)}`: {c}")
    else:
        lines.append("- (none)")
    lines.append("")

    lines.append("## Largest files (top 10)")
    lines.append("")
    if map_data["largest_files"]:
        for p, s in map_data["largest_files"]:
            lines.append(f"- {_md_cell(p)} — {_human_size(s)}")
    else:
        lines.append("- (none)")
    lines.append("")

    lines.append("## Existing index/routing files")
    lines.append("")
    if map_data["index_files"]:
        for p in map_data["index_files"]:
            lines.append(f"- {_md_cell(p)}")
    else:
        lines.append("- (none found)")
    lines.append("")

    lines.append("## Likely modules without an index")
    lines.append("")
    lines.append(
        "Directories at depth 1-2 with >= 5 files (recursive) and no "
        "`index.md`/`README.md`:"
    )
    lines.append("")
    if map_data["likely_modules_without_index"]:
        for d in map_data["likely_modules_without_index"]:
            lines.append(f"- {_md_cell(d)}")
    else:
        lines.append("- (none)")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_map(args):
    """Read-only filesystem inventory — no tropo.toml required. Understand a
    large repo, vault, docs tree, or file system without opening hundreds of
    files: directory table (up to --depth), extension/size summary, existing
    index files, and likely module folders missing an index.md/README.md."""
    paths = getattr(args, "paths", None) or []
    if len(paths) > 1:
        sys.exit("tropo: map takes at most one path (the tree to inventory)")
    if paths and args.root:
        sys.exit("tropo: map: give either a positional path or --root, not both")
    root = os.path.abspath(paths[0] if paths else (args.root or os.getcwd()))
    if not os.path.isdir(root):
        sys.exit(f"tropo: map root is not a directory: {root}")
    depth = MAP_DEFAULT_DEPTH if args.depth is None else args.depth
    max_entries = getattr(args, "max_entries", None)

    skip_patterns = _map_skip_patterns(root)
    map_data = build_filesystem_map(root, skip_patterns)

    if args.json:
        print(json.dumps(render_map_json(map_data, depth, max_entries),
                         indent=2, sort_keys=True))
    else:
        print(render_map_markdown(map_data, depth, max_entries))
    return 0


def cmd_check(args, resolver):
    docs = analyze(resolver.root, args.paths, resolver)
    findings = [f for d in docs for f in d.findings]
    # Opinionated by default: warnings fail the check. `strict` is on unless the
    # config sets `strict = false` or `--lenient` is passed; `--strict` forces it
    # back on (and overrides a lenient config).
    strict = resolver.base.strict
    if args.strict:
        strict = True
    if getattr(args, "lenient", False):
        strict = False
    noisy = any(f.code == "W210" for f in findings)
    if strict:
        for f in findings:
            if f.level == "warning":
                f.level = "error"
    errors = [f for f in findings if f.level == "error"]
    warnings = [f for f in findings if f.level == "warning"]

    if args.json:
        print(json.dumps({
            "checked": len(docs),
            "clean": sum(1 for d in docs if not d.findings),
            "errors": len(errors),
            "warnings": len(warnings),
            "findings": [f.as_dict() for f in findings],
        }, indent=2))
    else:
        for f in sorted(findings, key=lambda x: (x.path, x.line)):
            if args.quiet and f.code.startswith("W"):
                continue
            print(f.render())
        print(f"\ntropo: {len(docs)} document(s), "
              f"{len(errors)} error(s), {len(warnings)} warning(s)")
        if noisy:
            print("hint: redundant frontmatter detected — run `tropo fix` to remove it")
    return 1 if errors else 0


def cmd_signal(args, resolver):
    docs = analyze(resolver.root, args.paths, resolver)
    if args.json:
        print(json.dumps([
            {"path": d.rel.replace("\\", "/"), "type": d.type, "signal": d.declared}
            for d in docs], indent=2))
        return 0
    for d in sorted(docs, key=lambda x: x.rel):
        rel = d.rel.replace("\\", "/")
        head = f"{rel}  [{d.type or 'untyped'}]"
        if d.declared:
            print(head)
            for k, v in d.declared.items():
                print(f"    {k}: {v}")
        else:
            print(f"{head}  (no signal — fully derived)")
    return 0


def cmd_types(args, resolver):
    config = resolver.base
    if args.json:
        print(json.dumps({
            "root": config.root,
            "derive": config.derive,
            "base_optional": config.base_optional,
            "types": {n: {"folders": t.get("folders", []),
                          "required": t.get("required", {}),
                          "optional": t.get("optional", {})}
                      for n, t in config.types.items()},
        }, indent=2))
        return 0
    print(f"Config root: {config.root}\n")
    print("Derived (never declared): " + ", ".join(config.derive))
    print("Base optional: " + (", ".join(config.base_optional) or "-"))
    print()
    for name in sorted(config.types):
        t = config.types[name]
        folders = "/".join(t.get("folders", [])) or name
        req = ", ".join(t.get("required", {})) or "-"
        opt = ", ".join(t.get("optional", {})) or "-"
        print(f"  {name}  (folder: {folders})\n    required: {req}\n    optional: {opt}")
    return 0


def cmd_stats(args, resolver):
    config = resolver.base
    docs = analyze(resolver.root, args.paths, resolver)
    by_type = Counter((d.type or "untyped") for d in docs)
    clean = sum(1 for d in docs if not d.findings)
    errored = sum(1 for d in docs if any(f.level == "error" for f in d.findings))
    if args.json:
        print(json.dumps({
            "total": len(docs),
            "by_type": dict(by_type),
            "clean": clean,
            "with_errors": errored,
            "warnings_only": len(docs) - clean - errored,
        }, indent=2))
        return 0
    print(f"{len(docs)} document(s) in the knowledge layer\n")
    width = max((len(t) for t in by_type), default=4)
    for t, c in by_type.most_common():
        mark = "" if t in config.types or t == "untyped" else "   (not in config)"
        print(f"  {t:<{width}}  {c}{mark}")
    print(f"\n  clean: {clean}   with errors: {errored}   "
          f"warnings only: {len(docs) - clean - errored}")
    return 0


def cmd_graph(args, resolver):
    """Emit the typed knowledge graph — documents as nodes, ref/ref-list fields
    as edges. The whole tree is analyzed regardless of path args, since an edge
    may originate anywhere."""
    docs = analyze(resolver.root, [], resolver)
    nodes, edges = build_graph(docs)
    broken = sum(1 for e in edges if e["broken"])
    if args.json:
        print(json.dumps({
            "root": resolver.root,
            "nodes": sorted(nodes.values(), key=lambda n: n["id"]),
            "edges": edges,
            "counts": {"nodes": len(nodes), "edges": len(edges), "broken": broken},
        }, indent=2))
        return 0
    print(f"tropo graph: {len(nodes)} node(s), {len(edges)} edge(s)"
          + (f", {broken} broken" if broken else ""))
    out = {}
    for e in edges:
        out.setdefault(e["from"], []).append(e)
    for nid in sorted(nodes):
        n = nodes[nid]
        print(f"\n  {nid}  [{n['type'] or 'untyped'}]")
        for e in out.get(nid, []):
            print(f"    --{e['field']}--> {e['to']}" + ("  (broken)" if e["broken"] else ""))
    return 0


def cmd_blast(args, resolver):
    """Show a document's blast radius — everything that (transitively) refs it,
    i.e. what a change to it could touch (inbound-edge closure)."""
    if not args.paths:
        sys.exit("tropo: blast requires a document id (tropo blast <id>)")
    target = args.paths[0]
    docs = analyze(resolver.root, [], resolver)
    nodes, edges = build_graph(docs)
    if target not in nodes:
        sys.exit(f"tropo: no document with id {target!r} (run `tropo graph` to list ids)")
    impacted = blast_radius(edges, target, args.depth)
    rows = sorted(impacted.items(), key=lambda kv: (kv[1]["distance"], kv[0]))
    if args.json:
        print(json.dumps({
            "root": resolver.root,
            "target": target,
            "depth": args.depth,
            "impacted": [{"id": nid, "type": nodes[nid]["type"],
                          "distance": info["distance"], "via": info["via"]}
                         for nid, info in rows],
            "counts": {"impacted": len(rows)},
        }, indent=2))
        return 0
    n = nodes[target]
    print(f"tropo blast: {target} [{n['type'] or 'untyped'}] — "
          f"{len(rows)} document(s) depend on it"
          + (f" (depth ≤ {args.depth})" if args.depth is not None else ""))
    for nid, info in rows:
        print(f"  {nid}  [{nodes[nid]['type'] or 'untyped'}]"
              f"   (distance {info['distance']}, via {info['via']})")
    return 0


def _is_within(root, path):
    try:
        return os.path.commonpath([os.path.abspath(root), os.path.abspath(path)]) == os.path.abspath(root)
    except ValueError:
        return False


def _write_workspace_file(root, path, text):
    """Write text only to a regular, non-symlink file inside root."""
    root_real = os.path.realpath(root)
    target_abs = os.path.abspath(path)
    parent_real = os.path.realpath(os.path.dirname(target_abs) or os.curdir)
    if not _is_within(root_real, parent_real):
        raise ConfigError(f"output path must stay inside tropo root: {path}")

    if os.path.lexists(target_abs):
        if os.path.islink(target_abs):
            raise ConfigError(f"output path must not be a symlink: {path}")
        if not os.path.isfile(target_abs):
            raise ConfigError(f"output path must be a regular file: {path}")
        if not _is_within(root_real, os.path.realpath(target_abs)):
            raise ConfigError(f"output path must stay inside tropo root: {path}")

    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{os.path.basename(target_abs)}.",
        suffix=".tropo-tmp",
        dir=os.path.dirname(target_abs) or os.curdir,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        if os.path.lexists(target_abs):
            if os.path.islink(target_abs):
                raise ConfigError(f"output path must not be a symlink: {path}")
            if not os.path.isfile(target_abs):
                raise ConfigError(f"output path must be a regular file: {path}")
            if not _is_within(root_real, os.path.realpath(target_abs)):
                raise ConfigError(f"output path must stay inside tropo root: {path}")
        if not _is_within(root_real, os.path.realpath(os.path.dirname(target_abs) or os.curdir)):
            raise ConfigError(f"output path must stay inside tropo root: {path}")
        os.replace(tmp_name, target_abs)
    except OSError as e:
        raise ConfigError(f"could not write output {path}: {e.strerror}") from e
    finally:
        if os.path.lexists(tmp_name):
            os.unlink(tmp_name)


def cmd_view(args, resolver):
    """Render the graph (or a blast radius) as one self-contained HTML file.
    `tropo view` → whole graph; `tropo view blast <id>` → that node's radius.
    Writes to --out, else prints the HTML to stdout."""
    subject = args.paths[0] if args.paths else "graph"
    docs = analyze(resolver.root, [], resolver)
    nodes, edges = build_graph(docs)

    if subject == "graph":
        title, ranks = "graph", None
        sub_nodes, sub_edges = nodes, edges
    elif subject == "blast":
        if len(args.paths) < 2:
            sys.exit("tropo: view blast requires a document id (tropo view blast <id>)")
        target = args.paths[1]
        if target not in nodes:
            sys.exit(f"tropo: no document with id {target!r} (run `tropo graph` to list ids)")
        impacted = blast_radius(edges, target, args.depth)
        keep = set(impacted) | {target}
        sub_nodes = {nid: nodes[nid] for nid in keep}
        sub_edges = [e for e in edges if e["from"] in keep and e["to"] in keep]
        ranks = {target: 0, **{nid: info["distance"] for nid, info in impacted.items()}}
        title = f"blast · {target}"
    else:
        sys.exit(f"tropo: unknown view subject {subject!r} (use 'graph' or 'blast <id>')")

    html = render_graph_html(title, sub_nodes, sub_edges, ranks)
    if args.out:
        try:
            _write_workspace_file(resolver.root, args.out, html)
        except ConfigError as e:
            sys.exit(f"tropo: {e}")
        print(f"tropo: wrote {args.out}  ({len(sub_nodes)} node(s), {len(sub_edges)} edge(s))")
    else:
        print(html)
    return 0


def cmd_plan(args, resolver):
    """Simulate a proposed change to the graph and render the delta — what gets
    retyped, which edges break or appear, which documents are affected — WITHOUT
    touching disk. The change-spec is a small TOML file (see apply_change).
    Exits 1 if the change would introduce broken edges (a pre-merge signal)."""
    if not args.paths:
        sys.exit("tropo: plan requires a change-spec file (tropo plan <plan.toml>)")
    spec_path = args.paths[0]
    if not os.path.isfile(spec_path):
        sys.exit(f"tropo: change-spec not found: {spec_path}")
    try:
        spec = _read_toml(spec_path)
    except ConfigError as e:
        sys.exit(f"tropo: {e}")

    nodes, edges = build_graph(analyze(resolver.root, [], resolver))
    requested = set(spec.get("remove") or []) | set(spec.get("retype") or {})
    unknown = sorted(t for t in requested if t not in nodes)
    new_nodes, new_edges = apply_change(nodes, edges, spec)
    delta = graph_diff(nodes, edges, new_nodes, new_edges)

    gone = set(delta["nodes_removed"])
    changed = delta["nodes_removed"] + [r["id"] for r in delta["nodes_retyped"]]
    affected = {}
    for nid in changed:
        for dep in blast_radius(edges, nid):
            if dep not in gone:  # a removed doc isn't "affected", it's gone
                affected.setdefault(dep, set()).add(nid)
    broken_added = [e for e in delta["edges_added"] if e["broken"]]
    problems = len(delta["edges_newly_broken"]) + len(broken_added)

    if args.json:
        print(json.dumps({
            "root": resolver.root, "spec": spec_path, "unknown_targets": unknown,
            "delta": delta, "broken_added": broken_added,
            "affected": {k: sorted(v) for k, v in sorted(affected.items())},
            "problems": problems,
        }, indent=2))
        return 1 if problems else 0

    print(f"tropo plan: {spec_path}\n")
    if unknown:
        print(f"  note: spec targets no such id: {', '.join(unknown)}\n")
    for nid in delta["nodes_removed"]:
        print(f"  remove   {nid}")
    for r in delta["nodes_retyped"]:
        print(f"  retype   {r['id']}  ({r['from'] or 'untyped'} → {r['to'] or 'untyped'})")
    for e in delta["edges_removed"]:
        print(f"  edge -   {e['from']} --{e['field']}--> {e['to']}")
    for e in delta["edges_added"]:
        print(f"  edge +   {e['from']} --{e['field']}--> {e['to']}"
              + ("  (broken!)" if e["broken"] else ""))
    for e in delta["edges_newly_broken"]:
        print(f"  BROKEN   {e['from']} --{e['field']}--> {e['to']}   (target gone)")
    if affected:
        print("\n  affected (depend on a changed node):")
        for dep, via in sorted(affected.items()):
            print(f"    {dep}  (via {', '.join(sorted(via))})")
    print(f"\ntropo plan: {problems} broken edge(s) introduced, "
          f"{len(affected)} affected document(s)")
    return 1 if problems else 0


def cmd_fix(args, resolver):
    """Strip frontmatter fields that merely repeat a derived value (W210).
    The only safe mechanical fix tropo makes — it removes noise, never invents
    semantics. If a block becomes empty, the whole block is removed."""
    docs = analyze(resolver.root, args.paths, resolver)
    changes = []
    for d in docs:
        if not d.noise:
            continue
        text = open(d.full, encoding="utf-8", errors="replace").read()
        m, text = _frontmatter_match(text)
        if not m:
            continue
        kept = [ln for ln in m.group(1).split("\n")
                if not any(re.match(rf"\s*{re.escape(k)}\s*:", ln) for k in d.noise)]
        new_fm = "\n".join(kept).strip("\n")
        body = text[m.end():]
        new = ("---\n" + new_fm + "\n---\n" + body) if new_fm.strip() else body.lstrip("\n")
        if not args.dry_run:
            with open(d.full, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(new)
        changes.append((d.rel.replace("\\", "/"), list(d.noise)))

    if args.json:
        print(json.dumps({
            "fixed": len(changes),
            "dry_run": args.dry_run,
            "changes": [{"path": r, "removed": k} for r, k in sorted(changes)],
        }, indent=2))
        return 0

    verb = "would remove" if args.dry_run else "removed"
    for rel, keys in sorted(changes):
        print(f"{rel}: {verb} derived noise: {', '.join(keys)}")
    print(f"\ntropo fix: {verb} noise from {len(changes)} file(s)"
          + (" (dry run)" if args.dry_run else ""))
    return 0


def cmd_init(args):
    target = os.path.abspath(args.paths[0]) if args.paths else os.getcwd()
    dst = os.path.join(target, CONFIG_NAME)
    if os.path.exists(dst):
        sys.exit(f"tropo: {dst} already exists — not overwriting")
    os.makedirs(target, exist_ok=True)
    packs = [p.strip() for p in (args.packs or "").split(",") if p.strip()]
    lines = ["version = 1", ""]
    if packs:
        lines += ["packs = [" + ", ".join(f'"{p}"' for p in packs) + "]", ""]
    lines += ["[base]",
              'derive        = ["id", "title", "created", "updated"]',
              'optional      = { tags = "string-list" }',
              "allow_untyped = true", ""]
    if not packs:
        lines += ["# Declare types below: the table key is the type name,",
                  "# `folder` is the directory basename that roots it.",
                  "# [types.note]",
                  '# folder   = "notes"',
                  '# optional = { tags = "string-list" }', ""]
    with open(dst, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))
    print(f"tropo: wrote {dst}" + (f"  (packs: {', '.join(packs)})" if packs else ""))
    return 0


def _migrate_error(args, message, from_name, to_name, *, failed=0, embedding_config=None):
    embedding = _embedding_summary(
        embedding_config or _vector_config_fallback("embedding persistence is disabled")
    )
    if args.json:
        print(json.dumps({"migrated": 0, "failed": failed, "error": message,
                          "from": from_name, "to": to_name,
                          "embedding": embedding}, indent=2))
    else:
        print(f"tropo migrate: {message}", file=sys.stderr)
    return 1


def cmd_migrate(args, resolver):
    """Move graph nodes from one storage backend to another."""
    import time as _time
    from_name = getattr(args, "from_backend", None) or "file"
    to_name = getattr(args, "to_backend", None) or "embedded"
    embedding_config = _vector_config_fallback("embedding persistence is disabled")

    if from_name == to_name:
        return _migrate_error(
            args, "--from and --to must be different backends", from_name, to_name
        )
    if from_name != "file":
        return _migrate_error(
            args,
            f"--from {from_name!r} not yet supported; only 'file' is the supported source",
            from_name,
            to_name,
        )
    if to_name != "embedded":
        return _migrate_error(
            args,
            f"--to {to_name!r} not yet supported; only 'embedded' is the supported target",
            from_name,
            to_name,
        )

    vivary_cfg = os.path.join(resolver.root, STORAGE_DIR, STORAGE_CONFIG_NAME)
    if not os.path.isfile(vivary_cfg) and not args.dry_run:
        return _migrate_error(
            args,
            "no .vivary/storage.toml found — run `create-vivary wizard` to configure a storage backend first",
            from_name,
            to_name,
        )

    if not args.dry_run:
        try:
            storage_cfg = _load_storage_config(resolver.root)
            configured_backend = storage_cfg.get("backend", "file")
            if configured_backend not in ("embedded", "auto"):
                raise ConfigError(
                    f"configured storage backend is {configured_backend!r}; "
                    "run `create-vivary wizard` to configure embedded storage first"
                )
        except ConfigError as e:
            return _migrate_error(args, str(e), from_name, to_name)
        embedding_config = _load_vector_query_config(resolver.root)
        if embedding_config["status"] == "misconfigured":
            return _migrate_error(
                args,
                embedding_config["detail"],
                from_name,
                to_name,
                embedding_config=embedding_config,
            )

    docs = analyze(resolver.root, [], resolver)
    nodes = _migrate_nodes_with_embeddings(docs, embedding_config)
    n = len(nodes)
    embedding_summary = _embedding_summary(
        embedding_config,
        embedded=n if embedding_config["status"] == "ok" else 0,
    )

    if args.dry_run:
        if args.json:
            print(json.dumps({"migrated": n, "failed": 0, "duration_ms": 0,
                              "from": from_name, "to": to_name, "dry_run": True,
                              "embedding": embedding_summary}, indent=2))
        else:
            print(f"tropo migrate: would migrate {n} node(s) from {from_name} to {to_name} (dry run)")
        return 0

    t0 = _time.monotonic()
    try:
        dst = get_backend(resolver.root, allow_auto_fallback=False)
        if hasattr(dst, "replace_all"):
            dst.replace_all(nodes)
        else:
            dst.upsert(nodes)
        dst.close()
    except ConfigError as e:
        if args.json:
            print(json.dumps({"migrated": 0, "failed": n, "error": str(e),
                              "from": from_name, "to": to_name,
                              "embedding": embedding_summary}, indent=2))
        else:
            print(f"tropo migrate: {e}", file=sys.stderr)
        return 1
    elapsed = int((_time.monotonic() - t0) * 1000)

    if args.json:
        print(json.dumps({"migrated": n, "failed": 0, "duration_ms": elapsed,
                          "from": from_name, "to": to_name, "dry_run": False,
                          "embedding": embedding_summary}, indent=2))
    else:
        suffix = ""
        if embedding_summary["status"] == "ok":
            suffix = f"; embedded {embedding_summary['embedded']} local vector(s)"
        print(f"tropo migrate: {n} node(s) migrated from {from_name} to {to_name} ({elapsed}ms){suffix}")
    return 0


def cmd_query(args, resolver):
    """Search the workspace knowledge graph by text."""
    if not args.paths:
        sys.exit("tropo query: provide a search query — e.g. tropo query \"auth module\"")
    text = " ".join(args.paths)
    raw_k = getattr(args, "k", 10)
    k = 10 if raw_k is None else raw_k
    mode = getattr(args, "mode", "text") or "text"
    raw_snippet = getattr(args, "snippet", None)
    snippet = _DEFAULT_SNIPPET_CHARS if raw_snippet is None else raw_snippet
    explain = getattr(args, "explain", False)
    type_filters = getattr(args, "type", None) or []
    path_filters = getattr(args, "path", None) or []
    edge_filters = getattr(args, "edge", None) or []

    if mode == "vector":
        rc, results, vector = vector_query(
            resolver,
            text,
            k=k,
            type_filters=type_filters,
            path_filters=path_filters,
            edge_filters=edge_filters,
            snippet_chars=snippet,
            explain=explain,
        )
        if args.json:
            print(json.dumps({
                "query": text,
                "k": k,
                "mode": mode,
                "vector": vector,
                "filters": {
                    "type": type_filters,
                    "path": path_filters,
                    "edge": edge_filters,
                },
                "results": results,
            }, indent=2))
            return rc
        if rc != 0:
            print(f"tropo query: vector search unavailable: {vector['detail']}")
            return rc
        if vector["status"] == "fallback":
            print(f"tropo query: vector search fallback ({vector['detail']})")
        print(f"tropo query: {len(results)} vector result(s) for {text!r}")
        for i, r in enumerate(results, 1):
            typ = f"[{r['type']}] " if r.get("type") else ""
            print(f"{i:2}. {typ}{r['id']} - {r['path']}")
            if r.get("reason"):
                print(f"    why: {r['reason']}")
        return 0

    if mode == "semantic":
        rc, results, semantic = semantic_query(
            resolver,
            text,
            k=k,
            type_filters=type_filters,
            path_filters=path_filters,
            edge_filters=edge_filters,
        )
        if args.json:
            print(json.dumps({
                "query": text,
                "k": k,
                "mode": mode,
                "semantic": semantic,
                "filters": {
                    "type": type_filters,
                    "path": path_filters,
                    "edge": edge_filters,
                },
                "results": results,
            }, indent=2))
            return rc
        if rc != 0:
            print(f"tropo query: semantic search unavailable: {semantic['detail']}")
            return rc
        print(f"tropo query: {len(results)} semantic result(s) for {text!r}")
        for i, r in enumerate(results, 1):
            typ = f"[{r['type']}] " if r.get("type") else ""
            print(f"{i:2}. {typ}{r['id']} - {r['path']}")
            if r.get("reason"):
                print(f"    why: {r['reason']}")
        return 0

    results = search_graph(
        resolver,
        text,
        k=k,
        type_filters=type_filters,
        path_filters=path_filters,
        edge_filters=edge_filters,
        snippet_chars=snippet,
        explain=explain,
    )

    if args.json:
        print(json.dumps({
            "query": text,
            "k": k,
            "mode": mode,
            "filters": {
                "type": type_filters,
                "path": path_filters,
                "edge": edge_filters,
            },
            "results": results,
        }, indent=2))
        return 0

    if not results:
        print(f"tropo query: no results for {text!r}")
        return 0
    print(f"tropo query: {len(results)} result(s) for {text!r}")
    for i, r in enumerate(results, 1):
        typ = f"[{r['type']}] " if r.get("type") else ""
        print(f"{i:2}. {typ}{r['id']} - {r['path']}")
        if explain and r.get("reasons"):
            print(f"    why: {', '.join(r['reasons'])}")
        if r.get("snippet"):
            print(f"    {r['snippet']}")
    return 0


def _same_filesystem_path(left, right):
    if os.name == "nt":
        return left.casefold() == right.casefold()
    return left == right


def _governed_checkout(observation, root):
    return next(
        (
            entry
            for entry in observation.get("checkouts", [])
            if entry.get("path") == root
        ),
        None,
    )


def _refuse_nested_governed_root(observation, root, normalize):
    """Keep governed scope equal to the resolved worktree root."""
    checkout = _governed_checkout(observation, root)
    worktree_root = (
        ((checkout or {}).get("facts") or {}).get("worktree_root") or {}
    )
    if (
        worktree_root.get("status") == "known"
        and not _same_filesystem_path(
            normalize(worktree_root.get("value")),
            root,
        )
    ):
        raise ValueError(
            "the governed Tropo root must be the Git worktree root; "
            "nested roots are refused to prevent sibling checkout facts from leaking"
        )


def _governed_observation_state(observation):
    """The observed checkout state that can enter a governed capsule.

    Timestamps are deliberately excluded: they describe the scan, not the
    worktree. Every checkout fact and refusal remains in the comparison because
    either can alter a graph, derived check, claim, unknown, omission, evidence,
    or fingerprint.
    """
    return (
        observation.get("checkouts", []),
        observation.get("refusals", []),
    )


def _governed_content_unavailability_reason(observation):
    """Explain why a stable fact bracket still cannot attest read content."""
    checkouts = observation.get("checkouts", [])
    if len(checkouts) != 1:
        return "dirty_state_unknown"
    for checkout in checkouts:
        facts = checkout.get("facts") or {}
        repository = facts.get("is_git_repository") or {}
        if repository.get("status") != "known" or repository.get("value") is not True:
            return "dirty_state_unknown"
        for name in ("is_dirty", "dirty_entries"):
            fact = facts.get(name) or {}
            if (
                fact.get("status") != "known"
                and fact.get("reason") != "ignored_dirty_entries_excluded"
            ):
                return "dirty_state_unknown"
    return None


def _governed_content_state(content):
    """Content identity without the observation timestamp."""
    return (
        content.get("schema"),
        content.get("terms", []),
        content.get("allowlist", []),
        content.get("checkouts", []),
        content.get("refusals", []),
    )


def _governed_content_unavailable(
    content,
    root,
    reason="worktree_state_changed_during_content_observation",
):
    """Discard content that cannot be bound without changing content schemas."""
    return {
        "schema": content.get("schema", "vivary.workspace-content/v0"),
        "observed_at": content.get("observed_at"),
        "terms": content.get("terms", []),
        "allowlist": content.get("allowlist", [root]),
        "checkouts": [
            {
                "raw_path": root,
                "path": root,
                "status": "unknown",
                "reason": reason,
                "matches": [],
                "omissions": [],
                "evidence": {
                    "command": "governed content observation bracket"
                },
            }
        ],
        "refusals": [],
    }


def governed_find(root, question, *, max_claims=24, cancelled=None):
    """Compile a bounded governed-context capsule for one Tropo workspace.

    Facts and content must describe one worktree state. A content scan is
    bracketed by two full checkout observations; a changed bracket retries once,
    then discards the unstable content rather than quietly pairing it with
    stale facts.
    """
    from vivary_core import (
        compile_task_capsule,
        observe_checkouts,
        observe_content,
        normalize_path,
        project_workspace_graph,
    )

    root = normalize_path(os.path.realpath(os.path.abspath(root)))
    paths = [root]
    terms = _governed_query_terms(question)

    for _attempt in range(2):
        _public_cancel_if_requested(cancelled)
        before = observe_checkouts(
            paths,
            allowlist=paths,
            cancelled=cancelled,
        )
        _public_cancel_if_requested(cancelled)
        _refuse_nested_governed_root(before, root, normalize_path)
        scanned_content = observe_content(
            paths,
            allowlist=paths,
            terms=terms,
            cancelled=cancelled,
        )
        _public_cancel_if_requested(cancelled)
        after = observe_checkouts(
            paths,
            allowlist=paths,
            cancelled=cancelled,
        )
        _public_cancel_if_requested(cancelled)
        _refuse_nested_governed_root(after, root, normalize_path)
        if _governed_observation_state(before) != _governed_observation_state(after):
            continue

        observation = after
        unavailable_reason = _governed_content_unavailability_reason(after)
        if unavailable_reason is not None:
            content = _governed_content_unavailable(
                scanned_content,
                root,
                reason=unavailable_reason,
            )
            break

        checkout = _governed_checkout(after, root) or {}
        dirty_fact = (checkout.get("facts") or {}).get("is_dirty") or {}
        requires_rescan = (
            dirty_fact.get("status") != "known" or dirty_fact.get("value") is True
        )
        if requires_rescan:
            rescanned_content = observe_content(
                paths,
                allowlist=paths,
                terms=terms,
                cancelled=cancelled,
            )
            _public_cancel_if_requested(cancelled)
            final = observe_checkouts(
                paths,
                allowlist=paths,
                cancelled=cancelled,
            )
            _public_cancel_if_requested(cancelled)
            _refuse_nested_governed_root(final, root, normalize_path)
            if (
                _governed_observation_state(after)
                != _governed_observation_state(final)
                or _governed_content_state(scanned_content)
                != _governed_content_state(rescanned_content)
            ):
                continue
            observation = final
            content = rescanned_content
        else:
            content = scanned_content
        break
    else:
        # Both bounded attempts saw a changing checkout. `after` is still one
        # coherent fact snapshot, but none of the read content can be bound to
        # it, so expose that incompleteness instead of mixing observations.
        observation = after
        content = _governed_content_unavailable(scanned_content, root)

    _public_cancel_if_requested(cancelled)
    graph = project_workspace_graph(observation)
    _public_cancel_if_requested(cancelled)
    capsule = compile_task_capsule(
        task={"question": question, "scope": paths},
        graph=graph,
        content=content,
        budget={"max_claims": max_claims},
    )
    _public_cancel_if_requested(cancelled)
    return capsule


def _print_governed_find(capsule):
    claims = capsule["claims"]
    print(
        f"tropo find: governed capsule {capsule['capsule_id']} "
        f"({len(claims)} claim(s), {len(capsule['conflicts'])} conflict(s), "
        f"{len(capsule['unknowns'])} unknown(s))"
    )
    for index, claim in enumerate(claims, 1):
        print(f"{index:2}. {claim['claim']}")
        print(f"    why: {claim['selection_reason']}")


def cmd_find(args, resolver):
    """Return a small typed context packet or an experimental governed capsule."""
    text = " ".join(args.paths).strip()
    if not text:
        print(
            "tropo find: provide a task or question — e.g. tropo find \"auth module\"",
            file=sys.stderr,
        )
        return 2

    if getattr(args, "governed", False):
        unsupported = []
        for flag, value in (
            ("--budget", getattr(args, "budget", None)),
            ("--k", getattr(args, "k", None)),
            ("--mode", getattr(args, "mode", None)),
            ("--snippet", getattr(args, "snippet", None)),
        ):
            if value is not None:
                unsupported.append(flag)
        unsupported.extend(
            flag
            for flag, value in (
                ("--type", getattr(args, "type", None)),
                ("--path", getattr(args, "path", None)),
                ("--edge", getattr(args, "edge", None)),
                ("--explain", getattr(args, "explain", False)),
            )
            if value
        )
        if unsupported:
            print(
                "tropo find --governed: unsupported option(s): "
                + ", ".join(unsupported),
                file=sys.stderr,
            )
            return 2

        max_claims = getattr(args, "max_claims", None)
        if max_claims is None:
            max_claims = 24
        try:
            capsule = governed_find(
                resolver.root,
                text,
                max_claims=max_claims,
            )
        except ImportError:
            print(
                "tropo find --governed: vivary-core>=0.2.7 is required; "
                "install Tropo with its declared dependencies",
                file=sys.stderr,
            )
            return 2
        except ValueError as error:
            print(f"tropo find --governed: {error}", file=sys.stderr)
            return 2

        if args.json:
            print(json.dumps(capsule, indent=2))
        else:
            _print_governed_find(capsule)
        return 0

    if getattr(args, "max_claims", None) is not None:
        print(
            "tropo find: --max-claims requires --governed",
            file=sys.stderr,
        )
        return 2

    k = getattr(args, "k", 5) or 5
    budget = getattr(args, "budget", _DEFAULT_FIND_BUDGET) or _DEFAULT_FIND_BUDGET
    type_filters = getattr(args, "type", None) or []
    path_filters = getattr(args, "path", None) or []
    edge_filters = getattr(args, "edge", None) or []
    raw_snippet = getattr(args, "snippet", None)
    snippet = _DEFAULT_SNIPPET_CHARS if raw_snippet is None else raw_snippet

    query_results = search_graph(
        resolver,
        text,
        k=k,
        type_filters=type_filters,
        path_filters=path_filters,
        edge_filters=edge_filters,
        snippet_chars=snippet,
        explain=True,
    )
    context, estimated_tokens = _trim_context_to_budget(
        _context_results(query_results),
        budget,
    )

    if args.json:
        print(json.dumps({
            "query": text,
            "k": k,
            "budget": budget,
            "estimated_tokens": estimated_tokens,
            "filters": {
                "type": type_filters,
                "path": path_filters,
                "edge": edge_filters,
            },
            "results": context,
        }, indent=2))
        return 0

    if not context:
        print(f"tropo find: no context for {text!r}")
        return 0
    print(
        f"tropo find: {len(context)} context result(s) for {text!r} "
        f"(~{estimated_tokens} token(s), budget {budget})"
    )
    for i, result in enumerate(context, 1):
        typ = f"[{result['type']}] " if result.get("type") else ""
        print(f"{i:2}. {typ}{result['id']} - {result['path']}")
        print(f"    why: {result['reason']}")
        if result.get("snippet"):
            print(f"    {result['snippet']}")
    return 0


def _extract_receipt_path(argv):
    for index, token in enumerate(argv):
        if token == "--":
            break
        if token == "--receipt":
            if index + 1 < len(argv) and not argv[index + 1].startswith("-"):
                return argv[index + 1], "flag"
            return None, None
        if token.startswith("--receipt="):
            path = token.split("=", 1)[1]
            return (path, "flag") if path else (None, None)
    env_path = os.environ.get(RECEIPT_ENV)
    if env_path:
        return env_path, "env"
    return None, None


def _receipt_flags(argv):
    flags = set()
    skip_value = False
    for token in argv:
        if token == "--":
            break
        if skip_value:
            skip_value = False
            continue
        if token.startswith("--"):
            name = token.split("=", 1)[0]
            if name in RECEIPT_KNOWN_FLAGS and name != "--receipt":
                flags.add(name)
            if name in RECEIPT_VALUE_FLAGS and "=" not in token:
                skip_value = True
        elif token in RECEIPT_KNOWN_FLAGS:
            flags.add(token)
    return sorted(flags)


def _receipt_command(argv):
    if "--version" in argv:
        return "version"
    if any(token in ("-h", "--help") for token in argv):
        return "help"
    skip_value = False
    for token in argv:
        if token == "--":
            break
        if skip_value:
            skip_value = False
            continue
        if token.startswith("--"):
            name = token.split("=", 1)[0]
            if name in RECEIPT_VALUE_FLAGS and "=" not in token:
                skip_value = True
            continue
        if token in COMMANDS:
            return token
    return "check"


def _exit_code_value(code):
    if code is None:
        return 0
    if isinstance(code, int):
        return code
    return 1


def _receipt_is_reserved_windows_path(path):
    if os.name != "nt":
        return False
    stem = os.path.basename(os.path.normpath(path)).split(".", 1)[0].rstrip(" .").upper()
    return stem in RECEIPT_RESERVED_WINDOWS_NAMES


def _receipt_has_symlink_ancestor(path):
    target = os.path.abspath(os.path.expanduser(path))
    current = os.path.dirname(target) or os.getcwd()
    while True:
        if os.path.lexists(current) and (
            os.path.islink(current)
            or (
                hasattr(os.path, "isjunction")
                and os.path.isjunction(current)
            )
        ):
            return True
        parent = os.path.dirname(current)
        if parent == current:
            return False
        current = parent


def _receipt_error_message(exc):
    message = str(exc)
    safe_messages = {
        "receipt path must not be a Windows device name",
        "receipt path must not be a symlink",
        "receipt path must be a regular file",
        "receipt path must not contain a symlink or junction directory",
    }
    if message in safe_messages:
        return message
    return "could not write receipt; check that the receipt path is a writable regular file"


def _append_run_receipt(
    *,
    tool,
    version,
    argv,
    started_at,
    exit_code,
    receipt_path,
    receipt_source,
    error_type=None,
):
    if not receipt_path:
        return True

    target = os.path.expanduser(receipt_path)
    parent = os.path.dirname(os.path.abspath(target)) or os.getcwd()
    try:
        if _receipt_is_reserved_windows_path(target):
            raise OSError("receipt path must not be a Windows device name")
        if _receipt_has_symlink_ancestor(target):
            raise OSError("receipt path must not contain a symlink or junction directory")
        if os.path.lexists(target):
            if os.path.islink(target):
                raise OSError("receipt path must not be a symlink")
            if not os.path.isfile(target):
                raise OSError("receipt path must be a regular file")
        os.makedirs(parent, exist_ok=True)
        if _receipt_has_symlink_ancestor(target):
            raise OSError("receipt path must not contain a symlink or junction directory")

        record = {
            "schema": RECEIPT_SCHEMA,
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "tool": tool,
            "version": version,
            "command": _receipt_command(argv),
            "flags": _receipt_flags(argv),
            "arg_count": len(argv),
            "exit_code": exit_code,
            "ok": exit_code == 0,
            "duration_ms": int((time.monotonic() - started_at) * 1000),
            "python": platform.python_version(),
            "platform": platform.system(),
            "receipt_source": receipt_source,
        }
        if error_type:
            record["error_type"] = error_type
        with open(target, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(record, sort_keys=True, separators=(",", ":")))
            fh.write("\n")
    except OSError as e:
        print(f"{tool}: receipt: {_receipt_error_message(e)}", file=sys.stderr)
        return False
    return True


def _main(argv=None):
    p = argparse.ArgumentParser(prog="tropo", description="The filesystem is the schema.")
    p.add_argument("--version", action="version", version=f"tropo {__version__}")
    p.add_argument("command", nargs="?", default="check",
                   choices=COMMANDS)
    p.add_argument("paths", nargs="*",
                   help="files or folders (default: whole tree); for blast/query/find, "
                        "the target id/text; for map, the single tree to inventory")
    p.add_argument("--strict", action="store_true",
                   help="check: force warnings to fail (the default; overrides a lenient config)")
    p.add_argument("--lenient", action="store_true",
                   help="check: allow warnings without failing (relax the opinionated default)")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    p.add_argument("--quiet", action="store_true", help="hide warnings")
    p.add_argument("--dry-run", action="store_true", help="fix/migrate: preview without writing")
    p.add_argument("--depth", type=int, default=None,
                   help="blast: max hops (default: unlimited); map: directory table depth (default: 3)")
    p.add_argument("--max-entries", type=int, default=None,
                   help="map: cap the number of directory rows in the table (default: unlimited)")
    p.add_argument("--out", default=None, help="view: write HTML here (default: stdout)")
    p.add_argument("--packs", default=None, help="init: comma-separated pack names")
    p.add_argument("--root", default=None, help="tree root (default: walk up for tropo.toml)")
    p.add_argument("--config", default=None, help="explicit tropo.toml path")
    p.add_argument("--receipt", default=None, metavar="PATH",
                   help=f"append a local privacy-preserving JSONL run receipt (or set {RECEIPT_ENV})")
    p.add_argument("--from", dest="from_backend", choices=["file", "embedded", "cloud"],
                   default=None, help="migrate: source backend (default: file)")
    p.add_argument("--to", dest="to_backend", choices=["file", "embedded", "cloud"],
                   default=None, help="migrate: destination backend (default: embedded)")
    p.add_argument("--yes", action="store_true", help="auto-confirm prompts (agent/CI use)")
    p.add_argument("--k", type=int, default=None,
                   help="query/find: number of results (query default: 10, find default: 5)")
    p.add_argument("--mode", choices=["text", "vector", "semantic"], default=None,
                   help="query: text graph search (default), local typed vector search, or optional semantic-memory provider search")
    p.add_argument("--type", action="append", default=[],
                   help="query/find: restrict results to a document type; repeatable")
    p.add_argument("--path", action="append", default=[],
                   help="query/find: restrict results to a path glob; repeatable")
    p.add_argument("--edge", action="append", default=[],
                   help="query/find: require outbound edge FIELD or FIELD:TARGET; repeatable")
    p.add_argument("--snippet", type=int, default=None,
                   help=f"query/find: snippet characters per result (default: {_DEFAULT_SNIPPET_CHARS}; 0 disables)")
    p.add_argument("--explain", action="store_true",
                   help="query: include stable match reasons")
    p.add_argument("--budget", type=int, default=None,
                   help=f"find: approximate token budget (default: {_DEFAULT_FIND_BUDGET})")
    p.add_argument("--governed", action="store_true",
                   help="find: experimental read-only scan -> graph -> capsule pipeline")
    p.add_argument("--max-claims", type=int, default=None,
                   help="find --governed: maximum capsule claims (default: 24)")
    args = p.parse_args(argv)

    if args.command != "find" and (
        args.governed or args.max_claims is not None
    ):
        p.error("--governed and --max-claims are only valid with find")

    if args.command == "init":
        return cmd_init(args)
    if args.command == "map":
        return cmd_map(args)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    if args.config:
        root = args.root or os.path.dirname(os.path.abspath(args.config))
    else:
        start = args.root or (args.paths[0] if args.paths and args.command not in ("migrate", "query", "find") else os.getcwd())
        root = find_root(start)
        if root is None:
            sys.exit(f"tropo: no {CONFIG_NAME} found walking up from {os.path.abspath(start)}")
    try:
        resolver = ConfigResolver(root, script_dir, args.config)
    except ConfigError as e:
        sys.exit(f"tropo: config error: {e}")

    return {"check": cmd_check, "signal": cmd_signal, "types": cmd_types,
            "stats": cmd_stats, "graph": cmd_graph, "blast": cmd_blast,
            "view": cmd_view, "plan": cmd_plan, "fix": cmd_fix,
            "migrate": cmd_migrate, "query": cmd_query, "find": cmd_find}[args.command](args, resolver)


def main(argv=None):
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    started_at = time.monotonic()
    receipt_path, receipt_source = _extract_receipt_path(raw_argv)
    try:
        rc = _main(raw_argv)
    except SystemExit as e:
        code = _exit_code_value(e.code)
        receipt_ok = _append_run_receipt(
            tool="tropo",
            version=__version__,
            argv=raw_argv,
            started_at=started_at,
            exit_code=code,
            receipt_path=receipt_path,
            receipt_source=receipt_source,
            error_type="SystemExit" if code else None,
        )
        if not receipt_ok and code == 0:
            raise SystemExit(1) from e
        raise
    except Exception as e:
        _append_run_receipt(
            tool="tropo",
            version=__version__,
            argv=raw_argv,
            started_at=started_at,
            exit_code=1,
            receipt_path=receipt_path,
            receipt_source=receipt_source,
            error_type=type(e).__name__,
        )
        raise
    receipt_ok = _append_run_receipt(
        tool="tropo",
        version=__version__,
        argv=raw_argv,
        started_at=started_at,
        exit_code=_exit_code_value(rc),
        receipt_path=receipt_path,
        receipt_source=receipt_source,
    )
    if not receipt_ok and _exit_code_value(rc) == 0:
        return 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
