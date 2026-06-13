#!/usr/bin/env python3
"""tropo - the filesystem is the schema.

A document's type is the folder it lives in; its metadata is only what cannot
be derived from where it sits and what it says. See SPEC.md for the normative
model. This engine implements spec v1: config resolution, folder-as-type,
derivation, validation, and the `signal` report.

Usage:
  tropo [check] [paths...] [--strict] [--json] [--quiet]
  tropo signal [paths...]
  tropo types
  tropo stats

Config is TOML (tropo.toml, resolved by walking up). Content frontmatter is YAML.
Zero dependencies. Requires Python 3.11+ (for tomllib).
Exit codes: 0 = clean, 1 = errors found, 2 = config/usage problem.
"""

import argparse
import copy
import datetime
import json
import os
import re
import subprocess
import sys
import tomllib
from collections import Counter

__version__ = "0.1.0"

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


FM_RE = re.compile(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(\r?\n|$)", re.S)


def extract_frontmatter(text):
    """Return (yaml_text, body) or (None, whole_text) when no block is present."""
    if not text.startswith("---"):
        return None, text
    m = FM_RE.match(text)
    if not m:
        return None, text
    return m.group(1), text[m.end():]


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
            return tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise ConfigError(f"{path}: {e}")


def _resolve_pack(name, root, script_dir):
    for cand in (os.path.join(root, ".tropo", "packs", name + ".toml"),
                 os.path.join(script_dir, "packs", name + ".toml")):
        if os.path.isfile(cand):
            return cand
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
        _merge_config(composed, _read_toml(_resolve_pack(pack, root, script_dir)))
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


def iter_markdown(root, paths, exclude):
    targets = paths or [root]
    seen = set()
    for target in targets:
        target = os.path.abspath(target)
        if os.path.isfile(target):
            rel = os.path.relpath(target, root)
            if target.endswith((".md", ".markdown")) and not is_excluded(rel, exclude) \
                    and target not in seen:
                seen.add(target)
                yield target, rel
            continue
        for dirpath, dirnames, filenames in os.walk(target):
            reldir = os.path.relpath(dirpath, root)
            reldir = "" if reldir == "." else reldir
            dirnames[:] = sorted(
                d for d in dirnames if not is_excluded(os.path.join(reldir, d), exclude))
            for f in sorted(filenames):
                if not f.endswith((".md", ".markdown")):
                    continue
                rel = os.path.join(reldir, f) if reldir else f
                if is_excluded(rel, exclude):
                    continue
                full = os.path.join(dirpath, f)
                if full not in seen:
                    seen.add(full)
                    yield full, rel


def analyze_file(full, rel, config):
    doc = Doc()
    doc.full, doc.rel = full, rel
    doc.findings, doc.refs, doc.declared, doc.noise = [], [], {}, []
    rel = rel.replace("\\", "/")

    try:
        text = open(full, encoding="utf-8", errors="replace").read()
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
# Commands
# ---------------------------------------------------------------------------

def cmd_check(args, resolver):
    docs = analyze(resolver.root, args.paths, resolver)
    findings = [f for d in docs for f in d.findings]
    if args.strict:
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
        m = FM_RE.match(text)
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


def main(argv=None):
    p = argparse.ArgumentParser(prog="tropo", description="The filesystem is the schema.")
    p.add_argument("--version", action="version", version=f"tropo {__version__}")
    p.add_argument("command", nargs="?", default="check",
                   choices=["check", "signal", "types", "stats", "fix", "init"])
    p.add_argument("paths", nargs="*", help="files or folders (default: whole tree)")
    p.add_argument("--strict", action="store_true", help="treat warnings as errors")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    p.add_argument("--quiet", action="store_true", help="hide warnings")
    p.add_argument("--dry-run", action="store_true", help="fix: preview without writing")
    p.add_argument("--packs", default=None, help="init: comma-separated pack names")
    p.add_argument("--root", default=None, help="tree root (default: walk up for tropo.toml)")
    p.add_argument("--config", default=None, help="explicit tropo.toml path")
    args = p.parse_args(argv)

    if args.command == "init":
        return cmd_init(args)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    if args.config:
        root = args.root or os.path.dirname(os.path.abspath(args.config))
    else:
        start = args.root or (args.paths[0] if args.paths else os.getcwd())
        root = find_root(start)
        if root is None:
            sys.exit(f"tropo: no {CONFIG_NAME} found walking up from {os.path.abspath(start)}")
    try:
        resolver = ConfigResolver(root, script_dir, args.config)
    except ConfigError as e:
        sys.exit(f"tropo: config error: {e}")

    return {"check": cmd_check, "signal": cmd_signal, "types": cmd_types,
            "stats": cmd_stats, "fix": cmd_fix}[args.command](args, resolver)


if __name__ == "__main__":
    sys.exit(main())
