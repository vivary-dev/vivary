from __future__ import annotations
import importlib.util
import tomllib

import asyncio
import io
import json
import os
import sys
import threading
import time
import types
from pathlib import Path
from unittest.mock import patch

import anyio
import pytest


ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT.parent / "core"
if str(CORE) not in sys.path:
    sys.path.insert(0, str(CORE))


class FakeMCPError(Exception):
    def __init__(self, *, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class FakeRecord:
    def __init__(self, **values):
        self.__dict__.update(values)


class FakeServer:
    def __init__(self, name, **values):
        self.name = name
        self.values = values

    def create_initialization_options(self):
        return {}

    async def run(self, *_args, **_kwargs):
        return None


@pytest.fixture(scope="module")
def adapter():
    fake_mcp = types.ModuleType("mcp")
    fake_mcp.MCPError = FakeMCPError
    fake_server = types.ModuleType("mcp.server")
    fake_server.Server = FakeServer
    fake_server.ServerRequestContext = object
    fake_stdio = types.ModuleType("mcp.server.stdio")

    class FakeStdio:
        async def __aenter__(self):
            return object(), object()

        async def __aexit__(self, *_args):
            return False

    fake_stdio.stdio_server = lambda **_kwargs: FakeStdio()
    fake_types = types.ModuleType("mcp.types")
    fake_types.INVALID_PARAMS = -32602
    for name in (
        "CallToolRequestParams",
        "CallToolResult",
        "ListToolsResult",
        "PaginatedRequestParams",
        "TextContent",
        "Tool",
        "ToolAnnotations",
    ):
        setattr(fake_types, name, FakeRecord)

    previous = {name: sys.modules.get(name) for name in ("mcp", "mcp.server", "mcp.server.stdio", "mcp.types")}
    sys.modules.update(
        {
            "mcp": fake_mcp,
            "mcp.server": fake_server,
            "mcp.server.stdio": fake_stdio,
            "mcp.types": fake_types,
        }
    )
    try:
        spec = importlib.util.spec_from_file_location("vivary_mcp_under_test", ROOT / "vivary_mcp.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        assert spec.loader is not None
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.modules.pop("vivary_mcp_under_test", None)
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


def test_contract_pins_current_protocol_schema_and_unrun_harness(adapter):
    assert adapter.PROTOCOL_VERSION == "2026-07-28"
    assert adapter.MCP_SCHEMA_REVISION == "mcp-types==2.0.0"
    assert (
        adapter.CONFORMANCE_HARNESS_REVISION
        == "@modelcontextprotocol/conformance@0.2.0-alpha.10"
    )
    assert adapter._TOOL_NAMES == (
        "vivary_find",
        "vivary_query",
        "vivary_check",
        "vivary_capsule",
    )

def test_package_identity_matches_candidate_manifest(adapter):
    manifest = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))[
        "project"
    ]
    assert adapter.__version__ == manifest["version"] == "0.1.3"
    assert "vivary-tropo>=0.5.3" in manifest["dependencies"]


def test_all_input_schemas_are_closed_local_draft_2020_12_objects(adapter):
    for schema in (
        adapter._FIND_INPUT_SCHEMA,
        adapter._QUERY_INPUT_SCHEMA,
        adapter._CHECK_INPUT_SCHEMA,
        adapter._CAPSULE_INPUT_SCHEMA,
    ):
        assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
        assert schema["type"] == "object"
        assert schema["additionalProperties"] is False
        assert "$ref" not in json.dumps(schema)


def test_output_envelope_is_closed_and_copies_producer_schema(adapter):
    producer = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {"schema": {"const": "producer/v0"}},
        "required": ["schema"],
        "additionalProperties": False,
    }
    output = adapter._output_schema(producer)
    producer["properties"]["schema"]["const"] = "changed"
    assert output["additionalProperties"] is False
    assert output["$defs"]["producer"]["properties"]["schema"]["const"] == "producer/v0"
    assert not any(
        isinstance(value, str) and value.startswith(("http://", "https://"))
        for key, value in adapter._walk_json(output["$defs"])
        if key == "$ref"
    )


