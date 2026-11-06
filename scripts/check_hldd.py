"""Require the canonical design document to travel with relevant changes."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parent.parent
DOCUMENT = "docs/ARCHITECTURE.md"
HEADINGS = (
    "Purpose and owner intent",
    "Success criteria",
    "System structure",
    "Runtime flows",
    "Data and trust boundaries",
    "Delivery and known gaps",
    "Maintaining this document",
    "Last change review",
)
DEPENDABOT = "dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>"
DEPENDENCY_MAPS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
# npm reads a value as a version only when it parses as a semver range. It reads anything else as a tag,
# a local path or tarball, or a source such as git or a URL. This follows node-semver's range grammar.
NPM_NUMBER = r"(?:[xX*]|0|[1-9]\d*)"
NPM_IDENTIFIERS = r"[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*"
NPM_PARTIAL = rf"v?{NPM_NUMBER}(?:\.{NPM_NUMBER}(?:\.{NPM_NUMBER}(?:-{NPM_IDENTIFIERS})?(?:\+{NPM_IDENTIFIERS})?)?)?"
NPM_COMPARATOR = rf"(?:(?:<=|>=|<|>|=|~>?|\^)\s*)?{NPM_PARTIAL}"
NPM_RANGE = rf"(?:{NPM_PARTIAL}\s+-\s+{NPM_PARTIAL}|{NPM_COMPARATOR}(?:\s+{NPM_COMPARATOR})*)"
NPM_RANGE_SET = re.compile(rf"\s*{NPM_RANGE}(?:\s*\|\|\s*{NPM_RANGE})*\s*")
SPECIFIER = r"(?:===|~=|==|!=|<=|>=|<|>)\s*[\w.*+!-]+"
SPECIFIERS = rf"{SPECIFIER}(?:\s*,\s*{SPECIFIER})*"
REQUIREMENT = re.compile(
    r"\s*(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)\s*(?P<extras>\[[^\]]*\])?\s*"
    rf"(?:{SPECIFIERS}|\(\s*{SPECIFIERS}\s*\))?\s*(?P<marker>;.*)?",
    re.S,
)
# A ref can name a branch, tag, or commit, so only a release tag shape or a full commit SHA counts as a version.
ACTION_TAG = r"v?\d+(?:\.\d+){0,2}"
# GitHub Actions resolves commits by 40-character SHA-1 ids. A longer hex string can only be a branch or tag.
ACTION_SHA = r"[0-9a-f]{40}"
ACTION_REF = rf"(?:{ACTION_TAG}|{ACTION_SHA})"
# The ref and its version comment must look like versions, since a uses: line inside a run: heredoc is shell text.
USES = re.compile(
    r"(?P<action>\s*(?:-\s+)?uses:\s*['\"]?[\w.-]+/[\w.-]+(?:/[^@\s'\"#]*)?)"
    rf"@(?P<ref>{ACTION_REF})['\"]?(?:\s+#\s*{ACTION_REF})?\s*"
)


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *args], cwd=ROOT, input=None, capture_output=True, check=check,
        env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
    )


def text_at(revision: str | None) -> str:
    if revision is None:
        return ""
    target = f"{revision}:{DOCUMENT}" if revision != ":" else f":{DOCUMENT}"
    result = git("show", target, check=False)
    if result.returncode:
        raise ValueError(f"Cannot read {DOCUMENT} from {revision}. Restore the canonical HLDD.")
    return result.stdout.decode("utf-8")


def relevant(path: str) -> bool:
    if not path or path == DOCUMENT:
        return False
    if path.startswith("site/src/content/docs/") or path in {
        "site/public/llms.txt", "site/public/llms-full.txt",
    }:
        return False  # Generated from canonical docs and checked by site sync.
    parts = Path(path).parts
    if any(part in {"tests", "__tests__", "__snapshots__", "fixtures"} for part in parts):
        return False
    return True


def substantive(text: str) -> str:
    # Dates, whitespace, and comments alone do not document a design review.
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = re.sub(r"(?<![A-Za-z0-9])\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?(?![A-Za-z0-9])", "", text)
    # A removed date can leave an otherwise empty Markdown bullet or emphasis.
    lines = (line for line in text.splitlines() if any(char.isalnum() for char in line))
    return re.sub(r"\s+", "", "\n".join(lines))


def visible_prose(text: str) -> str:
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    fence: tuple[str, int] | None = None
    result = []
    for line in text.splitlines():
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if marker:
            delimiter, suffix = marker.groups()
            if fence is None:
                fence = (delimiter[0], len(delimiter))
            elif delimiter[0] == fence[0] and len(delimiter) >= fence[1] and not suffix.strip():
                fence = None
            continue
        if fence is None:
            result.append(line)
    return "\n".join(result)


def validate_document(text: str) -> None:
    sections = re.split(r"(?m)^## ", visible_prose(text))
    found = {}
    for section in sections[1:]:
        title, _, body = section.partition("\n")
        if title in found:
            raise ValueError(f"Duplicate HLDD section: {title}")
        found[title] = body
    for heading in HEADINGS:
        if not substantive(found.get(heading, "")):
            raise ValueError(f"HLDD needs a nonempty '## {heading}' section.")


def check_change(before: str | None, after: str, *, staged: bool = False) -> None:
    args = ["diff", "--name-only", "--no-renames", "-z"]
    if staged:
        args.append("--cached")
        if before:
            args.append(before)
    elif before:
        args.extend([before, after])
    else:
        args = ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", after]
    changed = git(*args).stdout.decode("utf-8").split("\0")
    current = text_at(":" if staged else after)
    validate_document(current)
    impact = [path for path in changed if relevant(path)]
    if not impact:
        return
    previous = text_at(before) if before else ""
    if substantive(current) == substantive(previous):
        sample = ", ".join(impact[:4])
        raise ValueError(
            f"HLDD review missing for {sample}. Update {DOCUMENT} in the same commit. "
            "If the design is unchanged, explain the concrete change and why the existing "
            "description still holds in Last change review. Stage that update. "
            "Read .agents/skills/maintain-hldd/SKILL.md."
        )


def unique_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    # npm keeps the last duplicate, so an earlier one would hide a change from review.
    if len({key for key, _ in pairs}) != len(pairs):
        raise ValueError("Duplicate JSON key")
    return dict(pairs)


def npm_version(value: object) -> bool:
    return isinstance(value, str) and NPM_RANGE_SET.fullmatch(value) is not None


def package_manifest(text: str) -> object:
    manifest = json.loads(text, object_pairs_hook=unique_keys)
    for field in DEPENDENCY_MAPS:
        entries = manifest.get(field)
        if isinstance(entries, dict):
            manifest[field] = {
                name: "VERSION" if npm_version(value) else value for name, value in entries.items()
            }
    return manifest


def requirement(entry: object) -> object:
    if not isinstance(entry, str) or "@" in entry:
        return entry
    match = REQUIREMENT.fullmatch(entry)
    if not match:
        raise ValueError(f"Unrecognized requirement: {entry}")
    return (match["name"], re.sub(r"\s+", "", match["extras"] or ""), (match["marker"] or "").strip())


def python_project(text: str) -> object:
    data = tomllib.loads(text)
    project = data.get("project", {})
    lists = [(data.get("build-system", {}), "requires"), (project, "dependencies")]
    for table in (project.get("optional-dependencies", {}), data.get("dependency-groups", {})):
        lists.extend((table, name) for name in table)
    for table, name in lists:
        if isinstance(table.get(name), list):
            table[name] = [requirement(entry) for entry in table[name]]
    return data


def workflow(text: str) -> list[str]:
    # Keep the ref's kind, so replacing an immutable SHA pin with a moving tag is not a version-only change.
    lines = []
    for line in text.splitlines():
        if match := USES.fullmatch(line):
            kind = "sha" if re.fullmatch(ACTION_SHA, match["ref"]) else "tag"
            line = f"{match['action']}@{kind}"
        lines.append(line)
    return lines


# Each normalizer removes version information, so equal results mean only versions changed.
# Lockfile content is not inspected. The dependency review in CONTRIBUTING.md covers what a lockfile brings in.
DEPENDENCY_FILES = (
    (lambda path: path.name in {"package-lock.json", "pnpm-lock.yaml"}, lambda text: None),
    (lambda path: path.name == "package.json", package_manifest),
    (lambda path: path.name == "pyproject.toml", python_project),
    (lambda path: str(path.parent) == ".github/workflows" and path.suffix in {".yml", ".yaml"}, workflow),
)


def tree_entry(revision: str, path: str) -> list[str]:
    # Mode, type, and object id, or an empty list when the path is absent.
    listing = git("ls-tree", "-z", revision, "--", path).stdout.decode("utf-8")
    return listing.partition("\t")[0].split()


def version_only(path: str, before: str, after: str) -> bool:
    normalize = next((normalize for rule, normalize in DEPENDENCY_FILES if rule(PurePosixPath(path))), None)
    if normalize is None:
        return False
    entries = [tree_entry(revision, path) for revision in (before, after)]
    if any(entry[:2] != ["100644", "blob"] for entry in entries):
        return False  # An added, deleted, executable, or non-file entry is never a version-only change.
    try:
        old, new = (normalize(git("cat-file", "blob", entry[2]).stdout.decode("utf-8")) for entry in entries)
        # Canonical JSON keeps false and 0 apart, which Python equality does not.
        return json.dumps(old, sort_keys=True) == json.dumps(new, sort_keys=True)
    except (ValueError, TypeError, AttributeError, RecursionError):
        return False  # A file that does not parse as its expected shape is never version-only.


def carried(path: str, revision: str, first: str, merged: list[str], judged: set[str], ancestor: str) -> bool:
    # Only the merged side changed the path since some merge base. Its commits off the base branch must be judged.
    entry = tree_entry(revision, path)
    for parent in merged:
        bases = git("merge-base", "--all", first, parent, check=False).stdout.decode().split()
        if tree_entry(parent, path) == entry and any(
            tree_entry(base, path) == tree_entry(first, path)
            and set(git("rev-list", parent, f"^{base}", f"^{ancestor}").stdout.decode().split()) <= judged
            for base in bases
        ):
            return True
    return False


def dependency_update(revision: str, parents: list[str], judged: set[str], ancestor: str) -> bool:
    if not parents:
        return False
    first, merged = parents[0], parents[1:]
    # Git author identity is self-asserted. The exemption still only covers version-only dependency changes.
    if not merged and git("log", "-1", "--format=%an <%ae>", revision).stdout.decode().strip() != DEPENDABOT:
        return False
    if tree_entry(first, DOCUMENT) != tree_entry(revision, DOCUMENT):
        return False  # A commit that edits the HLDD is not dependency-only, so the normal check judges it.
    changed = git("diff", "--name-only", "--no-renames", "-z", first, revision).stdout.decode("utf-8")
    impact = [path for path in changed.split("\0") if relevant(path)]
    return bool(impact) and all(
        version_only(path, first, revision) and (not merged or carried(path, revision, first, merged, judged, ancestor))
        for path in impact
    )


def commit(ref: str) -> str:
    return git("rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}").stdout.decode().strip()


def has_gate(revision: str) -> bool:
    return git("cat-file", "-e", f"{revision}:scripts/check_hldd.py", check=False).returncode == 0


def check_range(base: str, head: str) -> tuple[int, int]:
    end = commit(head)
    if not base or set(base) == {"0"}:
        raise ValueError("A nonzero base commit is required. Supply the reviewed branch baseline.")
    start = commit(base)
    ancestor = git("merge-base", start, end).stdout.decode().strip()
    revisions = git("rev-list", "--reverse", "--topo-order", f"{ancestor}..{end}")
    validate_document(text_at(end))
    if not has_gate(end):
        raise ValueError("The candidate removes the HLDD checker. Restore the maintenance gate.")
    judged: set[str] = set()
    exempt = 0
    for revision in revisions.stdout.decode().splitlines():
        parents = git("rev-list", "--parents", "-n", "1", revision).stdout.decode().split()[1:]
        if not has_gate(revision):
            if any(has_gate(parent) for parent in parents):
                raise ValueError(f"{revision[:12]} removes the HLDD checker.")
            continue  # Historical commits before adoption are not retroactively gated.
        try:
            if dependency_update(revision, parents, judged, ancestor):
                validate_document(text_at(revision))
                exempt += 1
            else:
                check_change(parents[0] if parents else None, revision)
        except ValueError as error:
            raise ValueError(f"{revision[:12]}: {error}") from error
        judged.add(revision)
    return len(judged), exempt


def install_hook() -> None:
    configured = git("config", "--get", "core.hooksPath", check=False)
    if configured.returncode == 0 and configured.stdout.strip():
        raise ValueError(
            "core.hooksPath is already managed. Add 'python scripts/check_hldd.py --staged' "
            "to its pre-commit chain instead of replacing that hook manager."
        )
    hooks = Path(git("rev-parse", "--git-path", "hooks").stdout.decode().strip())
    if not hooks.is_absolute():
        hooks = ROOT / hooks
    destination = hooks / "pre-commit"
    source = ROOT / "scripts/pre-commit-hldd.sh"
    content = source.read_bytes()
    if destination.is_symlink():
        raise ValueError("Existing pre-commit is a symlink. Preserve it and integrate the check manually.")
    if destination.exists() and destination.read_bytes() != content:
        raise ValueError("Existing pre-commit differs. Preserve it and add the HLDD check to its chain.")
    hooks.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        shutil.copyfile(source, destination)
    destination.chmod(destination.stat().st_mode | 0o111)
    print(f"HLDD hook installed at {destination}. Other hooks are unchanged.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--staged", action="store_true")
    mode.add_argument("--base", metavar="REF")
    mode.add_argument("--install-hook", action="store_true")
    parser.add_argument("--head", default="HEAD")
    args = parser.parse_args()
    try:
        if args.install_hook:
            install_hook()
        elif args.staged:
            result = git("rev-parse", "--verify", "HEAD", check=False)
            before = result.stdout.decode().strip() if result.returncode == 0 else None
            check_change(before, ":", staged=True)
            print("HLDD staged review passed.")
        else:
            count, exempt = check_range(args.base, args.head)
            detail = f", {exempt} of them dependency-only update(s)" if exempt else ""
            print(f"HLDD review passed for {count} introduced commit(s){detail}.")
    except (ValueError, OSError, UnicodeError, subprocess.CalledProcessError) as error:
        detail = error.stderr.decode(errors="replace").strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
        print(f"HLDD check failed: {detail}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
