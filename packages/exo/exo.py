#!/usr/bin/env python3
"""exo - the coordination layer.

The outermost, thinnest stratum: engaged only when one agent becomes many. exo does
not *run* agents (that's the harness/loops) — it reasons about coordination over the
shared tropo graph and hands workers their role contracts:

  - `exo conflicts`  who would collide — active work items that touch the same node
  - `exo board`      what's in flight — work items grouped by status
  - `exo claim`      claim ownership of a work item in the graph
  - `exo roles`      the bounded worker contracts (strato's role grammar)

Graph-native and deterministic: it reads tropo's graph in-process (no fork, no second
state store) and writes only explicit coordination fields that the workspace opts into.
Most workspaces never need exo; single-agent workspaces stop at tropo + strato.

Usage:
  exo [conflicts] [--root DIR] [--json]
  exo board [--root DIR] [--json]
  exo claim <id> --agent <handle> [--root DIR] [--json]
  exo roles [--json]
"""
import argparse
import datetime
import importlib.util
import json
import os
import platform
import re
import sys
import tempfile
import time

__version__ = "0.3.1"
RECEIPT_ENV = "VIVARY_RECEIPT_LOG"
RECEIPT_SCHEMA = "vivary.run_receipt.v1"
COMMANDS = ("conflicts", "board", "claim", "roles")
RECEIPT_VALUE_FLAGS = {"--agent", "--receipt", "--root"}
RECEIPT_KNOWN_FLAGS = RECEIPT_VALUE_FLAGS | {
    "--help", "--json", "--version", "-h",
}

CONTROL_REQUEST_SCHEMA = "vivary.exo-control-request/v0"
CONTROL_RESULT_SCHEMA = "vivary.exo-control-result/v0"
CONTROL_REFUSAL_SCHEMA = "vivary.exo-control-refusal/v0"
CONTROL_REQUEST_FIELDS = frozenset({"schema", "operation", "state", "input"})
CONTROL_OPERATION_STATE_FIELDS = {
    "claim": frozenset({"claims"}),
    "release": frozenset({"claims"}),
    "expire_leases": frozenset({"claims"}),
    "dependencies": frozenset({"tasks"}),
    "handoff": frozenset({"claims"}),
    "record_execution": frozenset({"execution_log"}),
    "complete": frozenset({"task", "execution_log"}),
    "task_view": frozenset({"task", "execution_log"}),
}
CONTROL_OPERATION_INPUT_FIELDS = {
    "claim": frozenset({"scope", "actor", "now", "authority_class", "lease"}),
    "release": frozenset({"claim_id", "actor"}),
    "expire_leases": frozenset({"now"}),
    "dependencies": frozenset({"task_id"}),
    "handoff": frozenset({
        "claim_id",
        "receipt",
        "capsule",
        "from_actor",
        "to_actor",
        "workspace_revision",
        "created_at",
        "to_authority_class",
    }),
    "record_execution": frozenset({"receipt", "capsule"}),
    "complete": frozenset(),
    "task_view": frozenset(),
}
CONTROL_OPERATION_REQUIRED_INPUT_FIELDS = {
    "claim": frozenset({"scope", "actor", "now"}),
    "release": frozenset({"claim_id", "actor"}),
    "expire_leases": frozenset({"now"}),
    "dependencies": frozenset({"task_id"}),
    "handoff": frozenset({
        "claim_id",
        "receipt",
        "capsule",
        "from_actor",
        "to_actor",
        "workspace_revision",
        "created_at",
    }),
    "record_execution": frozenset({"receipt", "capsule"}),
    "complete": frozenset(),
    "task_view": frozenset(),
}
CONTROL_MAX_REQUEST_BYTES = 1024 * 1024
CONTROL_MAX_DEPTH = 64
CONTROL_MAX_COLLECTION_LENGTH = 10_000
CONTROL_MAX_STRING_BYTES = 1024 * 1024
CONTROL_MAX_VALUES_VISITED = 100_000
CONTROL_REASON_INVALID_DOCUMENT = "invalid_request_document"
CONTROL_REASON_INVALID_VALUE = "invalid_json_value"
CONTROL_REASON_TOO_DEEP = "request_too_deeply_nested"
CONTROL_REASON_TOO_LARGE = "request_too_large"
CONTROL_REASON_UNBOUNDED = "request_work_unbounded"
RECEIPT_RESERVED_WINDOWS_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

