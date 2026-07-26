"""Tests for scripts/check_package_docs_parity.py.

That guard is a required CI check, so it needs its own coverage. Its bullet parser is
the fragile part: the PyPI line is prose that wraps, so reading only the first physical
line would silently report documented packages as missing and redden CI on a correct
doc. These tests pin the wrapping behaviour and every documented-list failure branch.

The expected package set is derived from the manifests here too, so adding a package
does not require editing this file.
"""
import importlib.util
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GUARD = ROOT / "scripts" / "check_package_docs_parity.py"
REAL_DOC = ROOT / "docs" / "ARCHITECTURE.md"


def _load():
    """A fresh module instance, pinned to absolute paths so cwd does not matter."""
    spec = importlib.util.spec_from_file_location("package_docs_parity", GUARD)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.PACKAGES = ROOT / "packages"
    module.ARCHITECTURE = REAL_DOC
    return module


def _run(doc_text=None, *, unpublished=None):
    """Run the guard. Returns None when it passes, else the SystemExit message."""
    module = _load()
    if unpublished is not None:
        module.UNPUBLISHED = unpublished

    if doc_text is None:
        try:
            module.main()
        except SystemExit as exc:
            return str(exc)
        return None

    with tempfile.TemporaryDirectory() as tmp:
        fake = Path(tmp) / "ARCHITECTURE.md"
        fake.write_text(doc_text, encoding="utf-8")
        module.ARCHITECTURE = fake
        try:
            module.main()
        except SystemExit as exc:
            return str(exc)
    return None


def _published():
    module = _load()
    return sorted(module.declared_distributions() - module.UNPUBLISHED)


def _doc(bullet: str) -> str:
    """A minimal namespace section containing exactly one PyPI bullet."""
    return (
        "## Naming & namespace\n"
        "\n"
        "The brand owns the namespace; current package truth is:\n"
        "\n"
        "- npm: `@vivary/create` — the launcher for the scaffolder.\n"
        f"{bullet}"
        "- `strato` is bundled source/templates, not a published package.\n"
        "- GitHub: `vivary-dev/vivary` holds the public repo.\n"
    )


def _one_line(names) -> str:
    return "- PyPI: " + ", ".join(f"`{name}`" for name in names) + ".\n"


def test_real_architecture_doc_passes_and_is_not_modified():
    before = REAL_DOC.read_bytes()
    message = _run()
    assert message is None, f"the committed doc should pass, got: {message}"
    assert REAL_DOC.read_bytes() == before, "the guard must never modify the doc"


def test_single_line_bullet_is_read():
    assert _run(_doc(_one_line(_published()))) is None


def test_wrapped_bullet_is_read_in_full():
    # The regression this pins: names on continuation lines must count. Reading only
    # the first physical line would report every wrapped name as missing.
    names = _published()
    assert len(names) > 2, "need several packages for wrapping to be meaningful"

    bullet = f"- PyPI: `{names[0]}`,\n"
    for name in names[1:]:
        bullet += f"  `{name}`,\n"
    bullet += "  and that is the whole published set.\n"

    message = _run(_doc(bullet))
    assert message is None, f"a wrapped bullet must be read in full, got: {message}"


def test_listing_an_unpublished_distribution_fails():
    module = _load()
    unpublished = sorted(module.UNPUBLISHED)
    assert unpublished, "UNPUBLISHED must be non-empty for this test to mean anything"

    message = _run(_doc(_one_line(_published() + unpublished)))
    assert message, "listing an unpublished distribution must fail"
    assert "unpublished distributions" in message, message
    assert unpublished[0] in message, message


def test_dropping_a_published_distribution_fails():
    names = _published()
    dropped, kept = names[0], names[1:]

    message = _run(_doc(_one_line(kept)))
    assert message, "omitting a published distribution must fail"
    assert "missing from the PyPI list" in message, message
    assert dropped in message, message


def test_naming_an_unknown_distribution_fails():
    message = _run(_doc(_one_line(_published() + ["vivary-not-a-package"])))
    assert message, "naming a distribution with no manifest must fail"
    assert "no manifest" in message, message
    assert "vivary-not-a-package" in message, message


def test_more_than_one_pypi_bullet_fails():
    bullet = _one_line(_published())
    message = _run(_doc(bullet + bullet))
    assert message, "an ambiguous doc with two PyPI bullets must fail"
    assert "expected exactly one" in message, message


def test_no_pypi_bullet_fails():
    message = _run(_doc(""))
    assert message, "a doc with no PyPI bullet must fail rather than pass vacuously"
    assert "expected exactly one" in message, message


def test_stale_unpublished_allowlist_fails():
    # An allowlist entry with no manifest means the allowlist outlived its package.
    message = _run(_doc(_one_line(_published())), unpublished={"vivary-ghost"})
    assert message, "an allowlist naming a non-existent manifest must fail"
    assert "no manifest" in message, message
    assert "vivary-ghost" in message, message


def test_core_is_allowlisted_as_unpublished():
    # Pins the #221 decision: vivary-core stays unpublished during development and ships
    # only in the final comprehensive coordinated release train. Publishing it means
    # removing it here deliberately, which then requires the architecture doc to name it.
    module = _load()
    assert "vivary-core" in module.UNPUBLISHED


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok  {fn.__name__}")
            passed += 1
        except Exception as e:
            print(f"FAIL  {fn.__name__}: {e}")
    print(f"\n{passed}/{len(fns)} passed")
    sys.exit(0 if passed == len(fns) else 1)
