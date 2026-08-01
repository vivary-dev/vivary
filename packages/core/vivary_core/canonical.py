"""Canonical serialization and deterministic identity for Vivary contracts.

Reference-guided Python port of src/lib/canonical.mjs (slice 1, ticket #84,
decision 0008). The Node module is the executable oracle: every function here
must emit byte-identical output to its Node counterpart on the same input.
Where JavaScript semantics leak into the contract bytes (JSON.stringify's
number formatting, string escaping, and UTF-16 code-unit key ordering), this
module replicates those semantics exactly rather than reaching for
json.dumps, which differs in all three.

Language mapping (documented, deliberate):
- JS ``undefined`` has no Python value; its Python analog is an *absent* dict
  key. JS canonicalize drops undefined-valued keys; Python callers simply
  never put the key in.
- JS ``null`` maps to Python ``None``; NaN/Infinity serialize to ``null``
  exactly as JSON.stringify does.
- Dict keys must be ``str`` (JS object keys are always strings); any other
  key type raises TypeError so a translation bug fails loud, never silently.
"""

from __future__ import annotations

import hashlib
import math
import os
import re

# JS String.prototype.trim's exact character set: WhiteSpace (TAB, VT, FF,
# SP, NBSP, ZWNBSP/BOM, Unicode Space_Separator) + LineTerminator (LF, CR,
# LS, PS). Python's str.strip() default set differs (it omits U+FEFF), so the
# set is spelled out.
_JS_TRIM_CHARS = (
    "\t\n\x0b\x0c\r \xa0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)

# JSON.stringify's short escape forms; everything else below 0x20 (and lone
# surrogates, per ES2019 well-formed JSON.stringify) uses \uXXXX lowercase.
_SHORT_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\f": "\\f",
    "\r": "\\r",
}

_REPR_FLOAT = re.compile(r"^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$")

# JS doubles represent integers exactly only within +/-2^53; JSON data that
# round-tripped through JS can never carry a bigger integer exactly, so ints
# beyond that bound are formatted the way JS would format the nearest double.
_MAX_SAFE_INTEGER = 2**53
# Contract bodies must also round-trip through JavaScript without numeric loss.
MAX_LOSSLESS_INTEGER = 2**53 - 1


def _js_string_escape(value: str) -> str:
    out = []
    for ch in value:
        esc = _SHORT_ESCAPES.get(ch)
        if esc is not None:
            out.append(esc)
            continue
        cp = ord(ch)
        if cp < 0x20 or 0xD800 <= cp <= 0xDFFF:
            out.append("\\u%04x" % cp)
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


def _js_float_to_string(x: float) -> str:
    """ECMAScript Number::toString(10) for a finite double.

    Python's repr() produces the same shortest round-trip digits as JS, but
    the two languages switch to exponent notation at different magnitudes
    (Python at 1e16, JS at 1e21); this reformats repr's digits per the
    ECMAScript algorithm.
    """
    if x == 0:
        return "0"  # covers -0.0: JSON.stringify(-0) === "0"
    if x < 0:
        return "-" + _js_float_to_string(-x)
    m = _REPR_FLOAT.match(repr(x))
    if m is None:  # pragma: no cover - repr of a finite positive float always matches
        raise ValueError(f"unexpected float repr: {repr(x)}")
    int_part, frac_part, exp = m.group(1), m.group(2) or "", m.group(3)
    digits = int_part + frac_part
    point = len(int_part) + int(exp or 0)
    stripped = digits.lstrip("0")
    point -= len(digits) - len(stripped)
    digits = stripped.rstrip("0")
    k, n = len(digits), point
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + digits
    exponent = "e+" if n - 1 >= 0 else "e-"
    exponent += str(abs(n - 1))
    if k == 1:
        return digits + exponent
    return digits[0] + "." + digits[1:] + exponent


def _js_number_to_string(value) -> str:
    if isinstance(value, int):
        if -_MAX_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER:
            return str(value)
        try:
            value = float(value)
        except OverflowError:
            return "null"  # JS: the value would be Infinity
    if math.isnan(value) or math.isinf(value):
        return "null"  # JSON.stringify(NaN) === JSON.stringify(Infinity) === "null"
    return _js_float_to_string(value)


