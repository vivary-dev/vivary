"""Async wire regressions against the official MCP 2.0.0 SDK."""

from __future__ import annotations

import asyncio
import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path
from typing import Any, Callable

import anyio
import pytest


try:
    _MCP_DISTRIBUTION = distribution("mcp")
    _MCP_TYPES_DISTRIBUTION = distribution("mcp-types")
except PackageNotFoundError:
    pytest.skip("official mcp==2.0.0 and mcp-types==2.0.0 are required", allow_module_level=True)

if _MCP_DISTRIBUTION.version != "2.0.0" or _MCP_TYPES_DISTRIBUTION.version != "2.0.0":
    pytest.skip("official mcp==2.0.0 and mcp-types==2.0.0 are required", allow_module_level=True)

mcp = pytest.importorskip("mcp", reason="official mcp==2.0.0 is required")
types = pytest.importorskip("mcp.types", reason="official mcp==2.0.0 types are required")
mcp_types = pytest.importorskip("mcp_types", reason="official mcp-types==2.0.0 is required")
from mcp.client.stdio import StdioServerParameters, stdio_client


def _belongs_to_distribution(module: Any, package_distribution: Any) -> bool:
    module_file = getattr(module, "__file__", None)
    if not isinstance(module_file, str):
        return False
    return Path(module_file).resolve().is_relative_to(Path(package_distribution.locate_file("")).resolve())


if not _belongs_to_distribution(mcp, _MCP_DISTRIBUTION) or not _belongs_to_distribution(
    mcp_types, _MCP_TYPES_DISTRIBUTION
):
    pytest.skip("mcp imports do not resolve to their installed official distributions", allow_module_level=True)


ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT.parent / "core"
TROPO = ROOT.parent / "tropo"
for package_root in (ROOT, CORE):
    if str(package_root) not in sys.path:
        sys.path.insert(0, str(package_root))

import vivary_mcp


_WIRE_TIMEOUT_SECONDS = 2.0
_SUBPROCESS_WIRE_TIMEOUT_SECONDS = 10.0
_QUERY_ARGUMENTS = {"workspace": "docs", "text": "needle"}
_PRODUCER_SCHEMA = {
    "type": "object",
    "properties": {
        "schema": {"const": "producer/v0"},
        "complete": {"type": "boolean"},
        "marker": {"type": "string"},
    },
    "required": ["schema", "complete", "marker"],
    "additionalProperties": False,
}


def _producer_schemas() -> dict[str, dict[str, Any]]:
    return {name: _PRODUCER_SCHEMA for name in vivary_mcp._TOOL_NAMES}


def _producer_result(marker: str = "ok") -> dict[str, Any]:
    return {"schema": "producer/v0", "complete": True, "marker": marker}


async def _within_wire_deadline(awaitable: Any) -> Any:
    with anyio.fail_after(_WIRE_TIMEOUT_SECONDS):
        return await awaitable


async def _wait_for_thread_event(event: threading.Event) -> None:
    with anyio.fail_after(_WIRE_TIMEOUT_SECONDS):
        observed = await anyio.to_thread.run_sync(event.wait, _WIRE_TIMEOUT_SECONDS)
    assert observed


