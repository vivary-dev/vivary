"""Optional read-only MCP adapter over public Vivary context contracts."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import stat
import sys
import threading
import time
import unicodedata
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field
from io import TextIOWrapper
from typing import Any, Callable, Iterator, Mapping, Sequence

import anyio
from mcp import MCPError
from mcp.server import Server, ServerRequestContext
from mcp.server.stdio import stdio_server
from mcp.types import (
    INVALID_PARAMS,
    CallToolRequestParams,
    CallToolResult,
    ListToolsResult,
    PaginatedRequestParams,
    TextContent,
    Tool,
    ToolAnnotations,
)

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    class _WindowsDirectoryInformation(ctypes.Structure):
        _fields_ = [
            ("file_attributes", wintypes.DWORD),
            ("creation_time", wintypes.FILETIME),
            ("last_access_time", wintypes.FILETIME),
            ("last_write_time", wintypes.FILETIME),
            ("volume_serial_number", wintypes.DWORD),
            ("file_size_high", wintypes.DWORD),
            ("file_size_low", wintypes.DWORD),
            ("number_of_links", wintypes.DWORD),
            ("file_index_high", wintypes.DWORD),
            ("file_index_low", wintypes.DWORD),
        ]

    class _WindowsFileId128(ctypes.Structure):
        _fields_ = [("identifier", ctypes.c_ubyte * 16)]

    class _WindowsFileIdInformation(ctypes.Structure):
        _fields_ = [
            ("volume_serial_number", ctypes.c_ulonglong),
            ("file_id", _WindowsFileId128),
        ]

    _WINDOWS_KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _WINDOWS_CREATE_FILE = _WINDOWS_KERNEL32.CreateFileW
    _WINDOWS_CREATE_FILE.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    _WINDOWS_CREATE_FILE.restype = wintypes.HANDLE
    _WINDOWS_GET_FILE_INFO = _WINDOWS_KERNEL32.GetFileInformationByHandle
    _WINDOWS_GET_FILE_INFO.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(_WindowsDirectoryInformation),
    ]
    _WINDOWS_GET_FILE_INFO.restype = wintypes.BOOL
    _WINDOWS_GET_FILE_INFO_EX = _WINDOWS_KERNEL32.GetFileInformationByHandleEx
    _WINDOWS_GET_FILE_INFO_EX.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    _WINDOWS_GET_FILE_INFO_EX.restype = wintypes.BOOL
    _WINDOWS_CLOSE_HANDLE = _WINDOWS_KERNEL32.CloseHandle
    _WINDOWS_CLOSE_HANDLE.argtypes = [wintypes.HANDLE]
    _WINDOWS_CLOSE_HANDLE.restype = wintypes.BOOL
    _WINDOWS_INVALID_HANDLE = ctypes.c_void_p(-1).value
    _WINDOWS_FILE_READ_ATTRIBUTES = 0x00000080
    _WINDOWS_FILE_SHARE_ALL = 0x00000001 | 0x00000002 | 0x00000004
    _WINDOWS_OPEN_EXISTING = 3
    _WINDOWS_FILE_ATTRIBUTE_DIRECTORY = 0x00000010
    _WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
    _WINDOWS_FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    _WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    _WINDOWS_FILE_ID_INFO_CLASS = 18

    def _open_windows_directory(root: str) -> tuple[Any, tuple[int, int]]:
        handle = _WINDOWS_CREATE_FILE(
            root,
            _WINDOWS_FILE_READ_ATTRIBUTES,
            _WINDOWS_FILE_SHARE_ALL,
            None,
            _WINDOWS_OPEN_EXISTING,
            _WINDOWS_FILE_FLAG_BACKUP_SEMANTICS
            | _WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        if handle == _WINDOWS_INVALID_HANDLE:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            basic = _WindowsDirectoryInformation()
            identity = _WindowsFileIdInformation()
            if not _WINDOWS_GET_FILE_INFO(handle, ctypes.byref(basic)):
                raise ctypes.WinError(ctypes.get_last_error())
            if not _WINDOWS_GET_FILE_INFO_EX(
                handle,
                _WINDOWS_FILE_ID_INFO_CLASS,
                ctypes.byref(identity),
                ctypes.sizeof(identity),
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            if (
                not basic.file_attributes & _WINDOWS_FILE_ATTRIBUTE_DIRECTORY
                or basic.file_attributes & _WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT
            ):
                raise OSError("workspace path is not a regular directory")
            file_id = int.from_bytes(bytes(identity.file_id.identifier), "little")
            if file_id == 0:
                raise OSError("workspace directory has no stable file identity")
            return handle, (int(identity.volume_serial_number), file_id)
        except BaseException:
            _WINDOWS_CLOSE_HANDLE(handle)
            raise

__version__ = "0.1.1"

PROTOCOL_VERSION = "2026-07-28"
MCP_SCHEMA_REVISION = "mcp-types==2.0.0"
CONFORMANCE_HARNESS_REVISION = "@modelcontextprotocol/conformance@0.2.0-alpha.10"

MAX_STDIN_LINE_BYTES = 65_536
MAX_TOOL_RESPONSE_BYTES = 1 * 1024 * 1024
MAX_WORKSPACES = 16
MAX_FILTERS = 16
MAX_CHECK_PATHS = 200
MAX_QUERY_CHARS = 4_096
MAX_RESULTS = 20
MAX_CAPSULE_CLAIMS = 24
PRODUCER_TIMEOUT_SECONDS = 30.0
PRODUCER_CANCELLATION_GRACE_SECONDS = 5.0
MAX_DIAGNOSTIC_BYTES = 4_096

_ENVELOPE_SCHEMA = "vivary.mcp-tool-result/v0"
_TOOL_NAMES = ("vivary_find", "vivary_query", "vivary_check", "vivary_capsule")
_FAILURE_REASONS = frozenset(
    {
        "unknown_workspace",
        "workspace_unavailable",
        "path_refused",
        "privacy_policy_unavailable",
        "work_limit_exceeded",
        "response_limit_exceeded",
        "producer_unavailable",
        "server_busy",
    }
)
_ALIAS_RE = re.compile(r"\A[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})\Z")
_URI_RE = re.compile(
    r"[A-Za-z][A-Za-z0-9+.-]*://"
    r"(?:\[[0-9A-Fa-f:.]+\]|[^\s/\"'<>()[\]`]+)"
    r"(?::[0-9]{1,5})?"
    r"(?:/[^\s\"'<>()[\]`]*)?"
)
_CREDENTIAL_URL_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s/@:]+:[^\s/@]+@")
_SCP_CREDENTIAL_RE = re.compile(r"[^\s/@:]+:[^\s/@]+@[^\s/]+:")
_CREDENTIAL_ASSIGNMENT_RE = re.compile(
    r"""(?ix)
    \b(?:api[_-]?key|access[_-]?key|auth(?:orization)?|credential|password|
       passwd|private[_ -]?key|secret|token)\b
    \s*(?:=|:)\s*["']?([^\s"',;}\]]+)
    """
)
_TOKEN_RE = re.compile(
    r"\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b"
)
_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----"
)
_MACHINE_PATH_RE = re.compile(
    r"""(?ix)
    (?:^|[^\w/])
    (?:
        [A-Z]:[\\/]
        | \\\\[^\s\\/]+[\\/][^\s\\/]+
        | /(?!/)[^\s/"'<>()\[\]{}]+(?:/[^\s"'<>()\[\]{}]+)*
    )
    """
)


class _InvalidArguments(ValueError):
    pass


class _DirectoryAnchor:
    """A live reference to the directory registered for one workspace alias."""

    __slots__ = ("_handle", "device", "inode")

    def __init__(self, handle: Any, identity: tuple[int, int]):
        self._handle = handle
        self.device, self.inode = identity

    @classmethod
    def open(cls, root: str) -> _DirectoryAnchor:
        if os.name == "nt":
            handle, identity = _open_windows_directory(root)
            return cls(handle, identity)

        flags = os.O_RDONLY
        for flag_name in ("O_CLOEXEC", "O_DIRECTORY", "O_NOFOLLOW"):
            flags |= getattr(os, flag_name, 0)
        descriptor = os.open(root, flags)
        try:
            anchored = os.fstat(descriptor)
            current = os.lstat(root)
            if (
                not stat.S_ISDIR(anchored.st_mode)
                or not stat.S_ISDIR(current.st_mode)
                or getattr(current, "st_reparse_tag", 0)
                or (current.st_dev, current.st_ino)
                != (anchored.st_dev, anchored.st_ino)
            ):
                raise OSError("workspace identity changed during registration")
        except BaseException:
            os.close(descriptor)
            raise
        return cls(descriptor, (anchored.st_dev, anchored.st_ino))

    def matches(self, root: str) -> bool:
        if self._handle is None:
            return False
        if os.name == "nt":
            try:
                handle, identity = _open_windows_directory(root)
            except OSError:
                return False
            try:
                return identity == (self.device, self.inode)
            finally:
                _WINDOWS_CLOSE_HANDLE(handle)
        try:
            current = os.lstat(root)
        except OSError:
            return False
        return (
            stat.S_ISDIR(current.st_mode)
            and not getattr(current, "st_reparse_tag", 0)
            and (current.st_dev, current.st_ino) == (self.device, self.inode)
        )

    def close(self) -> None:
        handle = self._handle
        if handle is None:
            return
        self._handle = None
        if os.name == "nt":
            _WINDOWS_CLOSE_HANDLE(handle)
        else:
            with suppress(OSError):
                os.close(handle)

    def __del__(self) -> None:
        with suppress(Exception):
            self.close()


@dataclass(frozen=True, slots=True)
class Workspace:
    alias: str
    root: str
    device: int
    inode: int
    _anchor: _DirectoryAnchor = field(repr=False, compare=False)


class _WorkspaceRegistry(dict[str, Workspace]):
    def close(self) -> None:
        for workspace in reversed(tuple(self.values())):
            workspace._anchor.close()

    def __enter__(self) -> _WorkspaceRegistry:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


def _closed_object(properties: Mapping[str, Any], required: Sequence[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": dict(properties),
        "required": list(required),
        "additionalProperties": False,
    }


def _string_array(*, max_items: int, max_length: int) -> dict[str, Any]:
    return {
        "type": "array",
        "items": {"type": "string", "minLength": 1, "maxLength": max_length},
        "maxItems": max_items,
        "uniqueItems": True,
        "default": [],
    }


_WORKSPACE_PROPERTY = {
    "type": "string",
    "minLength": 1,
    "maxLength": 64,
    "pattern": r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
}
_QUERY_PROPERTY = {"type": "string", "minLength": 1, "maxLength": MAX_QUERY_CHARS}
_LIMIT_PROPERTY = {"type": "integer", "minimum": 1, "maximum": MAX_RESULTS}

_FIND_INPUT_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    **_closed_object(
        {
            "workspace": _WORKSPACE_PROPERTY,
            "question": _QUERY_PROPERTY,
            "limit": {**_LIMIT_PROPERTY, "default": 5},
            "budget": {"type": "integer", "minimum": 64, "maximum": 4_000, "default": 1_200},
        },
        ("workspace", "question"),
    ),
}
_QUERY_INPUT_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    **_closed_object(
        {
            "workspace": _WORKSPACE_PROPERTY,
            "text": _QUERY_PROPERTY,
            "limit": {**_LIMIT_PROPERTY, "default": 10},
            "type_filters": _string_array(max_items=MAX_FILTERS, max_length=128),
            "path_filters": _string_array(max_items=MAX_FILTERS, max_length=512),
            "edge_filters": _string_array(max_items=MAX_FILTERS, max_length=256),
            "snippet_chars": {
                "type": "integer",
                "minimum": 0,
                "maximum": 1_000,
                "default": 160,
            },
            "explain": {"type": "boolean", "default": False},
        },
        ("workspace", "text"),
    ),
}
_CHECK_INPUT_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    **_closed_object(
        {
            "workspace": _WORKSPACE_PROPERTY,
            "paths": _string_array(max_items=MAX_CHECK_PATHS, max_length=512),
            "strict": {"type": "boolean"},
        },
        ("workspace",),
    ),
}
_CAPSULE_INPUT_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    **_closed_object(
        {
            "workspace": _WORKSPACE_PROPERTY,
            "question": _QUERY_PROPERTY,
            "max_claims": {
                "type": "integer",
                "minimum": 0,
                "maximum": MAX_CAPSULE_CLAIMS,
                "default": MAX_CAPSULE_CLAIMS,
            },
        },
        ("workspace", "question"),
    ),
}

_TOOL_DESCRIPTIONS = {
    "vivary_find": "Return bounded, privacy-filtered context for a task or question.",
    "vivary_query": "Query the bounded, privacy-filtered typed knowledge graph.",
    "vivary_check": "Check bounded, privacy-filtered workspace documents without changing them.",
    "vivary_capsule": "Retrieve a bounded governed Task Capsule without executing its checks.",
}


def _output_schema(producer_schema: Mapping[str, Any]) -> dict[str, Any]:
    producer = json.loads(json.dumps(producer_schema))
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "schema": {"const": _ENVELOPE_SCHEMA},
            "tool": {"enum": list(_TOOL_NAMES)},
            "status": {"enum": ["known", "unknown", "refused"]},
            "complete": {"type": "boolean"},
            "workspace": _WORKSPACE_PROPERTY,
            "reason": {"type": ["string", "null"]},
            "result": {"oneOf": [{"$ref": "#/$defs/producer"}, {"type": "null"}]},
            "omissions": {
                "type": "array",
                "maxItems": 8,
                "items": _closed_object(
                    {
                        "kind": {"type": "string", "minLength": 1, "maxLength": 64},
                        "reason": {"type": "string", "minLength": 1, "maxLength": 64},
                        "count": {"type": "integer", "minimum": 1},
                    },
                    ("kind", "reason", "count"),
                ),
            },
        },
        "required": [
            "schema",
            "tool",
            "status",
            "complete",
            "workspace",
            "reason",
            "result",
            "omissions",
        ],
        "additionalProperties": False,
        "$defs": {"producer": producer},
    }


def _load_producer_schemas() -> dict[str, dict[str, Any]]:
    from tropo import (
        check_result_json_schema,
        find_result_json_schema,
        query_result_json_schema,
    )
    from vivary_core import public_task_capsule_json_schema

    return {
        "vivary_find": find_result_json_schema(),
        "vivary_query": query_result_json_schema(),
        "vivary_check": check_result_json_schema(),
        "vivary_capsule": public_task_capsule_json_schema(),
    }


def _build_tools() -> tuple[Tool, ...]:
    schemas = _load_producer_schemas()
    annotations = ToolAnnotations(
        read_only_hint=True,
        destructive_hint=False,
        idempotent_hint=True,
        open_world_hint=False,
    )
    inputs = {
        "vivary_find": _FIND_INPUT_SCHEMA,
        "vivary_query": _QUERY_INPUT_SCHEMA,
        "vivary_check": _CHECK_INPUT_SCHEMA,
        "vivary_capsule": _CAPSULE_INPUT_SCHEMA,
    }
    return tuple(
        Tool(
            name=name,
            description=_TOOL_DESCRIPTIONS[name],
            input_schema=inputs[name],
            output_schema=_output_schema(schemas[name]),
            annotations=annotations,
        )
        for name in _TOOL_NAMES
    )


def _canonical_workspace(alias: str, raw_path: str) -> Workspace:
    from vivary_core import is_canonical_absolute_path, normalize_path

    if not _ALIAS_RE.fullmatch(alias):
        raise ValueError("workspace alias refused")
    try:
        root = normalize_path(os.path.realpath(os.path.abspath(raw_path)))
        info = os.lstat(root)
    except (OSError, ValueError):
        raise ValueError("workspace path refused") from None
    if (
        not is_canonical_absolute_path(root)
        or not stat.S_ISDIR(info.st_mode)
        or getattr(info, "st_reparse_tag", 0)
    ):
        raise ValueError("workspace path refused")
    try:
        anchor = _DirectoryAnchor.open(root)
    except OSError:
        raise ValueError("workspace path refused") from None
    return Workspace(
        alias=alias,
        root=root,
        device=anchor.device,
        inode=anchor.inode,
        _anchor=anchor,
    )


def workspace_registry(rows: Sequence[Sequence[str]]) -> _WorkspaceRegistry:
    if not rows or len(rows) > MAX_WORKSPACES:
        raise ValueError("one through sixteen workspaces are required")
    registry = _WorkspaceRegistry()
    identities: set[tuple[int, int]] = set()
    try:
        for row in rows:
            if len(row) != 2:
                raise ValueError("each workspace requires an alias and path")
            workspace = _canonical_workspace(row[0], row[1])
            identity = (workspace.device, workspace.inode)
            if workspace.alias in registry or identity in identities:
                workspace._anchor.close()
                raise ValueError("workspace aliases and roots must be unique")
            registry[workspace.alias] = workspace
            identities.add(identity)
        return registry
    except BaseException:
        registry.close()
        raise


def _workspace_available(workspace: Workspace) -> bool:
    return workspace._anchor.matches(workspace.root)


def _clone_workspace(workspace: Workspace) -> Workspace:
    try:
        anchor = _DirectoryAnchor.open(workspace.root)
    except OSError:
        raise ValueError("workspace path refused") from None
    identity = (anchor.device, anchor.inode)
    if (
        identity != (workspace.device, workspace.inode)
        or not workspace._anchor.matches(workspace.root)
    ):
        anchor.close()
        raise ValueError("workspace path refused")
    return Workspace(
        alias=workspace.alias,
        root=workspace.root,
        device=anchor.device,
        inode=anchor.inode,
        _anchor=anchor,
    )


def _exact_object(value: Any, allowed: set[str], required: set[str]) -> dict[str, Any]:
    if type(value) is not dict or not required <= set(value) or not set(value) <= allowed:
        raise _InvalidArguments()
    return value


def _bounded_string(value: Any, *, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise _InvalidArguments()
    return value


def _bounded_integer(value: Any, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise _InvalidArguments()
    return value


def _string_list(value: Any, *, maximum_items: int, maximum_length: int) -> list[str]:
    if (
        type(value) is not list
        or len(value) > maximum_items
        or any(not isinstance(item, str) or not item or len(item) > maximum_length for item in value)
        or len(set(value)) != len(value)
    ):
        raise _InvalidArguments()
    return list(value)


def _safe_relative_paths(value: Any) -> list[str]:
    paths = _string_list(value, maximum_items=MAX_CHECK_PATHS, maximum_length=512)
    for path in paths:
        normalized = path.replace("\\", "/")
        if (
            normalized != path
            or path.startswith("/")
            or re.match(r"^[A-Za-z]:", path)
            or any(part in ("", ".", "..") for part in path.split("/"))
        ):
            raise _InvalidArguments()
    return paths


def _validate_arguments(tool: str, arguments: Any) -> dict[str, Any]:
    if tool == "vivary_find":
        args = _exact_object(arguments, {"workspace", "question", "limit", "budget"}, {"workspace", "question"})
        return {
            "workspace": _bounded_string(args["workspace"], maximum=64),
            "question": _bounded_string(args["question"], maximum=MAX_QUERY_CHARS),
            "limit": _bounded_integer(args.get("limit", 5), minimum=1, maximum=MAX_RESULTS),
            "budget": _bounded_integer(args.get("budget", 1_200), minimum=64, maximum=4_000),
        }
    if tool == "vivary_query":
        args = _exact_object(
            arguments,
            {
                "workspace",
                "text",
                "limit",
                "type_filters",
                "path_filters",
                "edge_filters",
                "snippet_chars",
                "explain",
            },
            {"workspace", "text"},
        )
        explain = args.get("explain", False)
        if type(explain) is not bool:
            raise _InvalidArguments()
        return {
            "workspace": _bounded_string(args["workspace"], maximum=64),
            "text": _bounded_string(args["text"], maximum=MAX_QUERY_CHARS),
            "limit": _bounded_integer(args.get("limit", 10), minimum=1, maximum=MAX_RESULTS),
            "type_filters": _string_list(args.get("type_filters", []), maximum_items=MAX_FILTERS, maximum_length=128),
            "path_filters": _string_list(args.get("path_filters", []), maximum_items=MAX_FILTERS, maximum_length=512),
            "edge_filters": _string_list(args.get("edge_filters", []), maximum_items=MAX_FILTERS, maximum_length=256),
            "snippet_chars": _bounded_integer(args.get("snippet_chars", 160), minimum=0, maximum=1_000),
            "explain": explain,
        }
    if tool == "vivary_check":
        args = _exact_object(arguments, {"workspace", "paths", "strict"}, {"workspace"})
        strict = args.get("strict")
        if strict is not None and type(strict) is not bool:
            raise _InvalidArguments()
        return {
            "workspace": _bounded_string(args["workspace"], maximum=64),
            "paths": _safe_relative_paths(args.get("paths", [])),
            "strict": strict,
        }
    if tool == "vivary_capsule":
        args = _exact_object(arguments, {"workspace", "question", "max_claims"}, {"workspace", "question"})
        return {
            "workspace": _bounded_string(args["workspace"], maximum=64),
            "question": _bounded_string(args["question"], maximum=MAX_QUERY_CHARS),
            "max_claims": _bounded_integer(
                args.get("max_claims", MAX_CAPSULE_CLAIMS),
                minimum=0,
                maximum=MAX_CAPSULE_CLAIMS,
            ),
        }
    raise _InvalidArguments()


def _produce(
    tool: str,
    root: str,
    arguments: Mapping[str, Any],
    cancelled: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    if tool == "vivary_find":
        from tropo import find_context

        return find_context(
            root,
            arguments["question"],
            k=arguments["limit"],
            budget=arguments["budget"],
            allowlist=[root],
            cancelled=cancelled,
        )
    if tool == "vivary_query":
        from tropo import query_context

        return query_context(
            root,
            arguments["text"],
            k=arguments["limit"],
            type_filters=arguments["type_filters"],
            path_filters=arguments["path_filters"],
            edge_filters=arguments["edge_filters"],
            snippet_chars=arguments["snippet_chars"],
            explain=arguments["explain"],
            allowlist=[root],
            cancelled=cancelled,
        )
    if tool == "vivary_check":
        from tropo import check_workspace

        return check_workspace(
            root,
            paths=arguments["paths"],
            strict=arguments["strict"],
            allowlist=[root],
            cancelled=cancelled,
        )
    if tool == "vivary_capsule":
        from tropo import governed_find
        from vivary_core import project_public_task_capsule

        capsule = governed_find(
            root,
            arguments["question"],
            max_claims=arguments["max_claims"],
            cancelled=cancelled,
        )
        return project_public_task_capsule(capsule, checkout_path=root)
    raise AssertionError("unreachable tool dispatch")


def _reason_for_exception(error: BaseException) -> str:
    reason = getattr(error, "reason", None)
    if reason in _FAILURE_REASONS:
        return reason
    name = type(error).__name__
    if name == "ContentPrivacyPathRefusedError":
        return "path_refused"
    if name == "ContentPrivacyPolicyUnavailableError":
        return "privacy_policy_unavailable"
    if name == "CapsuleContentWorkLimitError":
        return "work_limit_exceeded"
    if isinstance(error, (FileNotFoundError, NotADirectoryError, PermissionError)):
        return "workspace_unavailable"
    return "producer_unavailable"


def _walk_json(value: Any) -> Iterator[tuple[str | None, Any]]:
    pending: list[tuple[bool, str | None, Any]] = [(False, None, value)]
    active: set[int] = set()
    while pending:
        exiting, key, current = pending.pop()
        if exiting:
            active.remove(id(current))
            continue
        yield key, current
        if type(current) is dict:
            identity = id(current)
            if identity in active:
                raise ValueError("cyclic producer result")
            active.add(identity)
            pending.append((True, None, current))
            pending.extend(
                (False, str(child_key), child)
                for child_key, child in reversed(tuple(current.items()))
            )
        elif type(current) is list:
            identity = id(current)
            if identity in active:
                raise ValueError("cyclic producer result")
            active.add(identity)
            pending.append((True, None, current))
            pending.extend((False, key, child) for child in reversed(current))


def _security_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    return "".join(
        character
        for character in normalized
        if not unicodedata.category(character).startswith(("C", "M"))
    )


def _assert_result_safe(result: Any, workspace: Workspace) -> None:
    roots = {
        unicodedata.normalize("NFKC", workspace.root),
        unicodedata.normalize("NFKC", workspace.root.replace("/", "\\")),
    }
    if os.name == "nt":
        roots = {root.casefold() for root in roots}
    for key, value in _walk_json(result):
        if key in {"command", "cwd", "evidence", "raw_path", "scope", "subject_path"}:
            raise ValueError("private field in producer result")
        if not isinstance(value, str):
            continue
        if any(not character.isprintable() for character in value):
            raise ValueError("unsafe text in producer result")
        normalized = unicodedata.normalize("NFKC", value)
        compared = normalized.casefold() if os.name == "nt" else normalized
        if any(root and root in compared for root in roots):
            raise ValueError("workspace path in producer result")
        security_text = _security_text(normalized)
        if (
            _CREDENTIAL_URL_RE.search(security_text)
            or _SCP_CREDENTIAL_RE.search(security_text)
            or _CREDENTIAL_ASSIGNMENT_RE.search(security_text)
            or _TOKEN_RE.search(security_text)
            or _PRIVATE_KEY_RE.search(security_text)
        ):
            raise ValueError("credential-bearing producer result")
        path_text = _URI_RE.sub("", security_text)
        if _MACHINE_PATH_RE.search(path_text):
            raise ValueError("absolute path in producer result")


def _envelope(
    tool: str,
    workspace: str,
    *,
    status: str,
    complete: bool,
    reason: str | None,
    result: dict[str, Any] | None,
    omissions: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "schema": _ENVELOPE_SCHEMA,
        "tool": tool,
        "status": status,
        "complete": complete,
        "workspace": workspace,
        "reason": reason,
        "result": result,
        "omissions": omissions,
    }


def _failure(tool: str, workspace: str, reason: str) -> dict[str, Any]:
    status = "refused" if reason in {"unknown_workspace", "path_refused"} else "unknown"
    return _envelope(
        tool,
        workspace,
        status=status,
        complete=False,
        reason=reason,
        result=None,
        omissions=[{"kind": "adapter_refusal", "reason": reason, "count": 1}],
    )


def _serialized_envelope(envelope: dict[str, Any]) -> str:
    return json.dumps(envelope, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _call_result_wire_size(
    envelope: dict[str, Any],
    serialized: str,
    *,
    is_error: bool,
) -> int:
    payload = {
        "content": [{"type": "text", "text": serialized}],
        "structuredContent": envelope,
        "isError": is_error,
    }
    return len(
        json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    )


def _bounded_call_result(envelope: dict[str, Any], *, is_error: bool) -> CallToolResult:
    serialized = _serialized_envelope(envelope)
    # The structured result and JSON-escaped compatibility text both enter the
    # wire response. Keep a fixed allowance for the JSON-RPC envelope.
    if (
        _call_result_wire_size(envelope, serialized, is_error=is_error) + 4_096
        > MAX_TOOL_RESPONSE_BYTES
    ):
        envelope = _failure(envelope["tool"], envelope["workspace"], "response_limit_exceeded")
        serialized = _serialized_envelope(envelope)
        is_error = True
    return CallToolResult(
        content=[TextContent(type="text", text=serialized)],
        structured_content=envelope,
        is_error=is_error,
    )

class _Diagnostics:
    _EVENTS = frozenset(
        {
            "server_started",
            "discovery_served",
            "tool_started",
            "tool_completed",
            "tool_refused",
            "tool_cancelled",
            "tool_timed_out",
            "server_stopped",
        }
    )
    _SAFE_REASON_RE = re.compile(r"\A[a-z][a-z0-9_]{0,63}\Z")

    def __init__(self, mode: str, stream: Any | None = None):
        if mode not in {"off", "errors", "json"}:
            raise ValueError("invalid observability mode")
        self._mode = mode
        self._stream = sys.stderr if stream is None else stream
        self._sequence = 0
        self._lock = threading.Lock()

    def emit(
        self,
        event: str,
        *,
        tool: str | None = None,
        outcome: str | None = None,
        reason: str | None = None,
        elapsed_ms: int | None = None,
        input_bytes: int | None = None,
        output_bytes: int | None = None,
    ) -> None:
        if (
            self._mode == "off"
            or event not in self._EVENTS
            or self._mode == "errors"
            and event not in {"tool_refused", "tool_cancelled", "tool_timed_out"}
        ):
            return
        safe = {
            "schema": "vivary.mcp-observability/v0",
            "event": event,
        }
        if tool in _TOOL_NAMES:
            safe["tool"] = tool
        if outcome in {"known", "unknown", "refused", "cancelled"}:
            safe["outcome"] = outcome
        if (
            isinstance(reason, str)
            and self._SAFE_REASON_RE.fullmatch(reason)
        ):
            safe["reason"] = reason
        for key, value in (
            ("elapsed_ms", elapsed_ms),
            ("input_bytes", input_bytes),
            ("output_bytes", output_bytes),
        ):
            if type(value) is int and 0 <= value <= 9_007_199_254_740_991:
                safe[key] = value

        with self._lock:
            self._sequence += 1
            safe["sequence"] = self._sequence
            if self._mode == "json":
                line = json.dumps(
                    safe,
                    ensure_ascii=True,
                    separators=(",", ":"),
                    sort_keys=True,
                ) + "\n"
            else:
                fields = [
                    "vivary-mcp",
                    f"event={safe['event']}",
                    f"sequence={safe['sequence']}",
                ]
                for key in ("tool", "outcome", "reason", "elapsed_ms"):
                    if key in safe:
                        fields.append(f"{key}={safe[key]}")
                line = " ".join(fields) + "\n"
            if len(line.encode("utf-8")) > MAX_DIAGNOSTIC_BYTES:
                return
            try:
                self._stream.write(line)
                self._stream.flush()
            except (OSError, UnicodeError, ValueError):
                return


def _json_size(value: Any) -> int:
    try:
        return len(
            json.dumps(
                value,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        )
    except (TypeError, UnicodeError, ValueError):
        return 0


def _elapsed_milliseconds(started: float) -> int:
    return max(0, int((time.monotonic() - started) * 1_000))


class VivaryMcpServer:
    """One static, local, read-only MCP server over immutable workspace aliases."""

    def __init__(
        self,
        workspaces: Mapping[str, Workspace],
        *,
        observability: str = "errors",
        diagnostic_stream: Any | None = None,
    ):
        owned_workspaces = _WorkspaceRegistry()
        try:
            for alias, workspace in workspaces.items():
                if alias != workspace.alias:
                    raise ValueError("workspace registry is inconsistent")
                owned_workspaces[alias] = _clone_workspace(workspace)
            self._workspaces = owned_workspaces
            self._tools = _build_tools()
            self._active = False
            self._active_lock = threading.Lock()
            self._diagnostics = _Diagnostics(observability, diagnostic_stream)
            self.server = Server(
                "vivary",
                version=__version__,
                instructions=(
                    "Read-only local context. Workspace aliases are operator configured; "
                    "no tool can mutate state, run a caller command, or expand authority."
                ),
                on_list_tools=self._list_tools,
                on_call_tool=self._call_tool,
            )
        except BaseException:
            owned_workspaces.close()
            raise

    async def _list_tools(
        self,
        _ctx: ServerRequestContext[Any],
        params: PaginatedRequestParams | None,
    ) -> ListToolsResult:
        if params is not None and getattr(params, "cursor", None) is not None:
            raise MCPError(code=INVALID_PARAMS, message="Invalid cursor")
        self._diagnostics.emit("discovery_served", outcome="known")
        return ListToolsResult(tools=list(self._tools))

    def _begin_call(self) -> bool:
        with self._active_lock:
            if self._active:
                return False
            self._active = True
            return True

    def _end_call(self) -> None:
        with self._active_lock:
            self._active = False

    def close(self) -> None:
        self._workspaces.close()

    async def _run_producer(
        self,
        tool: str,
        workspace: Workspace,
        arguments: Mapping[str, Any],
    ) -> tuple[dict[str, Any] | None, str | None, str]:
        if not self._begin_call():
            return None, "server_busy", "refused"

        loop = asyncio.get_running_loop()
        future: asyncio.Future[
            tuple[dict[str, Any] | None, str | None, str]
        ] = loop.create_future()

        def finish(
            value: tuple[dict[str, Any] | None, str | None, str]
        ) -> None:
            if not future.done():
                future.set_result(value)
        cancelled = threading.Event()

        def worker() -> None:
            try:
                result = _produce(
                    tool,
                    workspace.root,
                    arguments,
                    cancelled.is_set,
                )
                if type(result) is not dict:
                    raise TypeError("producer result must be an object")
                if not _workspace_available(workspace):
                    raise FileNotFoundError("workspace identity changed")
                _assert_result_safe(result, workspace)
                value = (result, None, "known")
            except BaseException as error:
                value = (None, _reason_for_exception(error), "refused")
            finally:
                self._end_call()
            with suppress(RuntimeError):
                loop.call_soon_threadsafe(finish, value)

        worker_thread = threading.Thread(
            target=worker,
            name="vivary-mcp-producer",
            daemon=True,
        )
        try:
            worker_thread.start()
        except RuntimeError:
            self._end_call()
            return None, "producer_unavailable", "refused"

        async def cancel_and_join() -> None:
            cancelled.set()
            with suppress(TimeoutError):
                await asyncio.wait_for(
                    asyncio.shield(future),
                    PRODUCER_CANCELLATION_GRACE_SECONDS,
                )

        try:
            return await asyncio.wait_for(
                asyncio.shield(future),
                PRODUCER_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            await cancel_and_join()
            return None, "producer_unavailable", "timed_out"
        except asyncio.CancelledError:
            await cancel_and_join()
            raise

    async def _call_tool(
        self,
        _ctx: ServerRequestContext[Any],
        params: CallToolRequestParams,
    ) -> CallToolResult:
        started = time.monotonic()
        input_bytes = _json_size(params.arguments or {})
        if params.name not in _TOOL_NAMES:
            self._diagnostics.emit(
                "tool_refused",
                outcome="refused",
                reason="invalid_tool",
                elapsed_ms=_elapsed_milliseconds(started),
                input_bytes=input_bytes,
            )
            raise MCPError(code=INVALID_PARAMS, message="Unknown tool")
        try:
            arguments = _validate_arguments(params.name, params.arguments or {})
        except _InvalidArguments:
            self._diagnostics.emit(
                "tool_refused",
                tool=params.name,
                outcome="refused",
                reason="invalid_arguments",
                elapsed_ms=_elapsed_milliseconds(started),
                input_bytes=input_bytes,
            )
            raise MCPError(
                code=INVALID_PARAMS,
                message="Invalid tool arguments",
            ) from None

        self._diagnostics.emit(
            "tool_started",
            tool=params.name,
            input_bytes=input_bytes,
        )
        alias = arguments["workspace"]
        workspace = self._workspaces.get(alias)
        reason = None
        if workspace is None:
            reason = "unknown_workspace"
        elif not _workspace_available(workspace):
            reason = "workspace_unavailable"
        if reason is not None:
            envelope = _failure(params.name, alias, reason)
            self._diagnostics.emit(
                "tool_refused",
                tool=params.name,
                outcome=envelope["status"],
                reason=reason,
                elapsed_ms=_elapsed_milliseconds(started),
                input_bytes=input_bytes,
                output_bytes=_json_size(envelope),
            )
            return _bounded_call_result(envelope, is_error=True)

        try:
            result, reason, outcome = await self._run_producer(
                params.name,
                workspace,
                arguments,
            )
        except asyncio.CancelledError:
            self._diagnostics.emit(
                "tool_cancelled",
                tool=params.name,
                outcome="cancelled",
                reason="producer_unavailable",
                elapsed_ms=_elapsed_milliseconds(started),
                input_bytes=input_bytes,
            )
            raise
        if reason is not None:
            envelope = _failure(params.name, alias, reason)
            self._diagnostics.emit(
                "tool_timed_out" if outcome == "timed_out" else "tool_refused",
                tool=params.name,
                outcome=envelope["status"],
                reason=reason,
                elapsed_ms=_elapsed_milliseconds(started),
                input_bytes=input_bytes,
                output_bytes=_json_size(envelope),
            )
            return _bounded_call_result(envelope, is_error=True)
        assert result is not None
        envelope = _envelope(
            params.name,
            alias,
            status="known",
            complete=bool(result.get("complete", True)),
            reason=None,
            result=result,
            omissions=[],
        )
        self._diagnostics.emit(
            "tool_completed",
            tool=params.name,
            outcome="known",
            elapsed_ms=_elapsed_milliseconds(started),
            input_bytes=input_bytes,
            output_bytes=_json_size(envelope),
        )
        return _bounded_call_result(envelope, is_error=False)

    async def run_stdio(self) -> None:
        self._diagnostics.emit("server_started", outcome="known")
        try:
            with _claimed_stdio() as (wire_input, wire_output):
                stdin = _BoundedStdin(wire_input)
                stdout = anyio.wrap_file(
                    TextIOWrapper(wire_output, encoding="utf-8", newline="\n")
                )
                async with stdio_server(
                    stdin=stdin,
                    stdout=stdout,
                ) as (read_stream, write_stream):
                    await self.server.run(
                        read_stream,
                        write_stream,
                        self.server.create_initialization_options(),
                    )
        finally:
            try:
                self._diagnostics.emit("server_stopped", outcome="known")
            finally:
                self.close()


class _BoundedStdin:
    def __init__(self, stream: Any):
        self._stream = stream
        self._closed = False

    def __aiter__(self) -> _BoundedStdin:
        return self

    async def __anext__(self) -> str:
        if self._closed:
            raise StopAsyncIteration
        raw = await anyio.to_thread.run_sync(self._stream.readline, MAX_STDIN_LINE_BYTES + 1)
        if not raw:
            self._closed = True
            raise StopAsyncIteration
        if len(raw) > MAX_STDIN_LINE_BYTES or not raw.endswith(b"\n"):
            self._closed = True
            return "{\n"
        try:
            return raw.decode("utf-8", "strict")
        except UnicodeDecodeError:
            self._closed = True
            return "{\n"


def _rebind_windows_standard_handle(fd: int) -> None:
    if os.name != "nt":
        return
    import ctypes
    import msvcrt

    selector = -10 if fd == 0 else -11
    ctypes.windll.kernel32.SetStdHandle(selector, msvcrt.get_osfhandle(fd))


@contextmanager
def _claimed_stdio() -> Iterator[tuple[Any, Any]]:
    """Divert ambient fd 0/1 while preserving private MCP wire duplicates."""

    with suppress(Exception):
        sys.stdout.flush()
    saved_input = os.dup(0)
    saved_output = os.dup(1)
    wire_input_fd = os.dup(saved_input)
    wire_output_fd = os.dup(saved_output)
    null_input = os.open(os.devnull, os.O_RDONLY)
    diverted_output = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(null_input, 0)
        os.dup2(diverted_output, 1)
        _rebind_windows_standard_handle(0)
        _rebind_windows_standard_handle(1)
        wire_input = os.fdopen(wire_input_fd, "rb", closefd=True)
        wire_output = os.fdopen(wire_output_fd, "wb", closefd=True)
        wire_input_fd = wire_output_fd = -1
        try:
            yield wire_input, wire_output
        finally:
            with suppress(Exception):
                wire_output.flush()
            wire_input.close()
            wire_output.close()
    finally:
        with suppress(OSError):
            os.dup2(saved_input, 0)
        with suppress(OSError):
            os.dup2(saved_output, 1)
        with suppress(Exception):
            _rebind_windows_standard_handle(0)
            _rebind_windows_standard_handle(1)
        for descriptor in (
            saved_input,
            saved_output,
            wire_input_fd,
            wire_output_fd,
            null_input,
            diverted_output,
        ):
            if descriptor >= 0:
                with suppress(OSError):
                    os.close(descriptor)


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="vivary-mcp",
        description="Serve bounded read-only Vivary context over local MCP stdio.",
    )
    parser.add_argument(
        "--workspace",
        action="append",
        nargs=2,
        metavar=("ALIAS", "PATH"),
        required=True,
        help="allow one immutable workspace alias and canonical root; repeatable",
    )
    parser.add_argument(
        "--observability",
        choices=("off", "errors", "json"),
        default="errors",
        help="write bounded sanitized diagnostics to stderr",
    )
    parser.add_argument("--version", action="version", version=f"vivary-mcp {__version__}")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    registry: _WorkspaceRegistry | None = None
    try:
        registry = workspace_registry(args.workspace)
        application = VivaryMcpServer(
            registry,
            observability=args.observability,
        )
        registry.close()
        registry = None
    except (ImportError, ValueError):
        if registry is not None:
            registry.close()
        parser.error("workspace or producer contract unavailable")
    try:
        anyio.run(application.run_stdio, backend="asyncio")
    finally:
        application.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
