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
  tropo query <text> [--type TYPE] [--path GLOB] [--edge FIELD[:TARGET]]
  tropo find <text> [--budget N] [--json]
  tropo map [PATH | --root PATH] [--depth N] [--max-entries N] [--json]

Config is TOML (tropo.toml, resolved by walking up). Content frontmatter is YAML.
Zero dependencies. Requires Python 3.11+ (for tomllib).
Exit codes: 0 = clean, 1 = errors found, 2 = config/usage problem.
"""

import argparse
import asyncio
import copy
import datetime
import importlib
import importlib.util
import json
import math
import os
import platform
import re
import subprocess
import sys
import tempfile
import time
import tomllib
from collections import Counter, deque
from fnmatch import fnmatchcase

__version__ = "0.4.1"
RECEIPT_ENV = "VIVARY_RECEIPT_LOG"
RECEIPT_SCHEMA = "vivary.run_receipt.v1"
COMMANDS = (
    "check", "signal", "types", "stats", "graph", "blast", "view", "plan",
    "fix", "init", "migrate", "query", "find", "map",
)
RECEIPT_VALUE_FLAGS = {
    "--receipt", "--depth", "--max-entries", "--out", "--packs", "--root",
    "--config", "--from", "--to", "--k", "--type", "--path", "--edge",
    "--snippet", "--budget",
}
RECEIPT_KNOWN_FLAGS = RECEIPT_VALUE_FLAGS | {
    "--budget", "--dry-run", "--explain", "--help", "--json", "--lenient",
    "--quiet", "--strict", "--version", "--yes", "-h",
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
    b_base.setdefault("optional", {})
    for d in a_base.get("derive", []):
        if d not in b_base["derive"]:
            b_base["derive"].append(d)
    for f, spec in (a_base.get("optional") or {}).items():
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


def find_root(start):
    """Walk up from `start` to the nearest directory containing tropo.toml."""
    d = os.path.abspath(start)
    if os.path.isfile(d):
        d = os.path.dirname(d)
    while True:
        if os.path.isfile(os.path.join(d, CONFIG_NAME)):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


class Config:
    def __init__(self, data, root):
        self.root = root
        base = data.get("base", {})
        self.derive = base.get("derive", [])
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
        known = dict(self.base_optional)
        for d in self.derive:
            known[d] = DERIVED_SPECS.get(d, "any")
        required = {}
        t = self.types.get(type_name)
        if t:
            required = dict(t.get("required", {}))
            known.update(required)
            known.update(t.get("optional", {}))
        return required, known


def _compose(root, script_dir, config_path=None):
    raw = _read_toml(config_path or os.path.join(root, CONFIG_NAME))
    composed = {"base": {}, "types": {}, "exclude": []}
    for pack in raw.get("packs", []):
        _merge_config(composed, _read_pack(pack, root, script_dir))
    _merge_config(composed, raw)  # _merge_config normalizes each type's raw `folder`
    return composed


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
                    _merge_config(composed, _read_toml(ov))
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


def derive(full, body):
    created, updated = _git_dates(full)
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
            if not _realpath_within(root_real, dirpath):
                dirnames[:] = []
                continue
            reldir = os.path.relpath(dirpath, root)
            reldir = "" if reldir == "." else reldir
            dirnames[:] = sorted(
                d for d in dirnames
                if not is_excluded(os.path.join(reldir, d), exclude)
                and _realpath_within(root_real, os.path.join(dirpath, d)))
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


def analyze_file(full, rel, config):
    doc = Doc()
    doc.full, doc.rel = full, rel
    doc.findings, doc.refs, doc.declared, doc.noise = [], [], {}, []
    rel = rel.replace("\\", "/")

    try:
        with open(full, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError as e:
        doc.findings.append(Finding(rel, 0, "error", "E000", f"cannot read file: {e}"))
        doc.type, doc.fields, doc.derived = None, {}, {}
        return doc

    yaml_text, body = extract_frontmatter(text)
    doc.derived = derive(full, body)

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
    if doc.type is None:
        doc.findings.append(Finding(
            rel, 1, "warning" if config.allow_untyped else "error", "W201",
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
            doc.findings.append(Finding(
                rel, line_of(key), "warning", "W202",
                f"unknown field {key!r}" + (f" for type {doc.type!r}" if doc.type else "")))
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
    docs = [analyze_file(full, rel, resolver.for_dir(os.path.dirname(full)))
            for full, rel in iter_markdown(root, paths, resolver.base.exclude)]
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
_QUERY_STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for",
    "from", "how", "i", "in", "is", "it", "of", "on", "or", "our", "the",
    "this", "to", "we", "what", "where", "which", "who", "why",
}


def _load_storage_config(root):
    path = os.path.join(root, STORAGE_DIR, STORAGE_CONFIG_NAME)
    if not os.path.isfile(path):
        return {"backend": "file"}
    try:
        with open(path, "rb") as fh:
            data = tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise ConfigError(f"{path}: {e}")
    return data.get("storage", {"backend": "file"})


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
        with open(path, "rb") as fh:
            data = tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError) as e:
        return {
            "enabled": False,
            "provider": "unknown",
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
    return {
        "enabled": True,
        "provider": provider,
        "status": "configured",
        "detail": "",
    }


def _file_body(full_path, limit=_CONTENT_PREVIEW_CHARS):
    try:
        text = open(full_path, encoding="utf-8", errors="replace").read()
    except OSError:
        return ""
    m, text = _frontmatter_match(text)
    body = text[m.end():] if m else text
    return body if limit is None else body[:limit]


def _doc_to_node(d):
    return {
        "id":      d.derived.get("id", ""),
        "type":    d.type or "",
        "path":    d.rel.replace("\\", "/"),
        "title":   d.derived.get("title", ""),
        "content": _file_body(d.full),
    }


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

    def get(self, node_id):
        tbl = self._table()
        if tbl is None:
            return None
        rows = tbl.search().where(f"id = '{node_id}'").limit(1).to_list()
        return rows[0] if rows else None

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


def get_backend(root):
    """Return the configured StorageBackend for the workspace at root."""
    cfg = _load_storage_config(root)
    backend = cfg.get("backend", "file")

    if backend == "file":
        return _FileBackend(root)

    if backend in ("embedded", "auto"):
        emb = cfg.get("embedded", {})
        raw_path = emb.get("path", os.path.join(STORAGE_DIR, "data"))
        path = raw_path if os.path.isabs(raw_path) else os.path.join(root, raw_path)
        provider = emb.get("provider", "lancedb")
        if provider == "lancedb":
            try:
                return _LanceBackend(path)
            except ConfigError:
                if backend == "auto":
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


def _build_search_records(docs, nodes, edges):
    docs_by_id = {d.derived.get("id"): d for d in docs if d.derived.get("id") is not None}
    outbound = {}
    for edge in edges:
        if edge["broken"]:
            continue
        outbound.setdefault(edge["from"], []).append({
            "field": edge["field"],
            "to": edge["to"],
        })
    records = []
    for nid in sorted(nodes):
        doc = docs_by_id.get(nid)
        node = nodes[nid]
        fields = doc.fields if doc is not None else {}
        frontmatter_text = " ".join(
            f"{key}: {_stringify_field_value(value)}"
            for key, value in sorted(fields.items())
        )
        body = _file_body(doc.full, limit=None) if doc is not None else ""
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


def _score_source(query, terms, source, phrase_weight, term_weight):
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
        count = len(re.findall(rf"\b{re.escape(term)}\b", source_l))
        if count:
            score += count * term_weight
            matched = True
    return score, matched


def _best_snippet(record, query, terms, limit):
    if limit is None:
        limit = _DEFAULT_SNIPPET_CHARS
    if limit <= 0:
        return None
    source = record.get("body") or record.get("frontmatter_text") or record.get("title") or ""
    text = re.sub(r"\s+", " ", source).strip()
    if not text:
        return None
    lower = text.lower()
    needles = [query.lower().strip()] + terms
    starts = [lower.find(n) for n in needles if n and lower.find(n) >= 0]
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


def search_graph(resolver, text, *, k=10, type_filters=None, path_filters=None,
                 edge_filters=None, snippet_chars=_DEFAULT_SNIPPET_CHARS,
                 explain=False):
    docs = analyze(resolver.root, [], resolver)
    nodes, edges = build_graph(docs)
    records = _build_search_records(docs, nodes, edges)
    terms = _query_terms(text)
    type_filters = type_filters or []
    path_filters = path_filters or []
    edge_filters = edge_filters or []
    results = []

    for record in records:
        if not _passes_search_filters(record, type_filters, path_filters, edge_filters):
            continue

        score = 0
        reasons = []
        id_title = f"{record['id']} {record['title']}"
        s, matched = _score_source(text, terms, id_title, 120, 40)
        if matched:
            score += s
            reasons.append("title/id match")
        s, matched = _score_source(text, terms, record["frontmatter_text"], 80, 24)
        if matched:
            score += s
            reasons.append("frontmatter match")
        s, matched = _score_source(text, terms, record["path"], 60, 16)
        if matched:
            score += s
            reasons.append("path match")
        s, matched = _score_source(text, terms, record["body"], 40, 10)
        if matched:
            score += s
            reasons.append("body match")
        edge_text = " ".join(f"{e['field']} {e['to']}" for e in record["edges"])
        s, matched = _score_source(text, terms, edge_text, 30, 8)
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
        snippet = _best_snippet(record, text, terms, snippet_chars)
        if snippet:
            result["snippet"] = snippet
        if explain:
            result["reasons"] = reasons
        if explain or edge_filters:
            result["edges"] = record["edges"]
        results.append(result)

    results.sort(key=lambda r: (-r["score"], r["path"], r["id"]))
    return results[:max(0, k)]


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
    roots = [workspace_root, os.getcwd()]
    return any(_is_within(os.path.realpath(root), origin_real) for root in roots)


def _import_optional_cognee_adapter(workspace_root):
    package_file = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "memory-cognee", "vivary_cognee.py")
    )
    existing = sys.modules.get("vivary_cognee")
    if existing is not None:
        origin = getattr(existing, "__file__", None)
        if _adapter_origin_is_unsafe(origin, workspace_root, package_file):
            raise ImportError("refusing workspace-local vivary_cognee adapter")
        return existing
    if os.path.isfile(package_file):
        return _load_cognee_adapter_from_path(package_file)
    spec = importlib.util.find_spec("vivary_cognee")
    if spec is None or spec.origin is None:
        raise ImportError("vivary-memory-cognee is not installed")
    if _adapter_origin_is_unsafe(spec.origin, workspace_root, package_file):
        raise ImportError("refusing workspace-local vivary_cognee adapter")
    return importlib.import_module("vivary_cognee")


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

    try:
        hits = asyncio.run(vivary_cognee.CogneeMemoryAdapter(resolver.root).recall(text, k=k))
    except getattr(vivary_cognee, "AdapterError", RuntimeError) as e:
        return 1, [], {
            "enabled": True,
            "provider": "cognee",
            "status": "unavailable",
            "detail": str(e),
        }

    type_filters = type_filters or []
    path_filters = path_filters or []
    edge_filters = edge_filters or []
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


def _map_walk(root, skip_patterns):
    """Walk the full tree from `root` (no depth limit — aggregate counts need
    the whole tree). Reuses `is_excluded` so skip semantics match `check`/`graph`
    (dotted dir-name patterns and path-anchored patterns both work). Directories
    whose *real* path was already visited are pruned, so NTFS junctions and
    symlink cycles never loop or double-count (os.walk's followlinks=False alone
    does not stop junctions — Windows does not classify them as symlinks).
    Yields (dirpath, reldir, dirnames, filenames) with dirnames pruned in place."""
    seen = set()
    for dirpath, dirnames, filenames in os.walk(root):
        real = os.path.normcase(os.path.realpath(dirpath))
        if real in seen:
            dirnames[:] = []  # already inventoried under its real path
            continue
        seen.add(real)
        reldir = os.path.relpath(dirpath, root)
        reldir = "" if reldir == "." else reldir.replace("\\", "/")
        dirnames.sort()
        dirnames[:] = [
            d for d in dirnames
            if not is_excluded((f"{reldir}/{d}" if reldir else d), skip_patterns)
        ]
        filenames.sort()
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
            if args.quiet and f.level == "warning":
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


def cmd_migrate(args, resolver):
    """Move graph nodes from one storage backend to another."""
    import time as _time
    from_name = getattr(args, "from_backend", None) or "file"
    to_name = getattr(args, "to_backend", None) or "embedded"

    if from_name == to_name:
        sys.exit("tropo migrate: --from and --to must be different backends")
    if from_name != "file":
        sys.exit(f"tropo migrate: --from {from_name!r} not yet supported; only 'file' is the supported source")

    vivary_cfg = os.path.join(resolver.root, STORAGE_DIR, STORAGE_CONFIG_NAME)
    if not os.path.isfile(vivary_cfg) and not args.dry_run:
        sys.exit(
            "tropo migrate: no .vivary/storage.toml found — "
            "run `create-vivary wizard` to configure a storage backend first"
        )

    docs = analyze(resolver.root, [], resolver)
    nodes = [_doc_to_node(d) for d in docs]
    n = len(nodes)

    if args.dry_run:
        if args.json:
            print(json.dumps({"migrated": n, "failed": 0, "duration_ms": 0,
                              "from": from_name, "to": to_name, "dry_run": True}, indent=2))
        else:
            print(f"tropo migrate: would migrate {n} node(s) from {from_name} to {to_name} (dry run)")
        return 0

    t0 = _time.monotonic()
    try:
        dst = get_backend(resolver.root)
        dst.upsert(nodes)
        dst.close()
    except ConfigError as e:
        if args.json:
            print(json.dumps({"migrated": 0, "failed": n, "error": str(e),
                              "from": from_name, "to": to_name}, indent=2))
        else:
            print(f"tropo migrate: {e}", file=sys.stderr)
        return 1
    elapsed = int((_time.monotonic() - t0) * 1000)

    if args.json:
        print(json.dumps({"migrated": n, "failed": 0, "duration_ms": elapsed,
                          "from": from_name, "to": to_name, "dry_run": False}, indent=2))
    else:
        print(f"tropo migrate: {n} node(s) migrated from {from_name} to {to_name} ({elapsed}ms)")
    return 0


def cmd_query(args, resolver):
    """Search the workspace knowledge graph by text."""
    if not args.paths:
        sys.exit("tropo query: provide a search query — e.g. tropo query \"auth module\"")
    text = " ".join(args.paths)
    k = getattr(args, "k", 10) or 10
    mode = getattr(args, "mode", "text") or "text"
    snippet = getattr(args, "snippet", _DEFAULT_SNIPPET_CHARS)
    explain = getattr(args, "explain", False)
    type_filters = getattr(args, "type", None) or []
    path_filters = getattr(args, "path", None) or []
    edge_filters = getattr(args, "edge", None) or []

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


def cmd_find(args, resolver):
    """Return a small typed context packet for a task or question."""
    if not args.paths:
        sys.exit("tropo find: provide a task or question — e.g. tropo find \"auth module\"")
    text = " ".join(args.paths)
    k = getattr(args, "k", 5) or 5
    budget = getattr(args, "budget", _DEFAULT_FIND_BUDGET) or _DEFAULT_FIND_BUDGET
    type_filters = getattr(args, "type", None) or []
    path_filters = getattr(args, "path", None) or []
    edge_filters = getattr(args, "edge", None) or []
    snippet = getattr(args, "snippet", _DEFAULT_SNIPPET_CHARS)

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
    context, estimated_tokens = _trim_context_to_budget(_context_results(query_results), budget)

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
    p.add_argument("--mode", choices=["text", "semantic"], default="text",
                   help="query: text graph search (default) or optional semantic-memory provider search")
    p.add_argument("--type", action="append", default=[],
                   help="query/find: restrict results to a document type; repeatable")
    p.add_argument("--path", action="append", default=[],
                   help="query/find: restrict results to a path glob; repeatable")
    p.add_argument("--edge", action="append", default=[],
                   help="query/find: require outbound edge FIELD or FIELD:TARGET; repeatable")
    p.add_argument("--snippet", type=int, default=_DEFAULT_SNIPPET_CHARS,
                   help="query/find: snippet characters per result (0 disables snippets)")
    p.add_argument("--explain", action="store_true",
                   help="query: include stable match reasons")
    p.add_argument("--budget", type=int, default=_DEFAULT_FIND_BUDGET,
                   help="find: approximate token budget for the context packet")
    args = p.parse_args(argv)

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