def utf16_sort_key(key: str) -> bytes:
    # JS Array.prototype.sort compares strings by UTF-16 code units;
    # big-endian UTF-16 bytes compare identically (surrogatepass keeps lone
    # surrogates comparable too).
    return key.encode("utf-16-be", "surrogatepass")


_ARRAY_INDEX_KEY = re.compile(r"^(?:0|[1-9]\d*)$")


def _js_object_key_order(keys: list[str]) -> list[str]:
    # JS objects iterate integer-like keys (canonical array indices,
    # 0 <= n < 2^32-1) in ascending numeric order FIRST, then the remaining
    # string keys in insertion order. js_stringify must reproduce that or an
    # insertion-ordered dict with a numeric key would serialize differently
    # than the JS reference.
    index_keys = [k for k in keys if _ARRAY_INDEX_KEY.match(k) and int(k) < 2**32 - 1]
    if not index_keys:
        return keys
    rest = [k for k in keys if not (_ARRAY_INDEX_KEY.match(k) and int(k) < 2**32 - 1)]
    return sorted(index_keys, key=int) + rest


def _serialize(value, sort_keys: bool) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _js_string_escape(value)
    if isinstance(value, (int, float)):
        return _js_number_to_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_serialize(item, sort_keys) for item in value) + "]"
    if isinstance(value, dict):
        keys = list(value.keys())
        for key in keys:
            if not isinstance(key, str):
                raise TypeError(f"object keys must be str, got {type(key).__name__}")
        if sort_keys:
            keys.sort(key=utf16_sort_key)
        else:
            keys = _js_object_key_order(keys)
        body = ",".join(
            f"{_js_string_escape(key)}:{_serialize(value[key], sort_keys)}" for key in keys
        )
        return "{" + body + "}"
    raise TypeError(f"cannot canonicalize value of type {type(value).__name__}")


def is_canonical_body_value(value, ancestors=None) -> bool:
    """Return whether a JSON-like body has one lossless canonical representation."""

    value_type = type(value)
    if value is None or value_type in (str, bool):
        return True
    if value_type is int:
        return -MAX_LOSSLESS_INTEGER <= value <= MAX_LOSSLESS_INTEGER
    if value_type is float:
        return math.isfinite(value)
    if value_type not in (list, dict):
        return False
    if ancestors is None:
        ancestors = set()
    identity = id(value)
    if identity in ancestors:
        return False
    ancestors.add(identity)
    try:
        if value_type is list:
            return all(is_canonical_body_value(item, ancestors) for item in value)
        return all(
            type(key) is str and is_canonical_body_value(item, ancestors)
            for key, item in value.items()
        )
    finally:
        ancestors.remove(identity)


def canonicalize(value) -> str:
    """Stable stringify: object keys sorted (UTF-16 code-unit order), arrays
    kept in order, no whitespace. Byte-identical to the Node canonicalize."""
    return _serialize(value, sort_keys=True)


def js_stringify(value) -> str:
    """JS ``JSON.stringify(value)`` (compact, insertion-order keys) - used by
    contract emitters (e.g. the capsule digest) whose bytes are pinned to the
    Node reference's JSON.stringify output, not to canonicalize."""
    return _serialize(value, sort_keys=False)


def sha256_hex(text: str) -> str:
    # Node's hash.update(text, "utf8") replaces lone surrogates with U+FFFD.
    try:
        data = text.encode("utf-8")
    except UnicodeEncodeError:
        data = re.sub(r"[\ud800-\udfff]", "�", text).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def fingerprint(value) -> str:
    """Full-strength fingerprint for capsules, receipts, and workspace state."""
    return f"sha256:{sha256_hex(canonicalize(value))}"


def deterministic_id(kind: str, identity) -> str:
    """Short deterministic ID: kind prefix plus truncated hash of identity fields."""
    return f"{kind}_{sha256_hex(canonicalize(identity))[:16]}"


_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")
_DRIVE_ABSOLUTE = re.compile(r"^[a-z]:/")


