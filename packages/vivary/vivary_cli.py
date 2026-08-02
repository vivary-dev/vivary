"""Small visibility helpers for Vivary receipts.

This module intentionally stays dependency-free and local-only. It reads the
privacy-preserving JSONL receipts already emitted by the core CLIs and can format
an email draft, but it never sends telemetry or mail on its own.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import sys
import urllib.parse
from email.message import EmailMessage
from pathlib import Path
from typing import Any

__version__ = "0.1.5"
DEFAULT_RECEIPT_LOG = ".vivary/receipts.jsonl"
RECEIPT_ENV = "VIVARY_RECEIPT_LOG"
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="vivary", description="Vivary visibility helpers.")
    parser.add_argument("--version", action="version", version=f"vivary {__version__}")
    sub = parser.add_subparsers(dest="command")

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

    return parser


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
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
