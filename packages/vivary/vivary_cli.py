"""The Vivary front door and its local visibility helpers.

This module routes ten task-first verbs to the installed component CLIs and reads
the privacy-preserving JSONL receipts those CLIs emit. It stays dependency-free
and local-only: it never sends telemetry or mail on its own, and it imports a
component only when a routed verb asks for one.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.metadata
import json
import os
import platform
import re
import sys
import urllib.parse
from email.message import EmailMessage
from pathlib import Path
from typing import Any, NamedTuple

__version__ = "0.2.0"
DEFAULT_RECEIPT_LOG = ".vivary/receipts.jsonl"
RECEIPT_ENV = "VIVARY_RECEIPT_LOG"
HELP_WIDTH = 79
SAFE_FIELDS = (
    "schema",
    "timestamp",
    "tool",
    "version",
    "command",
    "flags",
    "arg_count",
    "exit_code",
    "ok",
    "duration_ms",
    "python",
    "platform",
    "receipt_source",
    "error_type",
)


class Component(NamedTuple):
    module: str
    distribution: str
    group: str
    floor: str


COMPONENTS = {
    "create_vivary": Component(
        "create_vivary", "create-vivary", "Workspace", "0.4.2"),
    "tropo": Component("tropo", "vivary-tropo", "Graph and retrieval", "0.5.3"),
    "strato": Component("strato", "vivary-strato", "Policy", "0.1.2"),
    "ozone": Component("ozone", "vivary-ozone", "Review", "0.3.1"),
    "exo": Component("exo", "vivary-exo", "Coordination", "0.3.0"),
}


class Route(NamedTuple):
    verb: str
    module: str
    operation: tuple[str, ...]
    summary: str


ROUTES = (
    Route("create", "create_vivary", ("init",),
          "Create a Vivary workspace scaffold"),
    Route("adopt", "create_vivary", ("adopt",),
          "Plan and apply governed context for an existing workspace"),
    Route("doctor", "create_vivary", ("doctor",),
          "Validate a Vivary workspace scaffold"),
    Route("capabilities", "create_vivary", ("capabilities",),
          "List the optional preset capabilities"),
    Route("check", "tropo", ("check",),
          "Validate the context graph and report errors and warnings"),
    Route("find", "tropo", ("find",),
          "Retrieve a token-budgeted context set for a query"),
    Route("decide", "strato", ("decide",),
          "Evaluate one governed decision request"),
    Route("review", "ozone", ("review",),
          "Run a review rule pack over the context graph"),
    Route("impact", "ozone", ("impact",),
          "Show what one node affects"),
    Route("control", "exo", ("control",),
          "Dispatch one governed Core control request"),
)

ROUTE_BY_VERB = {route.verb: route for route in ROUTES}

HELPER_COMMANDS = ("logs", "email")

ADVANCED_COMMANDS = (
    ("create-vivary", "Scaffold, adopt, and validate workspaces"),
    ("tropo", "The context graph, its validation, and retrieval"),
    ("strato", "The governed decision policy layer"),
    ("ozone", "Review, impact, and evidence verification"),
    ("exo", "Coordination, work items, and governed control"),
)


def _sanitize_receipt_value(value: Any) -> Any:
    if isinstance(value, str):
        return _redact_sensitive_text(value)
    if isinstance(value, list):
        return [_sanitize_receipt_value(item) for item in value if isinstance(item, (str, int, float, bool))]
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    return str(type(value).__name__)


def _redact_sensitive_text(text: str) -> str:
    redacted = re.sub(r"re_[A-Za-z0-9_-]+", "re_[redacted]", text)
    redacted = re.sub(r"file:///[^\s,;]+", "(local path omitted)", redacted, flags=re.IGNORECASE)
    redacted = re.sub(r"[A-Za-z]:[\\/][^\s,;]+", "(local path omitted)", redacted)
    redacted = re.sub(r"\\\\[^\s,;]+", "(network path omitted)", redacted)
    return redacted


def _read_receipts(path: Path) -> tuple[list[dict[str, Any]], int]:
    records: list[dict[str, Any]] = []
    invalid = 0
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            invalid += 1
            continue
        if not isinstance(raw, dict):
            invalid += 1
            continue
        record = {field: _sanitize_receipt_value(raw[field]) for field in SAFE_FIELDS if field in raw}
        if record:
            records.append(record)
        else:
            invalid += 1
    return records, invalid


def _load_receipts(path_text: str) -> tuple[Path, list[dict[str, Any]], int]:
    path = Path(path_text).expanduser()
    if not path.is_file():
        raise FileNotFoundError("receipt log not found")
    records, invalid = _read_receipts(path)
    return path, records, invalid


def _filtered_records(records: list[dict[str, Any]], *, failed: bool, tail: int | None):
    out = [record for record in records if not failed or record.get("ok") is False]
    if tail is not None:
        limit = max(0, tail)
        out = [] if limit == 0 else out[-limit:]
    return out


def _summarize(records: list[dict[str, Any]], invalid_lines: int) -> dict[str, Any]:
    by_tool: dict[str, int] = {}
    failed = 0
    for record in records:
        tool = str(record.get("tool", "unknown"))
        by_tool[tool] = by_tool.get(tool, 0) + 1
        if record.get("ok") is False:
            failed += 1
    return {
        "total": len(records),
        "failed": failed,
        "invalid_lines": invalid_lines,
        "tools": dict(sorted(by_tool.items())),
    }


def _format_record(record: dict[str, Any]) -> str:
    status = "ok" if record.get("ok") is not False else "fail"
    timestamp = str(record.get("timestamp", "unknown-time"))
    tool = str(record.get("tool", "unknown-tool"))
    command = str(record.get("command", "unknown-command"))
    duration = record.get("duration_ms")
    duration_text = f" {duration}ms" if isinstance(duration, int) else ""
    flags = record.get("flags")
    flags_text = f" flags={','.join(flags)}" if isinstance(flags, list) and flags else ""
    return f"{timestamp} {tool} {command} {status}{duration_text}{flags_text}"


def _format_text(records: list[dict[str, Any]], summary: dict[str, Any], invalid_lines: int) -> str:
    lines = [
        "Vivary receipt log",
        f"total={summary['total']} failed={summary['failed']} invalid_lines={invalid_lines}",
    ]
    tools = summary.get("tools") or {}
    if tools:
        lines.append("tools=" + ", ".join(f"{name}:{count}" for name, count in tools.items()))
    lines.append("")
    lines.extend(_format_record(record) for record in records)
    return "\n".join(lines).rstrip() + "\n"


def _email_body(records: list[dict[str, Any]], invalid_lines: int) -> str:
    summary = _summarize(records, invalid_lines)
    lines = [
        "Vivary support receipt summary",
        "",
        "This is a local, user-created summary of Vivary run receipts.",
        "It excludes stdout, stderr, file contents, raw query text, target ids, and local paths.",
        "",
        f"total={summary['total']} failed={summary['failed']} invalid_lines={invalid_lines}",
    ]
    tools = summary.get("tools") or {}
    if tools:
        lines.append("tools=" + ", ".join(f"{name}:{count}" for name, count in tools.items()))
    lines.append("")
    lines.append("Recent receipts:")
    lines.extend(f"- {_format_record(record)}" for record in records)
    return "\n".join(lines) + "\n"


def _mailto(to_addr: str, subject: str, body: str) -> str:
    return (
        "mailto:"
        + urllib.parse.quote(to_addr, safe="@,")
        + "?subject="
        + urllib.parse.quote(subject)
        + "&body="
        + urllib.parse.quote(body)
    )


def _email_header_error(to_addr: str, subject: str) -> str | None:
    if "\r" in to_addr or "\n" in to_addr or "\r" in subject or "\n" in subject:
        return "email recipient and subject must be single-line text"
    return None


def _has_symlink_or_junction_ancestor(path: Path) -> bool:
    target = path if path.is_absolute() else Path.cwd() / path
    current = target.parent
    while True:
        if os.path.lexists(current) and (
            current.is_symlink()
            or (hasattr(os.path, "isjunction") and os.path.isjunction(current))
        ):
            return True
        parent = current.parent
        if parent == current:
            return False
        current = parent


def _draft_path_error(path: Path) -> str | None:
    if platform.system() == "Windows":
        stem = path.name.split(".", 1)[0].rstrip(" .").upper()
        reserved = {
            "CON",
            "PRN",
            "AUX",
            "NUL",
            *(f"COM{i}" for i in range(1, 10)),
            *(f"LPT{i}" for i in range(1, 10)),
        }
        if stem in reserved:
            return "draft path must not be a Windows device name"
    if _has_symlink_or_junction_ancestor(path):
        return "draft path must not contain a symlink or junction directory"
    if path.exists():
        if path.is_symlink():
            return "draft path must not be a symlink"
        if not path.is_file():
            return "draft path must be a regular file"
    return None


def cmd_logs(args: argparse.Namespace) -> int:
    try:
        _, records, invalid = _load_receipts(args.path)
    except (FileNotFoundError, OSError) as exc:
        print(f"vivary logs: {exc}", file=sys.stderr)
        return 1
    selected = _filtered_records(records, failed=args.failed, tail=args.tail)
    summary = _summarize(selected, invalid)
    if args.json:
        print(json.dumps({"summary": summary, "records": selected}, indent=2))
    else:
        print(_format_text(selected, summary, invalid), end="")
    return 0


def cmd_logs_email(args: argparse.Namespace) -> int:
    try:
        _, records, invalid = _load_receipts(args.path)
    except (FileNotFoundError, OSError) as exc:
        print(f"vivary logs email: {exc}", file=sys.stderr)
        return 1
    header_error = _email_header_error(args.to, args.subject)
    if header_error:
        print(f"vivary logs email: {header_error}", file=sys.stderr)
        return 1
    selected = _filtered_records(records, failed=args.failed, tail=args.tail)
    body = _email_body(selected, invalid)
    if args.out:
        target = Path(args.out).expanduser()
        error = _draft_path_error(target)
        if error:
            print(f"vivary logs email: {error}", file=sys.stderr)
            return 1
        target.parent.mkdir(parents=True, exist_ok=True)
        error = _draft_path_error(target)
        if error:
            print(f"vivary logs email: {error}", file=sys.stderr)
            return 1
        message = EmailMessage()
        message["To"] = args.to
        message["Subject"] = args.subject
        message.set_content(body)
        target.write_text(message.as_string(), encoding="utf-8", newline="\n")
        if args.json:
            print(json.dumps({"draft": str(target), "records": len(selected)}, indent=2))
        else:
            print(f"vivary logs email: wrote draft to {target}")
        return 0

    url = _mailto(args.to, args.subject, body)
    if args.json:
        print(json.dumps({"mailto": url, "records": len(selected)}, indent=2))
    else:
        print(url)
    return 0


def _release_tuple(text: str) -> tuple[tuple[int, ...], bool]:
    """Split a version into its release numbers and whether it is a final release."""
    match = re.match(r"\d+(?:\.\d+)*", text.strip())
    if match is None:
        return (0, 0, 0), False
    release = [int(part) for part in match.group().split(".")]
    release.extend([0] * (3 - len(release)))
    rest = text.strip()[match.end():]
    return tuple(release), re.fullmatch(r"(?:\.post\d+)?", rest) is not None


def _below_floor(installed: str, floor: str) -> bool:
    release, is_final = _release_tuple(installed)
    floor_release, _ = _release_tuple(floor)
    if release != floor_release:
        return release < floor_release
    return not is_final


def _installed_version(component: Component, module: Any) -> str | None:
    try:
        installed = importlib.metadata.version(component.distribution)
    except importlib.metadata.PackageNotFoundError:
        installed = getattr(module, "__version__", None)
    return installed if isinstance(installed, str) else None


def _dispatch(route: Route, rest: list[str]) -> int:
    component = COMPONENTS[route.module]
    try:
        module = importlib.import_module(route.module)
    except ModuleNotFoundError as exc:
        if exc.name != component.module:
            raise
        print(
            f"vivary {route.verb}: {component.distribution} is not installed."
            f' Run: pip install "{component.distribution}>={component.floor}"',
            file=sys.stderr,
        )
        return 2

    main = getattr(module, "main", None)
    if not callable(main):
        print(
            f"vivary {route.verb}: the importable module {component.module} is not"
            f" {component.distribution} (no main entry point)",
            file=sys.stderr,
        )
        return 2

    installed = _installed_version(component, module)
    if installed is None:
        print(
            f"vivary {route.verb}: cannot read the version of {component.distribution}",
            file=sys.stderr,
        )
        return 2

    if _below_floor(installed, component.floor):
        print(
            f"vivary {route.verb}: needs {component.distribution} {component.floor}"
            f" or newer, found {installed}. Run: pip install --upgrade"
            f' "{component.distribution}>={component.floor}"',
            file=sys.stderr,
        )
        return 2

    try:
        return main([*route.operation, *rest])
    except SystemExit as exc:
        code = exc.code
        if code is None:
            return 0
        if isinstance(code, int):
            return code
        # A component can exit with a message string, which a standalone run
        # would have had the interpreter print before exiting 1.
        print(code, file=sys.stderr)
        return 1


def _description() -> str:
    width = max(len(route.verb) for route in ROUTES)
    lines = [
        "The Vivary front door, plus local visibility helpers.",
        "",
        "Task verbs:",
    ]
    for group in dict.fromkeys(COMPONENTS[route.module].group for route in ROUTES):
        lines.append("")
        lines.append(f"  {group}")
        lines.extend(
            f"    {route.verb.ljust(width)}  {route.summary}"
            for route in ROUTES
            if COMPONENTS[route.module].group == group
        )
    return "\n".join(lines)


def _usage() -> str:
    """Lay out the command list by hand.

    argparse treats the `{a,b,c}` choice list as one unbreakable token, so the
    generated usage line runs past the width budget once ten verbs join the two
    receipt commands.
    """
    names = (*HELPER_COMMANDS, *(route.verb for route in ROUTES))
    tokens = [f"{name}," for name in names[:-1]]
    tokens.append(f"{names[-1]}}} ...")
    indent = " " * len("usage: ")
    budget = HELP_WIDTH - len(indent)
    lines = ["vivary [-h] [--version] {"]
    for token in tokens:
        if len(lines[-1]) + len(token) > budget:
            lines.append("")
        lines[-1] += token
    return ("\n" + indent).join(lines)


def _epilog() -> str:
    width = max(len(name) for name, _ in ADVANCED_COMMANDS)
    lines = [
        "Advanced:",
        "",
        "  Each component also installs its own command with the full operation set.",
        "",
    ]
    lines.extend(f"    {name.ljust(width)}  {summary}" for name, summary in ADVANCED_COMMANDS)
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="vivary",
        usage=_usage(),
        description=_description(),
        epilog=_epilog(),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"vivary {__version__}")
    # A custom usage would otherwise become the prefix of every subcommand's prog.
    sub = parser.add_subparsers(dest="command", metavar="<command>", prog="vivary")

    logs = sub.add_parser("logs", help="summarize local Vivary JSONL run receipts")
    logs.add_argument("path", nargs="?", default=os.environ.get(RECEIPT_ENV, DEFAULT_RECEIPT_LOG))
    logs.add_argument("--json", action="store_true", help="print machine-readable output")
    logs.add_argument("--tail", type=int, default=None, help="show only the last N matching receipts")
    logs.add_argument("--failed", action="store_true", help="show only failed receipts")
    logs.set_defaults(func=cmd_logs)

    email = sub.add_parser(
        "email",
        prog="vivary logs email",
        help="build a local email draft from receipts (also available as `vivary logs email`)",
    )
    email.add_argument("path", nargs="?", default=os.environ.get(RECEIPT_ENV, DEFAULT_RECEIPT_LOG))
    email.add_argument("--to", required=True, help="recipient address for the draft or mailto link")
    email.add_argument("--subject", default="Vivary support receipt summary")
    email.add_argument("--out", default=None, help="write an .eml draft instead of printing a mailto URL")
    email.add_argument("--json", action="store_true", help="print machine-readable output")
    email.add_argument("--tail", type=int, default=25, help="include only the last N matching receipts")
    email.add_argument("--failed", action="store_true", help="include only failed receipts")
    email.set_defaults(func=cmd_logs_email)

    for route in ROUTES:
        sub.add_parser(route.verb, add_help=False)

    return parser


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] in ROUTE_BY_VERB:
        return _dispatch(ROUTE_BY_VERB[argv[0]], argv[1:])
    if len(argv) >= 2 and argv[0] == "logs" and argv[1] == "email":
        argv = [argv[1], *argv[2:]]
    parser = build_parser()
    args = parser.parse_args(argv)
    if not hasattr(args, "func"):
        parser.print_help()
        return 0
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