def test_workspace_registry_requires_unique_aliases_and_roots(adapter, tmp_path):
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    registry = adapter.workspace_registry((("alpha", str(first)), ("beta", str(second))))
    assert tuple(registry) == ("alpha", "beta")
    assert registry["alpha"].root.replace("\\", "/").endswith("/first")

    with pytest.raises(ValueError, match="unique"):
        adapter.workspace_registry((("alpha", str(first)), ("alpha", str(second))))
    with pytest.raises(ValueError, match="unique"):
        adapter.workspace_registry((("alpha", str(first)), ("beta", str(first))))
    with pytest.raises(ValueError, match="alias"):
        adapter.workspace_registry((("not allowed", str(first)),))


def test_workspace_identity_change_fails_closed(adapter, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    registry = adapter.workspace_registry((("workspace", str(root)),))
    workspace = registry["workspace"]
    assert adapter._workspace_available(workspace)
    note = root / "note.md"
    note.write_text("ordinary workspace writes stay allowed\n", encoding="utf-8")
    assert adapter._workspace_available(workspace)
    note.unlink()
    if os.name == "nt":
        root.rename(tmp_path / "original-workspace")
    else:
        root.rmdir()
    root.mkdir()
    assert not adapter._workspace_available(workspace)
    registry.close()
    registry.close()
    assert not adapter._workspace_available(workspace)


@pytest.mark.skipif(os.name != "nt", reason="Windows FILE_ID_INFO only")
def test_windows_registration_refuses_zero_file_id(adapter, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()

    with patch.object(adapter, "_WINDOWS_GET_FILE_INFO_EX", return_value=True):
        with pytest.raises(ValueError, match="workspace path refused"):
            adapter.workspace_registry((("workspace", str(root)),))


def test_servers_own_independent_workspace_anchors(adapter, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    registry = adapter.workspace_registry((("docs", str(root)),))

    with patch.object(adapter, "_build_tools", return_value=()):
        first = adapter.VivaryMcpServer(registry)
        second = adapter.VivaryMcpServer(registry)

    registry.close()
    assert adapter._workspace_available(first._workspaces["docs"])
    assert adapter._workspace_available(second._workspaces["docs"])

    first.close()
    assert not adapter._workspace_available(first._workspaces["docs"])
    assert adapter._workspace_available(second._workspaces["docs"])

    second.close()
    assert not adapter._workspace_available(second._workspaces["docs"])


def test_tool_argument_validation_is_strict_and_bounded(adapter):
    assert adapter._validate_arguments(
        "vivary_find", {"workspace": "docs", "question": "Where is policy?"}
    ) == {
        "workspace": "docs",
        "question": "Where is policy?",
        "limit": 5,
        "budget": 1200,
    }
    with pytest.raises(adapter._InvalidArguments):
        adapter._validate_arguments(
            "vivary_find",
            {"workspace": "docs", "question": "question", "unexpected": True},
        )
    with pytest.raises(adapter._InvalidArguments):
        adapter._validate_arguments(
            "vivary_query",
            {"workspace": "docs", "text": "query", "limit": 21},
        )
    with pytest.raises(adapter._InvalidArguments):
        adapter._validate_arguments(
            "vivary_check",
            {"workspace": "docs", "paths": ["../private.md"]},
        )
    with pytest.raises(adapter._InvalidArguments):
        adapter._validate_arguments(
            "vivary_capsule",
            {"workspace": "docs", "question": "question", "max_claims": 25},
        )


def test_result_firewall_refuses_machine_paths_and_credentials(adapter, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    workspace = adapter.workspace_registry((("docs", str(root)),))["docs"]
    adapter._assert_result_safe({"path": "guides/start.md", "text": "public"}, workspace)
    for url in (
        "https://example.test/public/docs",
        "https://[::1]/public/docs",
    ):
        adapter._assert_result_safe({"text": f"see {url}"}, workspace)

    with pytest.raises(ValueError, match="workspace path"):
        adapter._assert_result_safe({"text": f"read {workspace.root}/secret.md"}, workspace)
    for absolute_path in (
        "/home/user/secret.md",
        "/usr/local/private.txt",
        "/data/private.txt",
        "see `/usr/local/private.txt`",
        "source:/data/private.txt",
        "see [docs](https://example.test/public)/usr/local/private.txt",
        "see `https://example.test/public`/data/private.txt",
    ):
        with pytest.raises(ValueError, match="absolute path"):
            adapter._assert_result_safe({"path": absolute_path}, workspace)
    with pytest.raises(ValueError, match="credential"):
        adapter._assert_result_safe(
            {"text": "https://user:password@example.test/repository.git"}, workspace
        )
    with pytest.raises(ValueError, match="unsafe text"):
        adapter._assert_result_safe(
            {"text": "password\u200b=do-not-disclose"},
            workspace,
        )
    with pytest.raises(ValueError, match="credential"):
        adapter._assert_result_safe(
            {"text": "ｐａｓｓｗｏｒｄ=do-not-disclose"},
            workspace,
        )


def test_failure_envelope_never_contains_machine_state(adapter):
    failure = adapter._failure("vivary_query", "docs", "privacy_policy_unavailable")
    assert failure == {
        "schema": "vivary.mcp-tool-result/v0",
        "tool": "vivary_query",
        "status": "unknown",
        "complete": False,
        "workspace": "docs",
        "reason": "privacy_policy_unavailable",
        "result": None,
        "omissions": [
            {
                "kind": "adapter_refusal",
                "reason": "privacy_policy_unavailable",
                "count": 1,
            }
        ],
    }


def test_oversize_result_becomes_typed_failure(adapter):
    envelope = adapter._envelope(
        "vivary_query",
        "docs",
        status="known",
        complete=True,
        reason=None,
        result={"schema": "producer/v0", "value": "x" * adapter.MAX_TOOL_RESPONSE_BYTES},
        omissions=[],
    )
    call_result = adapter._bounded_call_result(envelope, is_error=False)
    assert call_result.is_error is True
    assert call_result.structured_content["reason"] == "response_limit_exceeded"
    assert len(call_result.content[0].text.encode("utf-8")) < 1024


def test_response_bound_counts_json_escaped_compatibility_text(adapter):
    envelope = adapter._envelope(
        "vivary_query",
        "docs",
        status="known",
        complete=True,
        reason=None,
        result={"schema": "producer/v0", "value": '"' * 10_000},
        omissions=[],
    )
    serialized = adapter._serialized_envelope(envelope)
    old_estimate = len(serialized.encode("utf-8")) * 2 + 4_096
    exact_size = (
        adapter._call_result_wire_size(
            envelope,
            serialized,
            is_error=False,
        )
        + 4_096
    )
    assert exact_size > old_estimate

    with patch.object(adapter, "MAX_TOOL_RESPONSE_BYTES", old_estimate):
        call_result = adapter._bounded_call_result(envelope, is_error=False)

    assert call_result.is_error is True
    assert call_result.structured_content["reason"] == "response_limit_exceeded"


def test_stdin_line_limit_accepts_bound_and_refuses_overflow(adapter):
    accepted = adapter._BoundedStdin(io.BytesIO(b"{}" + b" " * (adapter.MAX_STDIN_LINE_BYTES - 3) + b"\n"))
    assert anyio.run(accepted.__anext__) .endswith("\n")

    refused = adapter._BoundedStdin(io.BytesIO(b"x" * adapter.MAX_STDIN_LINE_BYTES + b"\n"))
    assert anyio.run(refused.__anext__) == "{\n"
    with pytest.raises(StopAsyncIteration):
        anyio.run(refused.__anext__)


def test_server_advertises_only_static_tool_handlers(adapter, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    registry = adapter.workspace_registry((("docs", str(root)),))
    with patch.object(adapter, "_build_tools", return_value=()):
        application = adapter.VivaryMcpServer(registry)
    callbacks = application.server.values
    assert set(key for key, value in callbacks.items() if value is not None) == {
        "version",
        "instructions",
        "on_list_tools",
        "on_call_tool",
    }


def test_single_active_call_refuses_concurrency_until_worker_finishes(adapter, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    registry = adapter.workspace_registry((("docs", str(root)),))
    started = threading.Event()
    release = threading.Event()
    stop = threading.Event()
    workers = []

    def producer(_tool, _root, _arguments, cancelled):
        workers.append(threading.current_thread())
        started.set()
        while not release.wait(0.01):
            if cancelled() or stop.is_set():
                return {"schema": "producer/v0", "complete": False}
        return {"schema": "producer/v0", "complete": True}

    try:
        with patch.object(adapter, "_build_tools", return_value=()), patch.object(
            adapter, "_produce", producer
        ):
            application = adapter.VivaryMcpServer(registry)

            async def exercise():
                first = asyncio.create_task(
                    application._run_producer("vivary_query", registry["docs"], {})
                )
                assert await anyio.to_thread.run_sync(started.wait, 1)
                second = await application._run_producer("vivary_query", registry["docs"], {})
                release.set()
                first_result = await first
                return first_result, second

            first_result, second = anyio.run(exercise)
    finally:
        stop.set()
        release.set()
        for worker in workers:
            worker.join(timeout=1)

    assert first_result[1] is None
    assert second[:2] == (None, "server_busy")
    assert second[2] == "refused"
    assert workers and all(not worker.is_alive() for worker in workers)
    assert application._active is False


def test_cancelled_producer_observes_callback_and_releases_active_slot(adapter, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    registry = adapter.workspace_registry((("docs", str(root)),))
    started = threading.Event()
    cancellation_observed = threading.Event()
    exited = threading.Event()
    stop = threading.Event()
    workers = []
    invocations = 0

    def producer(_tool, _root, _arguments, cancelled):
        nonlocal invocations
        invocations += 1
        if invocations == 2:
            return {"schema": "producer/v0", "complete": True, "retry": True}
        workers.append(threading.current_thread())
        started.set()
        try:
            while not stop.is_set():
                if cancelled():
                    cancellation_observed.set()
                    return {"schema": "producer/v0", "complete": False}
                time.sleep(0.001)
            return {"schema": "producer/v0", "complete": False}
        finally:
            exited.set()

    try:
        with patch.object(adapter, "_build_tools", return_value=()), patch.object(
            adapter, "_produce", producer
        ):
            application = adapter.VivaryMcpServer(registry)

            async def exercise():
                task = asyncio.create_task(
                    application._run_producer("vivary_query", registry["docs"], {})
                )
                assert await anyio.to_thread.run_sync(started.wait, 1)
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
                return await application._run_producer(
                    "vivary_query", registry["docs"], {}
                )

            retry = anyio.run(exercise)
    finally:
        stop.set()
        for worker in workers:
            worker.join(timeout=1)

    assert cancellation_observed.is_set()
    assert exited.is_set()
    assert workers and all(not worker.is_alive() for worker in workers)
    assert application._active is False
    assert retry == (
        {"schema": "producer/v0", "complete": True, "retry": True},
        None,
        "known",
    )


def test_timeout_cleans_up_cooperative_worker_and_recovers_active_slot(adapter, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    registry = adapter.workspace_registry((("docs", str(root)),))
    started = threading.Event()
    cancellation_observed = threading.Event()
    exited = threading.Event()
    stop = threading.Event()
    workers = []
    invocations = 0

    def producer(_tool, _root, _arguments, cancelled):
        nonlocal invocations
        invocations += 1
        workers.append(threading.current_thread())
        if invocations == 2:
            return {"schema": "producer/v0", "complete": True, "retry": True}
        started.set()
        try:
            while not stop.is_set():
                if cancelled():
                    cancellation_observed.set()
                    return {"schema": "producer/v0", "complete": False}
                time.sleep(0.001)
            return {"schema": "producer/v0", "complete": False}
        finally:
            exited.set()

    try:
        with (
            patch.object(adapter, "_build_tools", return_value=()),
            patch.object(adapter, "_produce", producer),
            patch.object(adapter, "PRODUCER_TIMEOUT_SECONDS", 0.05),
            patch.object(adapter, "PRODUCER_CANCELLATION_GRACE_SECONDS", 1.0),
        ):
            application = adapter.VivaryMcpServer(registry)

            async def exercise():
                first = asyncio.create_task(
                    application._run_producer("vivary_query", registry["docs"], {})
                )
                assert await anyio.to_thread.run_sync(started.wait, 1)
                timed_out = await first
                retry = await application._run_producer("vivary_query", registry["docs"], {})
                return timed_out, retry

            timed_out, retry = anyio.run(exercise)
    finally:
        stop.set()
        for worker in workers:
            worker.join(timeout=1)

    assert timed_out == (None, "producer_unavailable", "timed_out")
    assert retry == (
        {"schema": "producer/v0", "complete": True, "retry": True},
        None,
        "known",
    )
    assert cancellation_observed.is_set()
    assert exited.is_set()
    assert len(workers) == 2
    assert all(not worker.is_alive() for worker in workers)
    assert application._active is False


def test_timeout_quarantines_slot_until_noncooperative_worker_exits(adapter, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    registry = adapter.workspace_registry((("docs", str(root)),))
    started = threading.Event()
    release = threading.Event()
    workers = []
    invocations = 0

    def producer(_tool, _root, _arguments, _cancelled):
        nonlocal invocations
        invocations += 1
        workers.append(threading.current_thread())
        if invocations == 1:
            started.set()
            release.wait(timeout=2)
            return {"schema": "producer/v0", "complete": False}
        return {"schema": "producer/v0", "complete": True, "retry": True}

    try:
        with (
            patch.object(adapter, "_build_tools", return_value=()),
            patch.object(adapter, "_produce", producer),
            patch.object(adapter, "PRODUCER_TIMEOUT_SECONDS", 0.02),
            patch.object(adapter, "PRODUCER_CANCELLATION_GRACE_SECONDS", 0.02),
        ):
            application = adapter.VivaryMcpServer(registry)

            async def exercise():
                begin = time.monotonic()
                timed_out = await application._run_producer(
                    "vivary_query", registry["docs"], {}
                )
                elapsed = time.monotonic() - begin
                blocked = await application._run_producer(
                    "vivary_query", registry["docs"], {}
                )
                invocations_before_release = invocations
                release.set()
                while application._active:
                    await anyio.sleep(0.001)
                retry = await application._run_producer(
                    "vivary_query", registry["docs"], {}
                )
                return (
                    timed_out,
                    elapsed,
                    blocked,
                    invocations_before_release,
                    retry,
                )

            timed_out, elapsed, blocked, before_release, retry = anyio.run(exercise)
    finally:
        release.set()
        for worker in workers:
            worker.join(timeout=1)

    assert timed_out == (None, "producer_unavailable", "timed_out")
    assert elapsed < 0.5
    assert blocked == (None, "server_busy", "refused")
    assert before_release == 1
    assert retry == (
        {"schema": "producer/v0", "complete": True, "retry": True},
        None,
        "known",
    )
    assert len(workers) == 2
    assert all(not worker.is_alive() for worker in workers)
    assert application._active is False


def test_worker_exit_releases_active_slot_for_next_call(adapter, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    registry = adapter.workspace_registry((("docs", str(root)),))
    workers = []
    invocations = 0

    def producer(_tool, _root, _arguments, cancelled):
        nonlocal invocations
        assert not cancelled()
        invocations += 1
        workers.append(threading.current_thread())
        if invocations == 1:
            raise RuntimeError("producer stopped")
        return {"schema": "producer/v0", "complete": True}

    with patch.object(adapter, "_build_tools", return_value=()), patch.object(
        adapter, "_produce", producer
    ):
        application = adapter.VivaryMcpServer(registry)

        async def exercise():
            failed = await application._run_producer("vivary_query", registry["docs"], {})
            retry = await application._run_producer("vivary_query", registry["docs"], {})
            return failed, retry

        failed, retry = anyio.run(exercise)

    assert failed == (None, "producer_unavailable", "refused")
    assert retry == ({"schema": "producer/v0", "complete": True}, None, "known")
    for worker in workers:
        worker.join(timeout=1)
    assert len(workers) == 2
    assert all(not worker.is_alive() for worker in workers)
    assert application._active is False


def test_workspace_identity_is_revalidated_after_production(adapter, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    registry = adapter.workspace_registry((("docs", str(root)),))

    def producer(_tool, _root, _arguments, _cancelled):
        root.rename(tmp_path / "original-workspace")
        root.mkdir()
        return {"schema": "producer/v0", "complete": True}

    with patch.object(adapter, "_build_tools", return_value=()), patch.object(
        adapter,
        "_produce",
        producer,
    ):
        application = adapter.VivaryMcpServer(registry)
        result = anyio.run(
            application._run_producer,
            "vivary_query",
            registry["docs"],
            {},
        )

    assert result == (None, "workspace_unavailable", "refused")
    assert application._active is False
    application.close()


def test_diagnostics_modes_emit_only_safe_bounded_stderr_fields(adapter):
    off_stream = io.StringIO()
    adapter._Diagnostics("off", off_stream).emit(
        "tool_refused",
        tool="vivary_query",
        outcome="refused",
        reason="secret=/private/path",
    )
    assert off_stream.getvalue() == ""

    errors_stream = io.StringIO()
    errors = adapter._Diagnostics("errors", errors_stream)
    errors.emit("tool_started", tool="vivary_query", outcome="known")
    errors.emit(
        "tool_refused",
        tool="vivary_query",
        outcome="refused",
        reason="secret=/private/path",
        elapsed_ms=12,
        input_bytes=99,
        output_bytes=101,
    )
    assert errors_stream.getvalue() == (
        "vivary-mcp event=tool_refused sequence=1 tool=vivary_query "
        "outcome=refused elapsed_ms=12\n"
    )

    json_stream = io.StringIO()
    diagnostics = adapter._Diagnostics("json", json_stream)
    diagnostics.emit(
        "tool_completed",
        tool="vivary_query",
        outcome="known",
        reason="safe_reason",
        elapsed_ms=12,
        input_bytes=99,
        output_bytes=101,
    )
    diagnostics.emit(
        "tool_completed",
        tool="not_a_tool",
        outcome="unsafe",
        reason="secret=/private/path",
        elapsed_ms=-1,
        input_bytes=9_007_199_254_740_992,
        output_bytes=True,
    )
    records = [json.loads(line) for line in json_stream.getvalue().splitlines()]
    assert records == [
        {
            "schema": "vivary.mcp-observability/v0",
            "event": "tool_completed",
            "tool": "vivary_query",
            "outcome": "known",
            "reason": "safe_reason",
            "elapsed_ms": 12,
            "input_bytes": 99,
            "output_bytes": 101,
            "sequence": 1,
        },
        {
            "schema": "vivary.mcp-observability/v0",
            "event": "tool_completed",
            "sequence": 2,
        },
    ]
    assert all(
        len(line.encode("utf-8")) <= adapter.MAX_DIAGNOSTIC_BYTES
        for line in json_stream.getvalue().splitlines(keepends=True)
    )
    assert "/private/path" not in errors_stream.getvalue()
    assert "/private/path" not in json_stream.getvalue()


def test_claimed_stdio_diverts_and_restores_descriptors_portably(adapter):
    class Wire:
        def __init__(self):
            self.closed = False
            self.flushes = 0

        def close(self):
            self.closed = True

        def flush(self):
            self.flushes += 1

    class DescriptorOps:
        devnull = "null-device"
        O_RDONLY = 1
        O_WRONLY = 2

        def __init__(self, input_stream, output_stream):
            self._duplicates = iter((10, 11, 12, 13))
            self._opens = iter((14, 15))
            self._streams = iter((input_stream, output_stream))
            self.close_calls = []
            self.dup2_calls = []
            self.dup_calls = []
            self.fdopen_calls = []
            self.open_calls = []

        def close(self, descriptor):
            self.close_calls.append(descriptor)

        def dup(self, descriptor):
            self.dup_calls.append(descriptor)
            return next(self._duplicates)

        def dup2(self, source, target):
            self.dup2_calls.append((source, target))

        def fdopen(self, descriptor, mode, closefd=True):
            self.fdopen_calls.append((descriptor, mode, closefd))
            return next(self._streams)

        def open(self, path, flags):
            self.open_calls.append((path, flags))
            return next(self._opens)

    wire_input = Wire()
    wire_output = Wire()
    descriptors = DescriptorOps(wire_input, wire_output)
    rebindings = []
    with (
        patch.object(adapter, "os", descriptors),
        patch.object(
            adapter,
            "_rebind_windows_standard_handle",
            side_effect=rebindings.append,
        ),
    ):
        with pytest.raises(RuntimeError, match="exercise cleanup"):
            with adapter._claimed_stdio() as (claimed_input, claimed_output):
                assert claimed_input is wire_input
                assert claimed_output is wire_output
                raise RuntimeError("exercise cleanup")

    assert descriptors.dup_calls == [0, 1, 10, 11]
    assert descriptors.open_calls == [
        (descriptors.devnull, descriptors.O_RDONLY),
        (descriptors.devnull, descriptors.O_WRONLY),
    ]
    assert descriptors.dup2_calls == [(14, 0), (15, 1), (10, 0), (11, 1)]
    assert descriptors.fdopen_calls == [(12, "rb", True), (13, "wb", True)]
    assert wire_input.closed is True
    assert wire_output.closed is True
    assert wire_output.flushes == 1
    assert rebindings == [0, 1, 0, 1]
    assert descriptors.close_calls == [10, 11, 14, 15]