@asynccontextmanager
async def _connected_adapter(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    producer: Callable[[str, str, dict[str, Any], Callable[[], bool]], dict[str, Any]],
):
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    registry = vivary_mcp.workspace_registry((("docs", str(workspace_root)),))
    monkeypatch.setattr(vivary_mcp, "_load_producer_schemas", _producer_schemas)
    monkeypatch.setattr(vivary_mcp, "_produce", producer)
    application = vivary_mcp.VivaryMcpServer(registry, observability="off")

    client_write, server_read = anyio.create_memory_object_stream(0)
    server_write, client_read = anyio.create_memory_object_stream(0)
    server_stopped = anyio.Event()

    async def serve() -> None:
        try:
            await application.server.run(
                server_read,
                server_write,
                application.server.create_initialization_options(),
            )
        finally:
            server_stopped.set()

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(serve)
        try:
            async with mcp.ClientSession(
                client_read,
                client_write,
                client_info=types.Implementation(name="vivary-sdk-wire-tests", version="2.0.0"),
            ) as client:
                yield application, client
        finally:
            await client_write.aclose()
            with anyio.fail_after(_WIRE_TIMEOUT_SECONDS):
                await server_stopped.wait()
            await client_read.aclose()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def test_official_sdk_distributions_are_exactly_pinned() -> None:
    assert _MCP_DISTRIBUTION.version == "2.0.0"
    assert _MCP_TYPES_DISTRIBUTION.version == "2.0.0"


@pytest.mark.anyio
async def test_discover_derives_tools_capability_exact_tools_and_server_identity(monkeypatch, tmp_path) -> None:
    def producer(_tool: str, _root: str, _arguments: dict[str, Any], _cancelled: Callable[[], bool]) -> dict[str, Any]:
        return _producer_result()

    async with _connected_adapter(monkeypatch, tmp_path, producer) as (application, client):
        discovery = await _within_wire_deadline(client.discover())
        listing = await _within_wire_deadline(client.list_tools())

    assert client.protocol_version == vivary_mcp.PROTOCOL_VERSION == "2026-07-28"
    assert vivary_mcp.PROTOCOL_VERSION in discovery.supported_versions
    assert discovery.capabilities.tools is not None
    assert client.server_capabilities is not None
    assert client.server_capabilities.tools is not None
    assert tuple(tool.name for tool in listing.tools) == vivary_mcp._TOOL_NAMES
    assert len(listing.tools) == 4
    for tool in listing.tools:
        assert tool.output_schema is not None
        assert tool.output_schema["additionalProperties"] is False
        assert tool.output_schema["$defs"]["producer"]["additionalProperties"] is False

    assert client.server_info is not None
    assert client.server_info.name == "vivary"
    assert client.server_info.version == vivary_mcp.__version__
    assert discovery.meta is not None
    assert discovery.meta[types.SERVER_INFO_META_KEY] == {
        "name": "vivary",
        "version": vivary_mcp.__version__,
    }
    assert application.server.server_info.name == "vivary"


@pytest.mark.anyio
async def test_tools_call_returns_output_schema_validated_structured_content(monkeypatch, tmp_path) -> None:
    def producer(_tool: str, _root: str, _arguments: dict[str, Any], _cancelled: Callable[[], bool]) -> dict[str, Any]:
        return _producer_result("validated")

    async with _connected_adapter(monkeypatch, tmp_path, producer) as (_application, client):
        await _within_wire_deadline(client.discover())
        await _within_wire_deadline(client.list_tools())
        result = await _within_wire_deadline(client.call_tool("vivary_query", _QUERY_ARGUMENTS))

    assert result.is_error is False
    assert result.structured_content == {
        "schema": "vivary.mcp-tool-result/v0",
        "tool": "vivary_query",
        "status": "known",
        "complete": True,
        "workspace": "docs",
        "reason": None,
        "result": _producer_result("validated"),
        "omissions": [],
    }


