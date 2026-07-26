"""vivary_core: Vivary's governed-context shared seam.

Canonical identity, the frozen ContextIntegrityEvent v0 contract, integrity
receipts, the append-only evidence store + git ref sync, and the capsule
digest. Zero runtime dependencies.

Reference-guided port of the proven Node.js implementation from the
governed-context research program (decision 0008): the Node modules and
their test suite are the executable oracle, and this port is proven
byte-identical on every JSON contract by a cross-language parity harness.
The frozen conformance fixtures travel with this package's tests so the
contract bytes stay pinned here too.
"""

from vivary_core.canonical import (
    canonicalize,
    deterministic_id,
    fingerprint,
    is_absolute_root,
    is_within,
    js_stringify,
    normalize_path,
    sha256_hex,
)

__all__ = [
    "canonicalize",
    "deterministic_id",
    "fingerprint",
    "is_absolute_root",
    "is_within",
    "js_stringify",
    "normalize_path",
    "sha256_hex",
]
