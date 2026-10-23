"""Reject known-affected versions in the internal Astro site's actual npm lock."""

import base64
import binascii
import json
from pathlib import Path
import re
import stat
import sys
from urllib.parse import urlsplit


LOCKFILE = Path("site/package-lock.json")
VENDOR = "vendor/astro-no-cache-policy"
VENDOR_LINK = {"resolved": VENDOR, "link": True}
VENDOR_PACKAGE = {"name": "@vivary/astro-no-cache-policy", "version": "1.0.0"}
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")


def refuse(message):
    raise ValueError("site dependency admission: " + message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            refuse("duplicate JSON key")
        result[key] = value
    return result


def invalid_constant(_value):
    refuse("non-JSON numeric constant")


def load_lock(filename):
    return json.loads(filename.read_text(encoding="utf-8"),
                      object_pairs_hook=unique_object, parse_constant=invalid_constant)


def validate_integrity(value):
    match = re.fullmatch(r"sha(256|384|512)-([A-Za-z0-9+/]+={0,2})", value) if isinstance(value, str) else None
    if match is None:
        refuse("canonical full registry integrity is required")
    try:
        decoded = base64.b64decode(match[2], validate=True)
    except (ValueError, binascii.Error):
        refuse("canonical full registry integrity is required")
    if len(decoded) != int(match[1]) // 8 or base64.b64encode(decoded).decode("ascii") != match[2]:
        refuse("canonical full registry integrity is required")


def validate_lock(lock):
    if not isinstance(lock, dict) or type(lock.get("lockfileVersion")) is not int or lock["lockfileVersion"] != 3:
        refuse("an npm lockfile v3 is required")
    packages = lock.get("packages")
    if not isinstance(packages, dict) or not isinstance(packages.get(""), dict):
        refuse("the lock package graph and root are required")
    root_dependencies = packages[""].get("dependencies")
    if not isinstance(root_dependencies, dict) or root_dependencies.get("http-cache-semantics") != "file:./" + VENDOR:
        refuse("the exact existing local vendor edge is required")
    if (packages.get("node_modules/http-cache-semantics") != VENDOR_LINK
            or packages["node_modules/http-cache-semantics"].get("link") is not True
            or packages.get(VENDOR) != VENDOR_PACKAGE):
        refuse("the exact existing vendor link and target records are required")
    expected = {"node_modules/vite", "node_modules/postcss-selector-parser"}
    if not expected.issubset(packages):
        refuse("the expected Vite and selector-parser graph is missing")
    targets = {}
    for location, entry in packages.items():
        if not isinstance(location, str) or not isinstance(entry, dict):
            refuse("malformed package record")
        if location == "":
            continue
        if "\\" in location or any(part in ("", ".", "..") for part in location.split("/")):
            refuse("malformed package location")
        if location in ("node_modules/http-cache-semantics", VENDOR):
            continue
        if not location.startswith("node_modules/") or entry.get("link"):
            refuse("another local or linked package is not admitted")
        resolved = entry.get("resolved")
        if not isinstance(resolved, str):
            refuse("a registry resolution is required")
        url = urlsplit(resolved)
        if url.scheme != "https" or url.netloc != "registry.npmjs.org":
            refuse("nonregistry source")
        validate_integrity(entry.get("integrity"))
        location_name = location.rsplit("/node_modules/", 1)[-1].removeprefix("node_modules/")
        name = location_name
        if name not in ("vite", "postcss-selector-parser"):
            name = entry.get("name")  # npm aliases retain the actual package name in the lock.
            if name not in ("vite", "postcss-selector-parser"):
                name = next((target for target in ("vite", "postcss-selector-parser")
                             if url.path.startswith(f"/{target}/-/")), None)
                if name is None:
                    continue
        value = entry.get("version")
        match = VERSION.fullmatch(value) if isinstance(value, str) and len(value) <= 100 else None
        if match is None:
            refuse(name + " requires a stable numeric release at " + location)
        version = tuple(map(int, match.groups()))
        # Only the reviewed 8.1 line is admitted. Later minor lines have distinct
        # advisory floors (GHSA-rq7h-c2jc-7f22); a greater version alone is unsafe.
        # GHSA-rj75-hqrm-r3gf has separate 6.1.5 and 7.1.6 fixes. Registry bulk
        # currently disagrees about 6.x; this does not suppress its raw finding.
        fixed = (version[:2] == (8, 1) and version >= (8, 1, 6)) if name == "vite" else (
            (version[0] == 6 and version >= (6, 1, 5))
            or (version[0] == 7 and version >= (7, 1, 6))
        )
        if not fixed:
            refuse(name + " is affected or on an unverified major at " + location)
        if (entry.get("name", name) != name
                or (location_name != name and entry.get("name") != name)
                or resolved != f"https://registry.npmjs.org/{name}/-/{name}-{value}.tgz"):
            refuse("target name/version and registry tarball URL disagree at " + location)
        targets[location] = {"name": name, "version": value}
    return targets


def plain_path(path, directory):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
        refuse("symlinked or reparse target metadata is not admitted")
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        refuse("target metadata requires plain directories and a regular package.json")


def validate_installed(lock, site=Path("site")):
    targets = validate_lock(lock)
    site = site.absolute()
    plain_path(site, directory=True)
    root = site.resolve(strict=True)
    for location, expected in targets.items():
        current = site
        for component in location.split("/"):
            current /= component
            plain_path(current, directory=True)
        metadata = current / "package.json"
        plain_path(metadata, directory=False)
        if not metadata.resolve(strict=True).is_relative_to(root):
            refuse("installed target metadata escapes the site")
        observed = load_lock(metadata)
        if not isinstance(observed, dict) or any(observed.get(key) != value for key, value in expected.items()):
            refuse("installed target name/version differs from the admitted lock at " + location)


def main():
    try:
        if sys.argv[1:] not in ([], ["--installed"]):
            refuse("only --installed is accepted; no caller-supplied lock or version facts")
        lock = load_lock(LOCKFILE)
        if sys.argv[1:]:
            validate_installed(lock)
        else:
            validate_lock(lock)
        mode = "installed " if sys.argv[1:] else ""
        print(f"{LOCKFILE}: {mode}known site dependency admission passed")
        return 0
    except (OSError, UnicodeError, ValueError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