@pytest.mark.anyio
async def test_modern_request_metadata_is_observable_but_not_authority(monkeypatch, tmp_path) -> None:
    observed: list[tuple[str, dict[str, Any]]] = []
    producer_arguments: list[dict[str, Any]] = []

    def producer(_tool: str, _root: str, arguments: dict[str, Any], _cancelled: Callable[[], bool]) -> dict[str, Any]:
        producer_arguments.append(arguments)
        return _producer_result()

    async with _connected_adapter(monkeypatch, tmp_path, producer) as (application, client):
        async def observe_metadata(context, call_next):
            if context.method == "tools/call":
                observed.append((context.protocol_version, dict(context.meta or {})))
            return await call_next(context)

        application.server.middleware.insert(0, observe_metadata)
        await _within_wire_deadline(client.discover())
        result = await _within_wire_deadline(
            client.call_tool(
                "vivary_query",
                _QUERY_ARGUMENTS,
                meta={"vivary.test.authorization": "other-workspace"},
            )
        )

    assert result.is_error is False
    assert result.structured_content["workspace"] == "docs"
    assert producer_arguments and producer_arguments[0]["workspace"] == "docs"
    assert observed
    protocol_version, metadata = observed[0]
    assert protocol_version == vivary_mcp.PROTOCOL_VERSION
    assert metadata[types.PROTOCOL_VERSION_META_KEY] == vivary_mcp.PROTOCOL_VERSION
    assert metadata[types.CLIENT_INFO_META_KEY] == {
        "name": "vivary-sdk-wire-tests",
        "version": "2.0.0",
    }
    assert types.CLIENT_CAPABILITIES_META_KEY in metadata
    assert metadata["vivary.test.authorization"] == "other-workspace"


@pytest.mark.anyio
async def test_malformed_arguments_and_modern_metadata_recover(monkeypatch, tmp_path) -> None:
    calls: list[dict[str, Any]] = []

    def producer(_tool: str, _root: str, arguments: dict[str, Any], _cancelled: Callable[[], bool]) -> dict[str, Any]:
        calls.append(arguments)
        return _producer_result("recovered")

    async with _connected_adapter(monkeypatch, tmp_path, producer) as (_application, client):
        malformed_metadata_request = types.CallToolRequest(
            params=types.CallToolRequestParams(
                name="vivary_query",
                arguments=_QUERY_ARGUMENTS,
                _meta={types.PROTOCOL_VERSION_META_KEY: vivary_mcp.PROTOCOL_VERSION},
            )
        )
        with pytest.raises(mcp.MCPError) as malformed_metadata:
            await _within_wire_deadline(client.send_request(malformed_metadata_request, types.CallToolResult))
        assert malformed_metadata.value.code == types.INVALID_PARAMS

        await _within_wire_deadline(client.discover())
        with pytest.raises(mcp.MCPError) as malformed_arguments:
            await _within_wire_deadline(
                client.call_tool("vivary_query", {**_QUERY_ARGUMENTS, "unexpected": True})
            )
        assert malformed_arguments.value.code == types.INVALID_PARAMS

        recovered = await _within_wire_deadline(client.call_tool("vivary_query", _QUERY_ARGUMENTS))

    assert recovered.is_error is False
    assert recovered.structured_content["result"] == _producer_result("recovered")
    assert len(calls) == 1


@pytest.mark.anyio
async def test_typed_cancellation_stops_cooperative_producer_before_recovery(monkeypatch, tmp_path) -> None:
    started = threading.Event()
    cancellation_observed = threading.Event()
    exited = threading.Event()
    cancellation_notification_observed = anyio.Event()
    cancelled_notifications: list[Any] = []
    calls = 0

    def producer(_tool: str, _root: str, _arguments: dict[str, Any], cancelled: Callable[[], bool]) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        if calls == 1:
            started.set()
            try:
                while not cancelled():
                    time.sleep(0.001)
                cancellation_observed.set()
                return _producer_result("cancelled")
            finally:
                exited.set()
        assert exited.is_set()
        return _producer_result("recovered")

    async with _connected_adapter(monkeypatch, tmp_path, producer) as (application, client):
        async def observe_cancellation(context, call_next):
            if context.method == "notifications/cancelled":
                cancelled_notifications.append(
                    types.CancelledNotification.model_validate(
                        {"method": context.method, "params": context.params}
                    )
                )
                cancellation_notification_observed.set()
            return await call_next(context)

        application.server.middleware.insert(0, observe_cancellation)
        await _within_wire_deadline(client.discover())
        pending = asyncio.create_task(client.call_tool("vivary_query", _QUERY_ARGUMENTS))
        await _wait_for_thread_event(started)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await _within_wire_deadline(pending)
        with anyio.fail_after(_WIRE_TIMEOUT_SECONDS):
            await cancellation_notification_observed.wait()
        await _wait_for_thread_event(cancellation_observed)
        await _wait_for_thread_event(exited)
        recovered = await _within_wire_deadline(client.call_tool("vivary_query", _QUERY_ARGUMENTS))

    assert recovered.is_error is False
    assert recovered.structured_content["result"] == _producer_result("recovered")
    assert calls == 2
    assert len(cancelled_notifications) == 1
    assert cancelled_notifications[0].params.request_id is not None
    assert cancelled_notifications[0].params.reason == "caller cancelled"
    assert application._active is False


