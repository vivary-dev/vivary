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
    is_canonical_absolute_path,
    js_stringify,
    normalize_path,
    sha256_hex,
    path_identity_key,
    utf16_sort_key,
)
from vivary_core.capsule_compile import (
    TASK_CAPSULE_FIELDS,
    CapsuleContentWorkLimitError,
    capsule_compiler_omissions_require_graph,
    compile_task_capsule,
    content_context_work_is_bounded,
)
from vivary_core.receipt import EXECUTION_RECEIPT_FIELDS
from vivary_core.workspace_content import observe_content
from vivary_core.workspace_model import project_workspace_graph
from vivary_core.workspace_observe import observe_checkouts

__all__ = [
    "canonicalize",
    "deterministic_id",
    "fingerprint",
    "is_absolute_root",
    "is_within",
    "js_stringify",
    "is_canonical_absolute_path",
    "normalize_path",
    "sha256_hex",
    "path_identity_key",
    "utf16_sort_key",
    "CapsuleContentWorkLimitError",
    "TASK_CAPSULE_FIELDS",
    "EXECUTION_RECEIPT_FIELDS",
    "capsule_compiler_omissions_require_graph",
    "content_context_work_is_bounded",
    "compile_task_capsule",
    "observe_checkouts",
    "observe_content",
    "project_workspace_graph",
]