def normalize_path(raw_path) -> str:
    """Normalize a Windows/POSIX path into one comparable form: forward
    slashes, lowercased drive letter, no trailing slash. Purely lexical -
    never touches disk."""
    p = str(raw_path).strip(_JS_TRIM_CHARS).replace("\\", "/")
    if _DRIVE_PREFIX.match(p):
        p = p[0].lower() + p[1:]
    if len(p) > 1:
        p = re.sub(r"/+$", "", p)
    return p


def _is_unambiguous_absolute_root(p: str) -> bool:
    # Single-leading-slash POSIX (NOT UNC "//server/share"), or
    # drive-absolute "x:/...". See the Node module's comment for why empty,
    # ".", drive-relative, and UNC roots are out of scope.
    if p.startswith("/"):
        return len(p) < 2 or p[1] != "/"
    return _DRIVE_ABSOLUTE.match(p) is not None


def _has_dot_dot_segment(p: str) -> bool:
    return ".." in p.split("/")


def _collapse_absolute_dot_segments(p: str) -> str:
    # Lexically collapse "." and ".." in a string the caller has already
    # established to be an unambiguous absolute path. Over-popping clamps at
    # the anchor; the caller re-checks the boundary afterward, so that can
    # only ever tighten the result.
    drive = p[:2] if _DRIVE_ABSOLUTE.match(p) else ""
    rest = p[2:] if drive else p  # always starts with "/" here
    out: list[str] = []
    for seg in rest.split("/"):
        if seg == "" or seg == ".":
            continue
        if seg == "..":
            if out:
                out.pop()
            continue
        out.append(seg)
    return drive + "/" + "/".join(out)


def is_absolute_root(raw_path) -> bool:
    """Is this string usable at all as an allowlist ROOT entry? POSIX
    absolute (including UNC), or drive-absolute. Rejects empty/whitespace,
    ".", relative, and drive-relative entries (closes the #71 empty-entry
    wildcard at the allowlist layer). Never changes is_within's semantics."""
    if not isinstance(raw_path, str):
        return False
    p = normalize_path(raw_path)
    if len(p) == 0:
        return False
    if p.startswith("/"):
        return True  # POSIX absolute, or UNC "//server/share"
    return _DRIVE_ABSOLUTE.match(p) is not None


def is_within(root, child) -> bool:
    """True when `child` equals `root` or sits beneath it (separator-boundary
    safe). STRICTLY NARROWING by construction (ticket #61): starts from the
    exact pre-#61 lexical prefix baseline and may only additionally REFUSE a
    baseline-true result - for a ".."-bearing child under an unambiguous
    absolute root, the ".." segments are collapsed and the boundary
    re-checked. Never changes the result for a child with no ".." segment."""
    r = normalize_path(root)
    c = normalize_path(child)
    baseline = c == r or c.startswith(r + "/")
    if not baseline:
        return False
    if not _has_dot_dot_segment(c):
        return True
    if not _is_unambiguous_absolute_root(r):
        return True

    collapsed_root = _collapse_absolute_dot_segments(r)
    collapsed_child = _collapse_absolute_dot_segments(c)
    return collapsed_child == collapsed_root or collapsed_child.startswith(collapsed_root + "/")


def _fold_path_case(path) -> str:
    """Lowercase a path where the platform's filesystem is case-insensitive.

    Kept separate from `normalize_path`, which lowercases only the drive letter and
    whose output is used for reporting — a refusal record should still echo the
    path the caller actually passed.
    """
    return path.lower() if os.name == "nt" and isinstance(path, str) else path


def is_within_allowlist(root, child) -> bool:
    """`is_within`, but case-insensitive on Windows.

    On Windows `C:/Repo` and `c:/repo` are the same directory, so a case-sensitive
    comparison refused legitimate checkouts — either because the caller's allowlist
    casing differed from the path they passed, or because Git reported canonical
    casing back that differed from the caller's input, which tripped the
    post-resolution re-check.

    Case folding is applied to both sides before delegating, so `is_within`'s
    separator-boundary and `..`-collapsing behaviour is inherited unchanged: this
    widens *only* the character comparison, and only where the filesystem already
    treats those paths as identical. On POSIX it is exactly `is_within`.
    """
    return is_within(_fold_path_case(root), _fold_path_case(child))