@pytest.mark.anyio
async def test_timeout_stops_cooperative_producer_before_recovery(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(vivary_mcp, "PRODUCER_TIMEOUT_SECONDS", 0.05)
    started = threading.Event()
    cancellation_observed = threading.Event()
    exited = threading.Event()
    calls = 0

    def producer(_tool: str, _root: str, _arguments: dict[str, Any], cancelled: Callable[[], bool]) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        if calls == 1:
            started.set()
            try:
                while not cancelled():
                    time.sleep(0.001)
                cancellation_observed.set()
                return _producer_result("timed-out")
            finally:
                exited.set()
        assert exited.is_set()
        return _producer_result("recovered")

    async with _connected_adapter(monkeypatch, tmp_path, producer) as (application, client):
        await _within_wire_deadline(client.discover())
        pending = asyncio.create_task(client.call_tool("vivary_query", _QUERY_ARGUMENTS))
        await _wait_for_thread_event(started)
        timed_out = await _within_wire_deadline(pending)
        await _wait_for_thread_event(cancellation_observed)
        await _wait_for_thread_event(exited)
        recovered = await _within_wire_deadline(client.call_tool("vivary_query", _QUERY_ARGUMENTS))

    assert timed_out.is_error is True
    assert timed_out.structured_content["complete"] is False
    assert timed_out.structured_content["reason"] == "producer_unavailable"
    assert recovered.is_error is False
    assert recovered.structured_content["result"] == _producer_result("recovered")
    assert calls == 2
    assert application._active is False


@pytest.mark.anyio
async def test_official_stdio_client_observes_protocol_only_stdout(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    pythonpath = os.pathsep.join(
        (
            str(ROOT),
            str(CORE),
            str(TROPO),
            os.environ.get("PYTHONPATH", ""),
        )
    )
    parameters = StdioServerParameters(
        command=sys.executable,
        args=[
            str(ROOT / "vivary_mcp.py"),
            "--workspace",
            "docs",
            str(workspace_root.resolve()),
            "--observability",
            "off",
        ],
        env={"PYTHONPATH": pythonpath},
        cwd=str(ROOT),
    )
    diagnostics_path = tmp_path / "diagnostics.log"

    with diagnostics_path.open("w+", encoding="utf-8") as diagnostics:
        with anyio.fail_after(_SUBPROCESS_WIRE_TIMEOUT_SECONDS):
            async with stdio_client(parameters, errlog=diagnostics) as streams:
                async with mcp.ClientSession(
                    *streams,
                    client_info=types.Implementation(
                        name="vivary-stdio-wire-tests",
                        version="2.0.0",
                    ),
                ) as client:
                    discovery = await client.discover()
                    listing = await client.list_tools()
        diagnostics.flush()
        diagnostics.seek(0)
        diagnostic_text = diagnostics.read()

    assert vivary_mcp.PROTOCOL_VERSION in discovery.supported_versions
    assert tuple(tool.name for tool in listing.tools) == vivary_mcp._TOOL_NAMES
    assert diagnostic_text == ""