# Work items live under changes/ (folder-as-type); a node's coordination role is its
# top-level folder, independent of the resolved type name.
ROLE_FOLDERS = {"modules": "module", "changes": "change", "decisions": "decision",
                "verification": "verification", "gates": "gate"}

# strato's role grammar (STRATO.md) — the bounded contracts workers are spawned with.
ROLES = [
    ("Orchestrator", "intent, scope, gates, synthesis"),
    ("Scout", "paths, confidence, gaps"),
    ("Researcher", "fact / inference / recommendation, with credits"),
    ("Builder", "one slice + changed paths + checks"),
    ("Verifier", "pass / fail / skipped / risk — no silent edits"),
    ("Reviewer", "findings first"),
    ("Archivist", "notes, handoffs; PRIV kept separate"),
]
AGENT_RE = re.compile(r"^@?[A-Za-z0-9._-]+$")


class ExoError(Exception):
    pass


def _load_tropo():
    """Load the tropo engine in-process. Prefers the in-repo sibling
    `../tropo/tropo.py`; when installed, falls back to the `vivary-tropo`
    dependency (`import tropo`)."""
    here = os.path.dirname(os.path.abspath(__file__))
    sibling = os.path.join(os.path.dirname(here), "tropo", "tropo.py")
    if os.path.isfile(sibling):
        spec = importlib.util.spec_from_file_location("exo_tropo", sibling)
        if spec is None or spec.loader is None:
            raise ExoError(f"could not load tropo engine: {sibling}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, os.path.dirname(sibling)
    try:
        import tropo as module
    except ImportError as e:
        raise ExoError(f"tropo engine not found (install vivary-tropo): {e}")
    return module, os.path.dirname(os.path.abspath(module.__file__))


def _workspace_docs(root):
    tropo, tropo_dir = _load_tropo()
    start = root or os.getcwd()
    found = tropo.find_root(start)
    if found is None:
        raise ExoError(f"no tropo.toml found walking up from {os.path.abspath(start)}")
    resolver = tropo.ConfigResolver(found, tropo_dir)
    docs = tropo.analyze(resolver.root, [], resolver)
    return tropo, resolver, docs


def workspace_state(root):
    """Resolve the graph and enrich nodes with `status`/`assignee` from frontmatter.
    Returns (tropo, info, edges) where info maps id -> {id,type,path,status,assignee}."""
    tropo, _resolver, docs = _workspace_docs(root)
    _nodes, edges = tropo.build_graph(docs)
    info = {}
    for d in docs:
        nid = d.derived.get("id")
        if nid is None:
            continue
        fields = d.fields or {}
        info[nid] = {"id": nid, "type": d.type, "path": d.rel.replace("\\", "/"),
                     "status": fields.get("status"), "assignee": fields.get("assignee")}
    return tropo, info, edges


def role_of(node):
    parts = node["path"].split("/")
    return ROLE_FOLDERS.get(parts[0]) if len(parts) > 1 else None


def _outbound_targets(edges):
    out = {}
    for e in edges:
        out.setdefault(e["from"], set()).add(e["to"])
    return out


def find_conflicts(info, edges):
    """Pairs of *active* work items (changes with status `active`) that share an
    outbound target — i.e. two in-flight changes touching the same node. The graph's
    collision signal."""
    out = _outbound_targets(edges)
    active = sorted(nid for nid, n in info.items()
                    if role_of(n) == "change" and n["status"] == "active")
    conflicts = []
    for i in range(len(active)):
        for j in range(i + 1, len(active)):
            a, b = active[i], active[j]
            shared = sorted(out.get(a, set()) & out.get(b, set()))
            if shared:
                conflicts.append({"a": a, "b": b, "shared": shared})
    return active, conflicts


def cmd_conflicts(args):
    try:
        _tropo, info, edges = workspace_state(args.root)
    except ExoError as e:
        sys.exit(f"exo: {e}")
    active, conflicts = find_conflicts(info, edges)
    if args.json:
        print(json.dumps({"active": active, "conflicts": conflicts}, indent=2))
    elif not conflicts:
        print(f"exo: no conflicts among {len(active)} active work item(s)")
    else:
        print(f"exo: {len(conflicts)} conflict(s) among {len(active)} active work item(s):")
        for c in conflicts:
            print(f"  {c['a']} <-> {c['b']}  share: {', '.join(c['shared'])}")
    return 0


def cmd_board(args):
    try:
        _tropo, info, _edges = workspace_state(args.root)
    except ExoError as e:
        sys.exit(f"exo: {e}")
    items = sorted((n for n in info.values() if role_of(n) == "change"),
                   key=lambda n: (n["status"] or "~", n["id"]))
    if args.json:
        print(json.dumps({"items": [
            {"id": n["id"], "status": n["status"], "assignee": n["assignee"]}
            for n in items]}, indent=2))
    elif not items:
        print("exo: no work items (changes) found")
    else:
        print(f"exo: {len(items)} work item(s)")
        for n in items:
            who = f"  @{n['assignee']}" if n["assignee"] else ""
            print(f"  [{n['status'] or 'no status'}]  {n['id']}{who}")
    return 0


def _normalize_agent(agent):
    if not agent or not AGENT_RE.match(agent):
        raise ExoError(
            f"invalid agent handle {agent!r}; use letters, numbers, '.', '_', '-' and optional leading @")
    return agent[1:] if agent.startswith("@") else agent


def _doc_by_id(docs, target_id):
    for doc in docs:
        if doc.derived.get("id") == target_id:
            return doc
    return None


def _claim_target_candidate(root, target_id):
    if not target_id or any(sep in target_id for sep in (os.sep, os.altsep) if sep):
        return None
    if target_id in (".", "..") or "\x00" in target_id:
        return None
    return os.path.join(root, "changes", f"{target_id}.md")


def _ensure_assignee_declared(tropo, resolver, doc):
    config = resolver.for_dir(os.path.dirname(doc.full))
    _required, known = config.fields_for(doc.type)
    if "assignee" not in known:
        raise ExoError(
            'assignee is not declared for this workspace; add packs = ["coordination"] to tropo.toml')


def _ensure_workspace_file(root, doc):
    root_real = os.path.realpath(root)
    doc_real = os.path.realpath(doc.full)
    try:
        common = os.path.commonpath([root_real, doc_real])
    except ValueError:
        common = None
    if common != root_real or os.path.islink(doc.full):
        raise ExoError(f"{doc.rel}: refusing to claim symlinked or out-of-workspace file")


def _ensure_no_pruned_claim_target(root, target_id):
    candidate = _claim_target_candidate(root, target_id)
    if not candidate or not os.path.lexists(candidate):
        return
    root_real = os.path.realpath(root)
    candidate_real = os.path.realpath(candidate)
    try:
        common = os.path.commonpath([root_real, candidate_real])
    except ValueError:
        common = None
    if common != root_real or os.path.islink(candidate):
        rel = os.path.relpath(candidate, root)
        raise ExoError(f"{rel}: refusing to claim symlinked or out-of-workspace file")


def _write_assignee(tropo, root, doc, assignee):
    with open(doc.full, encoding="utf-8") as fh:
        text = fh.read()
    yaml_text, body = tropo.extract_frontmatter(text)
    if yaml_text is None:
        if body.startswith("---"):
            raise ExoError(f"{doc.rel}: malformed frontmatter")
        previous = None
        _replace_workspace_file(root, doc, f"---\nassignee: {assignee}\n---\n{body}")
        return previous, True

    try:
        data = tropo.parse_yaml(yaml_text)
    except tropo.YamlError as e:
        raise ExoError(f"{doc.rel}: frontmatter is not valid YAML: {e}")
    if not isinstance(data, dict):
        raise ExoError(f"{doc.rel}: frontmatter must be a mapping")

    fields = tropo.strip_meta(data)
    previous = fields.get("assignee")
    if previous == assignee:
        return previous, False

    lines = yaml_text.splitlines()
    line_map = data.get("__lines__", {})
    if "assignee" in line_map:
        lines[line_map["assignee"] - 1] = f"assignee: {assignee}"
    else:
        lines.append(f"assignee: {assignee}")
    new_yaml = "\n".join(lines).rstrip()
    _replace_workspace_file(root, doc, f"---\n{new_yaml}\n---\n{body}")
    return previous, True


def _replace_workspace_file(root, doc, text):
    path = doc.full
    directory = os.path.dirname(path) or os.curdir
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{os.path.basename(path)}.",
        suffix=".exo-tmp",
        dir=directory,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        _ensure_workspace_file(root, doc)
        os.replace(tmp_name, path)
    finally:
        if os.path.lexists(tmp_name):
            os.unlink(tmp_name)


def cmd_claim(args):
    try:
        assignee = _normalize_agent(args.agent)
        tropo, resolver, docs = _workspace_docs(args.root)
        doc = _doc_by_id(docs, args.target)
        if doc is None:
            _ensure_no_pruned_claim_target(resolver.root, args.target)
            raise ExoError(f"no work item with id {args.target!r}")
        node = {"path": doc.rel.replace("\\", "/")}
        if role_of(node) != "change":
            raise ExoError(f"{args.target!r} is not a work item under changes/")
        _ensure_assignee_declared(tropo, resolver, doc)
        _ensure_workspace_file(resolver.root, doc)
        previous, changed = _write_assignee(tropo, resolver.root, doc, assignee)
    except ExoError as e:
        sys.exit(f"exo: {e}")

    result = {
        "id": args.target,
        "path": doc.rel.replace("\\", "/"),
        "assignee": assignee,
        "previous_assignee": previous,
        "changed": changed,
    }
    if args.json:
        print(json.dumps(result, indent=2))
    elif changed:
        print(f"exo: claimed {args.target} for @{assignee}")
    else:
        print(f"exo: {args.target} already claimed by @{assignee}")
    return 0


def cmd_roles(args):
    if args.json:
        print(json.dumps({"roles": [{"role": r, "contract": c} for r, c in ROLES]}, indent=2))
    else:
        print("exo: role contracts (workers get bounded contracts; never product owners)")
        for r, c in ROLES:
            print(f"  {r:13} {c}")
    return 0


def _extract_receipt_path(argv):
    for index, token in enumerate(argv):
        if token == "--":
            break
        if token == "--receipt":
            if index + 1 < len(argv) and not argv[index + 1].startswith("-"):
                return argv[index + 1], "flag"
            return None, None
        if token.startswith("--receipt="):
            path = token.split("=", 1)[1]
            return (path, "flag") if path else (None, None)
    env_path = os.environ.get(RECEIPT_ENV)
    if env_path:
        return env_path, "env"
    return None, None

def _control_request_path(argv):
    if not argv or argv[0] != "control":
        return None
    options_ended = False
    skip_value = False
    for token in argv[1:]:
        if skip_value:
            skip_value = False
            continue
        if not options_ended:
            if token == "--":
                options_ended = True
                continue
            if token == "--receipt":
                skip_value = True
                continue
            if token.startswith("--receipt="):
                continue
            if token != "-" and token.startswith("-"):
                continue
        return token
    return None


def _receipt_targets_control_request(request_path, receipt_path):
    if request_path is None or not receipt_path:
        return False
    if request_path == "-":
        return True
    try:
        request_target = os.path.realpath(
            os.path.abspath(os.path.expanduser(request_path))
        )
        receipt_target = os.path.realpath(
            os.path.abspath(os.path.expanduser(receipt_path))
        )
        if os.path.normcase(request_target) == os.path.normcase(receipt_target):
            return True
        return os.path.samefile(request_target, receipt_target)
    except (OSError, ValueError, AttributeError):
        return False


def _receipt_flags(argv):
    flags = set()
    skip_value = False
    for token in argv:
        if token == "--":
            break
        if skip_value:
            skip_value = False
            continue
        if token.startswith("--"):
            name = token.split("=", 1)[0]
            if name in RECEIPT_KNOWN_FLAGS and name != "--receipt":
                flags.add(name)
            if name in RECEIPT_VALUE_FLAGS and "=" not in token:
                skip_value = True
        elif token in RECEIPT_KNOWN_FLAGS:
            flags.add(token)
    return sorted(flags)


def _receipt_command(argv):
    if "--version" in argv:
        return "version"
    if any(token in ("-h", "--help") for token in argv):
        return "help"
    skip_value = False
    for token in argv:
        if token == "--":
            break
        if skip_value:
            skip_value = False
            continue
        if token.startswith("--"):
            name = token.split("=", 1)[0]
            if name in RECEIPT_VALUE_FLAGS and "=" not in token:
                skip_value = True
            continue
        if token == "control" or token in COMMANDS:
            return token
    return "conflicts"


def _exit_code_value(code):
    if code is None:
        return 0
    if isinstance(code, int):
        return code
    return 1


def _receipt_is_reserved_windows_path(path):
    if os.name != "nt":
        return False
    stem = os.path.basename(os.path.normpath(path)).split(".", 1)[0].rstrip(" .").upper()
    return stem in RECEIPT_RESERVED_WINDOWS_NAMES


def _receipt_has_symlink_ancestor(path):
    target = os.path.abspath(os.path.expanduser(path))
    current = os.path.dirname(target) or os.getcwd()
    while True:
        if os.path.lexists(current) and (
            os.path.islink(current)
            or (
                hasattr(os.path, "isjunction")
                and os.path.isjunction(current)
            )
        ):
            return True
        parent = os.path.dirname(current)
        if parent == current:
            return False
        current = parent


def _receipt_error_message(exc):
    message = str(exc)
    safe_messages = {
        "receipt path must not be a Windows device name",
        "receipt path must not be a symlink",
        "receipt path must be a regular file",
        "receipt path must not contain a symlink or junction directory",
    }
    if message in safe_messages:
        return message
    return "could not write receipt; check that the receipt path is a writable regular file"


def _append_run_receipt(
    *,
    tool,
    version,
    argv,
    started_at,
    exit_code,
    receipt_path,
    receipt_source,
    error_type=None,
):
    if not receipt_path:
        return True

    target = os.path.expanduser(receipt_path)
    parent = os.path.dirname(os.path.abspath(target)) or os.getcwd()
    try:
        if _receipt_is_reserved_windows_path(target):
            raise OSError("receipt path must not be a Windows device name")
        if _receipt_has_symlink_ancestor(target):
            raise OSError("receipt path must not contain a symlink or junction directory")
        if os.path.lexists(target):
            if os.path.islink(target):
                raise OSError("receipt path must not be a symlink")
            if not os.path.isfile(target):
                raise OSError("receipt path must be a regular file")
        os.makedirs(parent, exist_ok=True)
        if _receipt_has_symlink_ancestor(target):
            raise OSError("receipt path must not contain a symlink or junction directory")

        record = {
            "schema": RECEIPT_SCHEMA,
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "tool": tool,
            "version": version,
            "command": _receipt_command(argv),
            "flags": _receipt_flags(argv),
            "arg_count": len(argv),
            "exit_code": exit_code,
            "ok": exit_code == 0,
            "duration_ms": int((time.monotonic() - started_at) * 1000),
            "python": platform.python_version(),
            "platform": platform.system(),
            "receipt_source": receipt_source,
        }
        if error_type:
            record["error_type"] = error_type
        with open(target, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(record, sort_keys=True, separators=(",", ":")))
            fh.write("\n")
    except OSError as e:
        print(f"{tool}: receipt: {_receipt_error_message(e)}", file=sys.stderr)
        return False
    return True

def _control_refusal(reason_codes):
    return {
        "schema": CONTROL_REFUSAL_SCHEMA,
        "reason_codes": list(dict.fromkeys(reason_codes)),
    }


def _control_string_within_limit(value):
    if len(value) > CONTROL_MAX_STRING_BYTES:
        return False
    encoded_length = 0
    for character in value:
        codepoint = ord(character)
        if codepoint <= 0x7F:
            encoded_length += 1
        elif codepoint <= 0x7FF:
            encoded_length += 2
        elif codepoint <= 0xFFFF:
            encoded_length += 3
        else:
            encoded_length += 4
        if encoded_length > CONTROL_MAX_STRING_BYTES:
            return False
    return True


def _control_preflight_reason(request):
    """Bound a direct JSON-like request without recursively walking it."""
    values_visited = 0
    active_containers = set()
    stack = [("value", request, 0)]

    while stack:
        frame = stack.pop()
        frame_kind = frame[0]
        if frame_kind == "exit":
            active_containers.discard(frame[1])
            continue
        if frame_kind == "list_items":
            try:
                item = next(frame[1])
            except StopIteration:
                continue
            stack.append(frame)
            stack.append(("value", item, frame[2]))
            continue
        if frame_kind == "dict_items":
            try:
                key, item = next(frame[1])
            except StopIteration:
                continue
            stack.append(frame)
            stack.append(("value", item, frame[2]))
            stack.append(("value", key, frame[2]))
            continue

        item = frame[1]
        depth = frame[2]
        values_visited += 1
        if values_visited > CONTROL_MAX_VALUES_VISITED:
            return CONTROL_REASON_UNBOUNDED

        item_type = type(item)
        if item_type is str:
            if not _control_string_within_limit(item):
                return CONTROL_REASON_UNBOUNDED
            continue
        if item_type in (type(None), bool, int, float):
            continue
        if item_type not in (list, dict):
            return CONTROL_REASON_INVALID_VALUE

        identity = id(item)
        if identity in active_containers:
            return CONTROL_REASON_UNBOUNDED
        next_depth = depth + 1
        if next_depth > CONTROL_MAX_DEPTH:
            return CONTROL_REASON_TOO_DEEP
        if len(item) > CONTROL_MAX_COLLECTION_LENGTH:
            return CONTROL_REASON_UNBOUNDED

        active_containers.add(identity)
        stack.append(("exit", identity))
        if item_type is list:
            stack.append(("list_items", iter(item), next_depth))
        else:
            stack.append(("dict_items", iter(item.items()), next_depth))

    return None


def _load_control_core():
    """Load Core only for the opt-in governed surface."""
    package_root = os.path.dirname(os.path.abspath(__file__))
    sibling_core = os.path.join(os.path.dirname(package_root), "core")
    if (
        os.path.isdir(os.path.join(sibling_core, "vivary_core"))
        and sibling_core not in sys.path
    ):
        sys.path.insert(0, sibling_core)
    from vivary_core import control
    from vivary_core.canonical import is_canonical_body_value

    return control, is_canonical_body_value


def _control_field_errors(value, allowed_fields, required_fields, section):
    if type(value) is not dict:
        return [f"invalid_{section}"]
    fields = set(value)
    errors = []
    errors.extend(
        f"missing_{section}_field:{field}"
        for field in sorted(required_fields - fields)
    )
    errors.extend(
        f"unknown_{section}_field:{field}"
        for field in sorted(fields - allowed_fields)
    )
    return errors


def _validate_control_envelope(request):
    if type(request) is not dict:
        return ["unknown_request_shape"]

    fields = set(request)
    errors = []
    errors.extend(f"missing_field:{field}" for field in sorted(CONTROL_REQUEST_FIELDS - fields))
    errors.extend(f"unknown_field:{field}" for field in sorted(fields - CONTROL_REQUEST_FIELDS))
    if request.get("schema") != CONTROL_REQUEST_SCHEMA:
        errors.append("invalid_schema")

    operation = request.get("operation")
    if type(operation) is not str or operation not in CONTROL_OPERATION_STATE_FIELDS:
        errors.append("invalid_operation")
    if errors:
        return errors

    errors.extend(
        _control_field_errors(
            request["state"],
            CONTROL_OPERATION_STATE_FIELDS[operation],
            CONTROL_OPERATION_STATE_FIELDS[operation],
            "state",
        )
    )
    errors.extend(
        _control_field_errors(
            request["input"],
            CONTROL_OPERATION_INPUT_FIELDS[operation],
            CONTROL_OPERATION_REQUIRED_INPUT_FIELDS[operation],
            "input",
        )
    )
    return errors


def _dispatch_governed_control(core, operation, state, input_value):
    if operation == "claim":
        return core.request_claim(active_claims=state["claims"], request=input_value)
    if operation == "release":
        return core.release_claim(
            active_claims=state["claims"],
            claim_id=input_value["claim_id"],
            actor=input_value["actor"],
        )
    if operation == "expire_leases":
        return core.expire_leases(active_claims=state["claims"], now=input_value["now"])
    if operation == "dependencies":
        return core.evaluate_dependencies(tasks=state["tasks"], task_id=input_value["task_id"])
    if operation == "handoff":
        return core.create_handoff(
            active_claims=state["claims"],
            claim_id=input_value["claim_id"],
            receipt=input_value["receipt"],
            capsule=input_value["capsule"],
            from_actor=input_value["from_actor"],
            to_actor=input_value["to_actor"],
            workspace_revision=input_value["workspace_revision"],
            created_at=input_value["created_at"],
            to_authority_class=input_value.get("to_authority_class"),
        )
    if operation == "record_execution":
        return core.record_execution(
            log=state["execution_log"],
            receipt=input_value["receipt"],
            capsule=input_value["capsule"],
        )
    if operation == "complete":
        current_view = core.task_integrity_view(
            task=state["task"],
            execution_log=state["execution_log"],
        )
        if current_view["reason_codes"]:
            return {
                "task": None,
                "view": current_view,
                "reason_codes": current_view["reason_codes"],
            }
        transition = core.mark_task_done(task=state["task"])
        if transition["reason_codes"]:
            return {
                "task": None,
                "view": current_view,
                "reason_codes": transition["reason_codes"],
            }
        task = transition["task"]
        view = core.task_integrity_view(
            task=task,
            execution_log=state["execution_log"],
        )
        return {"task": task, "view": view, "reason_codes": view["reason_codes"]}
    if operation == "task_view":
        return core.task_integrity_view(
            task=state["task"],
            execution_log=state["execution_log"],
        )
    raise AssertionError(f"unrecognized governed operation {operation!r}")


def governed_control(request):
    """Dispatch one bounded, caller-owned Core control request."""
    preflight_reason = _control_preflight_reason(request)
    if preflight_reason is not None:
        return _control_refusal([preflight_reason])

    core, is_canonical_body_value = _load_control_core()
    if not is_canonical_body_value(request):
        return _control_refusal([CONTROL_REASON_INVALID_VALUE])

    errors = _validate_control_envelope(request)
    if errors:
        return _control_refusal(errors)

    operation = request["operation"]
    return {
        "schema": CONTROL_RESULT_SCHEMA,
        "operation": operation,
        "result": _dispatch_governed_control(
            core,
            operation,
            request["state"],
            request["input"],
        ),
    }


class _ControlRequestDocumentError(Exception):
    def __init__(self, reason_code):
        super().__init__(reason_code)
        self.reason_code = reason_code


def _reject_control_json_constant(_value):
    raise ValueError("non-JSON numeric constant")


def _control_object_from_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate object field")
        result[key] = value
    return result


def _read_control_request(path):
    try:
        if path == "-":
            source = getattr(sys.stdin, "buffer", sys.stdin)
            document = source.read(CONTROL_MAX_REQUEST_BYTES + 1)
        else:
            with open(path, "rb") as source:
                document = source.read(CONTROL_MAX_REQUEST_BYTES + 1)
    except (OSError, UnicodeError) as error:
        raise _ControlRequestDocumentError(CONTROL_REASON_INVALID_DOCUMENT) from error

    if type(document) is str:
        try:
            document = document.encode("utf-8")
        except UnicodeError as error:
            raise _ControlRequestDocumentError(CONTROL_REASON_INVALID_DOCUMENT) from error
    if type(document) is not bytes:
        raise _ControlRequestDocumentError(CONTROL_REASON_INVALID_DOCUMENT)
    if len(document) > CONTROL_MAX_REQUEST_BYTES:
        raise _ControlRequestDocumentError(CONTROL_REASON_TOO_LARGE)

    try:
        return json.loads(
            document.decode("utf-8"),
            parse_constant=_reject_control_json_constant,
            object_pairs_hook=_control_object_from_pairs,
        )
    except RecursionError as error:
        raise _ControlRequestDocumentError(CONTROL_REASON_TOO_DEEP) from error
    except (UnicodeError, ValueError) as error:
        raise _ControlRequestDocumentError(CONTROL_REASON_INVALID_DOCUMENT) from error


def _emit_control(result, json_output):
    if json_output:
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return

    if result["schema"] == CONTROL_REFUSAL_SCHEMA:
        reasons = result["reason_codes"]
        suffix = f": {', '.join(reasons)}" if reasons else ""
        print(f"exo control: refused{suffix}")
        return

    core_result = result["result"]
    reasons = core_result.get("reason_codes", [])
    decision = core_result.get("decision")
    status = decision if type(decision) is str else ("refused" if reasons else "ok")
    print(f"exo control: {result['operation']} {status}")
    if reasons:
        print(f"reasons: {', '.join(reasons)}")


def _control_strict_failure(result):
    if result["schema"] == CONTROL_REFUSAL_SCHEMA:
        return True
    core_result = result["result"]
    return core_result.get("decision") == "refused" or bool(core_result.get("reason_codes"))


def cmd_control(args):
    try:
        request = _read_control_request(args.request)
    except _ControlRequestDocumentError as error:
        result = _control_refusal([error.reason_code])
    else:
        result = governed_control(request)
    _emit_control(result, args.json)
    return 1 if args.strict and _control_strict_failure(result) else 0


def _main_control(argv, *, prog=None):
    parser = argparse.ArgumentParser(
        prog=prog or "exo control",
        description="Dispatch one governed Core control request.",
        allow_abbrev=False,
    )
    parser.add_argument("request", metavar="REQUEST", help="JSON request path, or - for stdin")
    parser.add_argument("--governed", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--json", action="store_true", help="emit canonical compact JSON")
    parser.add_argument("--strict", action="store_true", help="fail on a refusal or reason code")
    parser.add_argument("--receipt", default=None, metavar="PATH", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if not args.governed:
        parser.error("control requires --governed")
    return cmd_control(args)


def _main(argv=None, *, prog=None):
    if argv and argv[0] == "control":
        return _main_control(argv[1:], prog=prog)
    p = argparse.ArgumentParser(prog=prog or "exo",
                                description="The coordination layer over the tropo graph.")
    p.add_argument("--version", action="version", version=f"exo {__version__}")
    p.add_argument("command", nargs="?", default="conflicts",
                   choices=COMMANDS)
    p.add_argument("target", nargs="?", help="claim: work item id")
    p.add_argument("--agent", default=None, help="claim: agent handle")
    p.add_argument("--root", default=None,
                   help="workspace root (default: walk up for tropo.toml)")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    p.add_argument("--receipt", default=None, metavar="PATH",
                   help=f"append a local privacy-preserving JSONL run receipt (or set {RECEIPT_ENV})")
    args = p.parse_args(argv)
    if args.command == "claim":
        if not args.target:
            p.error("claim requires a work item id")
        if not args.agent:
            p.error("claim requires --agent <handle>")
    return {
        "conflicts": cmd_conflicts,
        "board": cmd_board,
        "claim": cmd_claim,
        "roles": cmd_roles,
    }[args.command](args)


def main(argv=None, *, prog=None):
    """Run exo, naming the program `prog` when a front door supplies one."""
    prog = (prog or "").strip() or None
    name = prog or "exo"
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    receipt_path, receipt_source = _extract_receipt_path(raw_argv)
    request_path = _control_request_path(raw_argv)
    if _receipt_targets_control_request(request_path, receipt_path):
        if _receipt_command(raw_argv) in {"help", "version"}:
            receipt_path, receipt_source = None, None
        else:
            print(
                f"{name}: receipt: receipt path must not identify the governed"
                " control request",
                file=sys.stderr,
            )
            return 2
    started_at = time.monotonic() if receipt_path else None
    try:
        rc = _main(raw_argv, prog=prog)
    except SystemExit as e:
        code = _exit_code_value(e.code)
        receipt_ok = _append_run_receipt(
            tool="exo",
            version=__version__,
            argv=raw_argv,
            started_at=started_at,
            exit_code=code,
            receipt_path=receipt_path,
            receipt_source=receipt_source,
            error_type="SystemExit" if code else None,
        )
        if not receipt_ok and code == 0:
            raise SystemExit(1) from e
        raise
    except Exception as e:
        _append_run_receipt(
            tool="exo",
            version=__version__,
            argv=raw_argv,
            started_at=started_at,
            exit_code=1,
            receipt_path=receipt_path,
            receipt_source=receipt_source,
            error_type=type(e).__name__,
        )
        raise
    receipt_ok = _append_run_receipt(
        tool="exo",
        version=__version__,
        argv=raw_argv,
        started_at=started_at,
        exit_code=_exit_code_value(rc),
        receipt_path=receipt_path,
        receipt_source=receipt_source,
    )
    if not receipt_ok and _exit_code_value(rc) == 0:
        return 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
