"""Direct pins for vivary_core/canonical.py -- the untested-in-Python
foundation everything else leans on. is_within is the allowlist security
boundary (workspace observation, MCP roots, control scopes); canonicalize
feeds every fingerprint; deterministic_id feeds every node id.

Translation of tests/canonical.test.mjs (ticket #61's Node pins) against the
already-ported, parity-proven python/vivary_core/canonical.py. See ticket #84.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY_ROOT = os.path.dirname(HERE)
sys.path.insert(0, PY_ROOT)
import vivary_core  # noqa: E402

from vivary_core.canonical import (  # noqa: E402
    canonicalize,
    deterministic_id,
    fingerprint,
    is_absolute_root,
    is_within,
    normalize_path,
    sha256_hex,
    utf16_sort_key,
)
from vivary_core.capsule_compile import TASK_CAPSULE_FIELDS  # noqa: E402
from vivary_core.receipt import EXECUTION_RECEIPT_FIELDS  # noqa: E402


def test_public_core_exports_own_artifact_fields_and_utf16_ordering():
    assert vivary_core.TASK_CAPSULE_FIELDS is TASK_CAPSULE_FIELDS
    assert vivary_core.EXECUTION_RECEIPT_FIELDS is EXECUTION_RECEIPT_FIELDS
    assert vivary_core.utf16_sort_key is utf16_sort_key

# ---------------------------------------------------------------------------
# normalize_path
# ---------------------------------------------------------------------------


def test_normalize_path_lowercases_the_drive_letter_only():
    assert normalize_path("C:/Users/a") == "c:/Users/a"
    assert normalize_path("c:/Users/a") == "c:/Users/a"
    # Only the drive letter is case-folded — the rest of the path body is left
    # untouched. Documented current behavior, not necessarily desired: a path
    # whose body differs only in case is NOT treated as the same path.
    assert normalize_path("C:/USERS/a") == "c:/USERS/a"


def test_normalize_path_backslashes_become_forward_slashes():
    assert normalize_path("C:\\Users\\a\\b") == "c:/Users/a/b"


def test_normalize_path_trailing_slash_is_removed_but_not_down_to_empty():
    assert normalize_path("/foo/bar/") == "/foo/bar"
    assert normalize_path("/foo/bar///") == "/foo/bar"  # one collapse of the run
    assert normalize_path("/") == "/"  # length 1: kept, never stripped to ""


def test_normalize_path_unc_paths_are_lexically_converted_drive_letter_rule_does_not_apply():
    assert normalize_path("\\\\server\\share\\dir") == "//server/share/dir"
    assert normalize_path("\\\\server\\share\\dir\\") == "//server/share/dir"


def test_normalize_path_idempotent_on_an_input_normalization_actually_changes():
    # A raw path that normalization DOES rewrite (backslashes, upper drive,
    # trailing slash) - so the second application is a real re-test of
    # idempotence, not a tautology over an already-fixed point.
    raw = "C:\\Users\\A\\B\\"
    once = normalize_path(raw)
    assert once != raw, "precondition: normalization must change this input"
    # Drive letter is folded; the path body case is preserved (characterized).
    assert once == "c:/Users/A/B"
    assert normalize_path(once) == once


def test_normalize_path_unicode_path_segments_pass_through_untouched_no_nfc_nfd_folding():
    assert normalize_path("/héllo/wörld/") == "/héllo/wörld"
    # Combining-form vs precomposed form are NOT unified — documented as-is.
    # The two strings below use different underlying code points — U+00E9
    # precomposed vs. "e" + U+0301 combining — even though they render
    # identically; a sanity assertion below confirms they are distinct.
    precomposed = "/café"  # é as one code point
    combining = "/café"  # e + combining acute accent
    assert precomposed != combining, "sanity: source strings are distinct code-point sequences"
    assert normalize_path(precomposed) != normalize_path(combining)


def test_normalize_path_empty_string_is_passed_through_as_empty_string():
    assert normalize_path("") == ""
    assert normalize_path("   ") == ""  # trimmed first


def test_normalize_path_does_not_resolve_lexical_traversal_segments():
    # Purely lexical per the module comment: `..` is never resolved against the
    # filesystem or the string itself.
    assert normalize_path("/foo/../etc/passwd") == "/foo/../etc/passwd"
    assert normalize_path("/foo/./bar") == "/foo/./bar"


# ---------------------------------------------------------------------------
# is_within — the allowlist security boundary
# ---------------------------------------------------------------------------


def test_is_within_exact_equal_root_is_within_itself():
    assert is_within("/foo", "/foo") is True


def test_is_within_separator_boundary_safety_foo_does_not_admit_foobar_both_directions():
    assert is_within("/foo", "/foobar") is False
    assert is_within("/foobar", "/foo") is False
    # A real child is fine.
    assert is_within("/foo", "/foo/bar") is True


def test_is_within_trailing_slashes_on_either_or_both_sides_do_not_change_the_result():
    assert is_within("/foo/", "/foo/bar") is True
    assert is_within("/foo", "/foo/bar/") is True
    assert is_within("/foo/", "/foo/") is True


def test_is_within_mixed_separators_normalize_before_comparison():
    assert is_within("C:\\Users\\a", "C:/Users/a/b") is True
    assert is_within("C:/Users/a", "C:\\Users\\a\\b") is True


def test_is_within_drive_letter_case_is_folded_path_body_case_is_not():
    assert is_within("C:/Users/a", "c:/Users/a/b") is True
    # Path-body case sensitivity is current, documented behavior — a root and
    # child that differ in body case are NOT considered related.
    assert is_within("/Foo", "/foo/bar") is False


def test_is_within_unc_paths_compare_as_ordinary_normalized_strings():
    assert is_within("\\\\server\\share", "\\\\server\\share\\sub") is True
    assert is_within("\\\\server\\share", "\\\\server\\shareX") is False


def test_is_within_unicode_path_segments():
    assert is_within("/wörkspace", "/wörkspace/child") is True
    assert is_within("/wörkspace", "/workspace/child") is False


def test_is_within_fixed_defect_regression_pin_lexical_dotdot_traversal_can_no_longer_escape_an_unambiguous_absolute_root():
    # FOUND BY TICKET #61: is_within used to never resolve `..`. Because
    # normalize_path is purely lexical (by design — it never touches disk), a
    # child path containing a literal `..` segment could satisfy the
    # startswith(root + "/") string test even though the path it lexically
    # denotes is NOT beneath root. is_within is the allowlist security
    # boundary for workspace observation and control scopes, so this was a
    # reachable bypass, not just a theoretical one.
    assert is_within("/foo", "/foo/../etc/passwd") is False, "no longer escapes the root"
    assert is_within("/foo", "/foo/bar/../../etc/passwd") is False, "no longer escapes the root"
    # A `..` segment that stays lexically beneath the prefix is still fine —
    # this is a control case, not evidence of the fix.
    assert is_within("/foo", "/foo/bar/../baz") is True
    assert is_within("/foo", "/foo/../foo/bar") is True


# ---------------------------------------------------------------------------
# is_within — strictly-narrowing regression pins (ticket #61 rework)
#
# An adversarial (Codex) review of the first traversal fix found it was NOT
# strictly narrowing: it independently recomputed a "collapsed" form for BOTH
# root and child on every call, rather than gating on the pre-#61 baseline
# result, so it changed results (in both directions) for shapes of root the
# first pass never should have touched. The corrected design in canonical.py
# (see is_within's docstring) starts every call from `baseline` - EXACTLY the
# pre-#61 `c == r or c.startswith(r + "/")` check - and may only ever turn a
# `baseline is True` result into `False`. Every case below is a regression
# the first pass got wrong; each is pinned against a baseline computed
# directly from the pre-#61 algorithm, not against intuition.
# ---------------------------------------------------------------------------


def test_is_within_relative_empty_roots_never_admit_an_unrelated_child_just_because_a_dotdot_segment_is_present():
    # dev (pre-#61): is_within(".", "/outside") -> False (root "." never
    # matches an absolute child at all). Root "." is not an unambiguous
    # absolute root, so a "/outside" child (no ".." even needed to trigger
    # the bug) must fall through to the baseline unchanged.
    assert is_within(".", "/outside") is False, "must match dev's baseline exactly"
    assert is_within(".", "/outside/../etc") is False, "still must match the baseline even with a `..` present"

    # Separately, and NOT a regression: dev's pre-#61 baseline for an EMPTY
    # root already returns True for any absolute child, because `` + "/" is
    # just "/", which every absolute path starts with. Pre-existing quirk,
    # out of scope for the `..` fix.
    assert is_within("", "/outside") is True, "pre-existing dev quirk (empty root = wildcard); out of scope, not a regression"


def test_is_within_a_drive_relative_root_c_colon_foo_is_never_treated_as_drive_absolute():
    # dev (pre-#61): is_within("C:allowed", "C:\\allowed\\evil") -> False,
    # because normalize_path turns them into "c:allowed" and
    # "c:/allowed/evil" respectively, and "c:/allowed/evil" does not start
    # with "c:allowed/" as a string. Only a root with "/" immediately after
    # the drive letter is treated as absolute; "c:allowed" is not, so this
    # falls through to the (refusing) baseline unchanged.
    assert is_within("C:allowed", "C:\\allowed\\evil") is False, "must match dev's baseline exactly"


def test_is_within_unc_roots_fall_through_to_devs_exact_original_comparison_no_independent_unc_handling():
    # UNC ("//server/share") is explicitly out of scope for this ticket's `..`
    # handling. Both characterized breaks the first pass introduced here are
    # resolved simply by not touching UNC roots at all and deferring entirely
    # to the baseline:
    assert is_within("\\\\server\\share", "\\server\\share\\child") is False, (
        "single-backslash root-relative child is not conflated with the UNC root (matches dev's baseline)"
    )
    assert is_within("\\\\server\\share", "\\\\server\\share\\folder\\..\\..\\folder\\file") is True, (
        "dev's baseline already treats this as a literal-string prefix match and admits it; "
        "the first fix pass wrongly refused it by popping the UNC share segment itself"
    )


def test_is_within_no_dotdot_children_under_c_drive_dot_and_slash_roots_are_untouched_match_devs_baseline_exactly():
    # All three reproduced directly from the pre-#61 algorithm. None of these
    # are `..`-related; they exist purely to prove the narrowing gate does
    # not fire when it has no business firing.
    assert is_within("c:/", "c:/foo") is True, "must match dev's baseline exactly"
    assert is_within(".", "./legit") is True, "must match dev's baseline exactly"
    # "/" is a separate, pre-existing dev quirk (root "/" + "/" = "//", which
    # essentially no single-leading-slash child ever starts with) - not
    # introduced by this ticket, and left exactly as-is.
    assert is_within("/", "/legit") is False, "pre-existing dev quirk; out of scope, not a regression"


# ---------------------------------------------------------------------------
# is_absolute_root — allowlist ENTRY validity (ticket #71)
# ---------------------------------------------------------------------------


def test_is_absolute_root_rejects_empty_and_whitespace_only_strings_closes_the_71_wildcard_at_the_entry_validation_layer():
    assert is_absolute_root("") is False
    assert is_absolute_root("   ") is False
    assert is_absolute_root("\t\n") is False


def test_is_absolute_root_rejects_relative_and_drive_relative_paths():
    assert is_absolute_root(".") is False
    assert is_absolute_root("./foo") is False
    assert is_absolute_root("foo/bar") is False
    assert is_absolute_root("../escape") is False
    assert is_absolute_root("C:allowed") is False, "drive-relative, not drive-absolute"


def test_is_absolute_root_accepts_a_posix_absolute_path():
    assert is_absolute_root("/foo/bar") is True
    assert is_absolute_root("/") is True


def test_is_absolute_root_accepts_a_drive_absolute_windows_path_in_either_separator_style_case_insensitively_on_the_drive_letter():
    assert is_absolute_root("C:/Users/a") is True
    assert is_absolute_root("c:\\Users\\a") is True


def test_is_absolute_root_accepts_a_unc_root():
    assert is_absolute_root("\\\\server\\share") is True
    assert is_absolute_root("//server/share") is True


def test_is_absolute_root_rejects_non_string_input_without_throwing():
    assert is_absolute_root(None) is False
    assert is_absolute_root(42) is False


def test_is_absolute_root_never_mutates_or_changes_normalize_paths_own_behavior_for_the_same_input():
    # Direct regression pin per the packet's stop condition: this helper must
    # not touch is_within/normalize_path's pure lexical semantics. It is
    # purely additive - proven here by checking normalize_path's output is
    # unaffected by is_absolute_root having been called on the same input
    # first.
    before_ = normalize_path("/foo/../bar")
    is_absolute_root("/foo/../bar")
    assert normalize_path("/foo/../bar") == before_


# ---------------------------------------------------------------------------
# canonicalize
# ---------------------------------------------------------------------------


def test_canonicalize_object_keys_are_sorted_regardless_of_insertion_order():
    assert canonicalize({"b": 1, "a": 2}) == canonicalize({"a": 2, "b": 1})
    assert canonicalize({"b": 1, "a": 2}) == '{"a":2,"b":1}'


def test_canonicalize_arrays_are_not_sorted_element_order_is_preserved():
    assert canonicalize([3, 1, 2]) == "[3,1,2]"
    assert canonicalize({"a": [3, 1, 2]}) == '{"a":[3,1,2]}'
    assert canonicalize([1, 2, 3]) != canonicalize([3, 2, 1])


def test_canonicalize_absent_keys_are_dropped_null_is_kept():
    # ADAPTATION: JS `undefined` has no Python value; its analog is an absent
    # dict key. The Node fixture `{ a: 1, b: undefined, c: null }` becomes
    # simply not including "b" here, and `{ a: undefined }` becomes `{}`.
    assert canonicalize({"a": 1, "c": None}) == '{"a":1,"c":null}'
    assert canonicalize({}) == "{}"


def test_canonicalize_nan_and_infinity_serialize_to_null_json_stringify_semantics_pinned_as_is():
    assert canonicalize(float("nan")) == "null"
    assert canonicalize(float("inf")) == "null"
    assert canonicalize(float("-inf")) == "null"
    assert canonicalize({"a": float("nan"), "b": float("inf"), "c": float("-inf")}) == '{"a":null,"b":null,"c":null}'


def test_canonicalize_nested_depth_is_walked_recursively_with_sorting_at_every_level():
    value = {"z": {"b": 1, "a": {"d": 2, "c": [1, {"y": 1, "x": 2}]}}, "a": 1}
    assert canonicalize(value) == '{"a":1,"z":{"a":{"c":[1,{"x":2,"y":1}],"d":2},"b":1}}'


def test_canonicalize_empty_object_and_empty_array():
    assert canonicalize({}) == "{}"
    assert canonicalize([]) == "[]"
    assert canonicalize({"a": [], "b": {}}) == '{"a":[],"b":{}}'


def test_canonicalize_primitives_round_trip_through_json_stringify():
    assert canonicalize("x") == '"x"'
    assert canonicalize(1) == "1"
    assert canonicalize(True) == "true"
    assert canonicalize(None) == "null"


# ---------------------------------------------------------------------------
# deterministic_id
# ---------------------------------------------------------------------------


def test_deterministic_id_shape_is_kind_16hex():
    id_ = deterministic_id("checkout", {"path": "/foo"})
    assert re.match(r"^checkout_[0-9a-f]{16}$", id_)


def test_deterministic_id_same_input_yields_the_same_id():
    a = deterministic_id("checkout", {"path": "/foo", "rev": "abc"})
    b = deterministic_id("checkout", {"path": "/foo", "rev": "abc"})
    assert a == b


def test_deterministic_id_same_identity_different_kind_different_id_prefix_differs_hash_body_identical():
    identity = {"path": "/foo"}
    a = deterministic_id("checkout", identity)
    b = deterministic_id("repository", identity)
    assert a != b
    # Documented: the hash body is computed over `identity` alone, so the only
    # thing distinguishing the two ids is the kind prefix — the 16-hex bodies
    # are identical here. Kind is not folded into the hashed payload.
    assert a.split("_")[1] == b.split("_")[1]


def test_deterministic_id_16hex_truncation_near_identical_payloads_still_differ_avalanche_not_a_guarantee():
    # sha256_hex produces 64 hex chars; deterministic_id keeps only the first
    # 16 (64 bits). That is a real, intentional collision space — pinned here
    # as a known property, not a guarantee that no two distinct payloads can
    # ever collide.
    a = deterministic_id("checkout", {"path": "/foo", "n": 1})
    b = deterministic_id("checkout", {"path": "/foo", "n": 2})
    assert a != b
    ids_only = [x.split("_")[1] for x in (a, b)]
    assert ids_only[0] != ids_only[1]


# ---------------------------------------------------------------------------
# fingerprint
# ---------------------------------------------------------------------------


def test_fingerprint_stable_across_key_order():
    assert fingerprint({"a": 1, "b": 2}) == fingerprint({"b": 2, "a": 1})


def test_fingerprint_sensitive_to_any_value_change():
    assert fingerprint({"a": 1}) != fingerprint({"a": 2})


def test_fingerprint_shape_is_sha256_64hex():
    assert re.match(r"^sha256:[0-9a-f]{64}$", fingerprint({"a": 1}))


def test_sha256_hex_matches_canonicalize_plus_fingerprint_composition():
    value = {"a": 1, "b": [1, 2]}
    assert fingerprint(value) == f"sha256:{sha256_hex(canonicalize(value))}"
