"""Tests for the tropo engine. Run: python -m pytest tests/ (or python tests/test_tropo.py)."""
import contextlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import types
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE_ROOT = os.path.abspath(os.path.join(PACKAGE_ROOT, "..", "core"))
sys.path.insert(0, CORE_ROOT)
sys.path.insert(0, PACKAGE_ROOT)
import tropo  # noqa: E402
import vivary_core  # noqa: E402
from vivary_core import normalize_path  # noqa: E402

ROOT = PACKAGE_ROOT
VAULT = os.path.join(ROOT, "examples", "vault")
SCRIPT_DIR = ROOT
REPO_TMP = os.path.abspath(os.path.join(ROOT, "..", "..", "sandboxes"))


def make_tmp_path():
    base = REPO_TMP if os.path.isdir(REPO_TMP) else os.getcwd()
    path = Path(base) / f"test-tropo-{uuid.uuid4().hex}"
    path.mkdir(parents=True)
    return path


def remove_workspace(path):
    def make_writable_and_retry(function, target, _error):
        os.chmod(target, stat.S_IWRITE)
        function(target)

    callback = (
        {"onexc": make_writable_and_retry}
        if sys.version_info >= (3, 12)
        else {"onerror": make_writable_and_retry}
    )
    shutil.rmtree(path, **callback)


@contextmanager
def temp_workspace():
    path = make_tmp_path()
    try:
        yield path
    finally:
        remove_workspace(path)


import argparse  # noqa: E402


def cfg(root=VAULT):
    return tropo.load_config(tropo.find_root(root), SCRIPT_DIR)


def res(root=VAULT):
    """An overlay-aware resolver rooted at the nearest tropo.toml."""
    return tropo.ConfigResolver(tropo.find_root(root), SCRIPT_DIR)


def test_run_receipt_redacts_paths_and_keeps_json_stdout():
    with temp_workspace() as td:
        secret_root = td / "--secret-project-name"
        secret_root.mkdir()
        (secret_root / "note.md").write_text("# Note\n", encoding="utf-8")
        receipt = td / "receipts" / "runs.jsonl"
        buf = io.StringIO()

        with contextlib.redirect_stdout(buf):
            rc = tropo.main([
                "map",
                "--root",
                str(secret_root),
                "--json",
                "--receipt",
                str(receipt),
            ])

        assert rc == 0
        assert json.loads(buf.getvalue())["root"] == "--secret-project-name"
        record = json.loads(receipt.read_text(encoding="utf-8").strip())
        assert record["schema"] == "vivary.run_receipt.v1"
        assert record["tool"] == "tropo"
        assert record["command"] == "map"
        assert record["exit_code"] == 0
        assert record["ok"] is True
        assert "--json" in record["flags"]
        assert "--root" in record["flags"]
        assert "--receipt" not in record["flags"]

        serialized = json.dumps(record, sort_keys=True)
        assert str(secret_root) not in serialized
        assert "--secret-project-name" not in serialized


def test_run_receipt_equals_form_allows_option_like_path_and_malformed_does_not_write():
    with temp_workspace() as td:
        secret_root = td / "workspace"
        secret_root.mkdir()
        (secret_root / "note.md").write_text("# Note\n", encoding="utf-8")
        old_cwd = os.getcwd()
        try:
            os.chdir(td)
            with contextlib.redirect_stdout(io.StringIO()):
                rc = tropo.main([
                    "map",
                    "--root",
                    str(secret_root),
                    "--json",
                    "--receipt=--runs.jsonl",
                ])
            assert rc == 0
            assert (td / "--runs.jsonl").is_file()

            with contextlib.redirect_stderr(io.StringIO()) as err:
                try:
                    tropo.main(["map", "--receipt", "--json"])
                    assert False, "expected argparse SystemExit"
                except SystemExit:
                    pass
            assert not (td / "--json").exists()
            assert "expected one argument" in err.getvalue()
        finally:
            os.chdir(old_cwd)


def test_help_receipt_failure_exits_nonzero_without_raw_path():
    with temp_workspace() as td:
        bad_receipt = td / "not-a-file"
        bad_receipt.mkdir()
        err = io.StringIO()

        with contextlib.redirect_stdout(io.StringIO()):
            with contextlib.redirect_stderr(err):
                try:
                    tropo.main(["--help", "--receipt", str(bad_receipt)])
                    assert False, "expected SystemExit"
                except SystemExit as exc:
                    assert exc.code == 1

        message = err.getvalue()
        assert "receipt path must be a regular file" in message
        assert str(bad_receipt) not in message


def test_query_and_find_receipts_do_not_record_raw_search_text():
    with temp_workspace() as td:
        (td / "tropo.toml").write_text("[base]\nallow_untyped = true\n", encoding="utf-8")
        (td / "note.md").write_text("# Billing Runbook\n\nprivate needle\n", encoding="utf-8")
        receipt = td / "runs.jsonl"
        secret_query = "private needle"

        with contextlib.redirect_stdout(io.StringIO()):
            assert tropo.main([
                "query",
                secret_query,
                "--root",
                str(td),
                "--json",
                "--receipt",
                str(receipt),
            ]) == 0
            assert tropo.main([
                "find",
                secret_query,
                "--root",
                str(td),
                "--json",
                "--receipt",
                str(receipt),
            ]) == 0

        records = [json.loads(line) for line in receipt.read_text(encoding="utf-8").splitlines()]
        assert [record["command"] for record in records] == ["query", "find"]
        serialized = "\n".join(json.dumps(record, sort_keys=True) for record in records)
        assert secret_query not in serialized
        assert str(td) not in serialized


# --- type resolution (folder-as-type) --------------------------------------

def test_folder_is_type():
    c = cfg()
    assert tropo.type_for(os.path.join(VAULT, "people", "jeff.md"), c) == "person"
    assert tropo.type_for(os.path.join(VAULT, "meetings", "x.md"), c) == "meeting"


def test_nesting_resolves_to_nearest_ancestor():
    c = cfg()
    p = os.path.join(VAULT, "projects", "tropo", "decisions", "0001-folder-as-type.md")
    assert tropo.type_for(p, c) == "decision"  # not "project"
    readme = os.path.join(VAULT, "projects", "tropo", "README.md")
    assert tropo.type_for(readme, c) == "project"


def test_untyped_outside_type_roots():
    c = cfg()
    assert tropo.type_for(os.path.join(VAULT, "loose-note.md"), c) is None


def test_folder_aliases(tmp_path):
    (tmp_path / "tropo.toml").write_text(
        '[types.person]\nfolder=["people","contacts"]\nrequired={relationship="string"}\n')
    c = cfg(str(tmp_path))
    assert tropo.type_for(os.path.join(str(tmp_path), "people", "a.md"), c) == "person"
    assert tropo.type_for(os.path.join(str(tmp_path), "contacts", "b.md"), c) == "person"


def test_alias_collision_is_config_error(tmp_path):
    (tmp_path / "tropo.toml").write_text(
        '[types.a]\nfolder="shared"\n[types.b]\nfolder="shared"\n')
    try:
        cfg(str(tmp_path))
        assert False, "expected ConfigError on folder collision"
    except tropo.ConfigError:
        pass


def test_config_accepts_leading_utf8_bom(tmp_path):
    (tmp_path / "tropo.toml").write_text(
        '\ufeff[types.change]\nfolder="changes"\nrequired={status="string"}\n',
        encoding="utf-8",
    )
    (tmp_path / "changes").mkdir()
    (tmp_path / "changes" / "x.md").write_text("---\nstatus: active\n---\n# X\n", encoding="utf-8")
    docs = tropo.analyze(str(tmp_path), [], res(str(tmp_path)))
    assert [d.rel.replace("\\", "/") for d in docs] == ["changes/x.md"]
    assert docs[0].findings == []


# --- derivation ------------------------------------------------------------

def test_id_from_filename():
    assert tropo._derive_id("/v/people/jeff.md") == "jeff"


def test_index_document_id_from_folder():
    assert tropo._derive_id("/v/projects/tropo/README.md") == "tropo"
    assert tropo._derive_id("/v/projects/tropo/tropo.md") == "tropo"
    assert tropo._derive_id("/v/x/index.md") == "x"


def test_title_from_h1():
    d = tropo.derive(os.path.join(VAULT, "people", "jeff.md"), "# Jeff Kazzee\n\nbody")
    assert d["title"] == "Jeff Kazzee"


# --- validation ------------------------------------------------------------

def test_clean_vault_has_no_findings():
    docs = tropo.analyze(VAULT, [], res())  # overlay-aware: decision needs `deciders`
    findings = [f for d in docs for f in d.findings]
    assert findings == [], [f.render() for f in findings]


def test_missing_required_field(tmp_path):
    (tmp_path / "tropo.toml").write_text(
        '[types.person]\nfolder="people"\nrequired={relationship="string"}\n')
    (tmp_path / "people").mkdir()
    (tmp_path / "people" / "x.md").write_text("# X\n")  # no relationship
    docs = tropo.analyze(str(tmp_path), [], res(str(tmp_path)))
    codes = {f.code for d in docs for f in d.findings}
    assert "E101" in codes


def test_derived_value_in_frontmatter_is_noise(tmp_path):
    (tmp_path / "tropo.toml").write_text("[base]\nderive=['id','title']\n")
    (tmp_path / "n.md").write_text("---\nid: n\n---\n# N\n")
    docs = tropo.analyze(str(tmp_path), [], res(str(tmp_path)))
    codes = {f.code for d in docs for f in d.findings}
    assert "W210" in codes  # id: n equals the derived id


def test_extract_frontmatter_accepts_leading_utf8_bom():
    yaml_text, body = tropo.extract_frontmatter("\ufeff---\nstatus: active\n---\n# A\n")
    assert yaml_text == "status: active"
    assert body == "# A\n"


# --- overlays (SPEC §5.5) ---------------------------------------------------

def _decision_tree(tmp_path):
    (tmp_path / "tropo.toml").write_text(
        '[types.decision]\nfolder="decisions"\nrequired={status="string"}\n')
    (tmp_path / "decisions").mkdir()
    (tmp_path / "decisions" / "a.md").write_text("---\nstatus: ok\n---\n# A\n")
    sub = tmp_path / "sub"
    (sub / "decisions").mkdir(parents=True)
    (sub / "tropo.toml").write_text(
        '[types.decision]\nfolder="decisions"\nrequired={owner="string"}\n')
    (sub / "decisions" / "b.md").write_text("---\nstatus: ok\n---\n# B\n")


def test_overlay_tightens_only_its_subtree(tmp_path):
    _decision_tree(tmp_path)
    docs = {d.rel.replace("\\", "/"): d
            for d in tropo.analyze(str(tmp_path), [], res(str(tmp_path)))}
    a_codes = {f.code for f in docs["decisions/a.md"].findings}
    b_codes = {f.code for f in docs[os.path.join("sub", "decisions", "b.md").replace("\\", "/")].findings}
    assert "E101" not in a_codes        # root decision: only status required
    assert "E101" in b_codes            # overlay adds required owner -> missing


# --- fix (de-noise) ---------------------------------------------------------

def test_fix_removes_derived_noise_keeps_real(tmp_path):
    (tmp_path / "tropo.toml").write_text("[base]\nderive=['id','title']\noptional={tags='string-list'}\n")
    f = tmp_path / "n.md"
    f.write_text("---\nid: n\ntags: [a]\n---\n# N\n")
    tropo.cmd_fix(argparse.Namespace(paths=[], dry_run=False, json=False), res(str(tmp_path)))
    txt = f.read_text()
    assert "id: n" not in txt and "tags:" in txt


def test_fix_removes_empty_block(tmp_path):
    (tmp_path / "tropo.toml").write_text("[base]\nderive=['id','title']\n")
    f = tmp_path / "n.md"
    f.write_text("---\nid: n\n---\n# N\n")
    tropo.cmd_fix(argparse.Namespace(paths=[], dry_run=False, json=False), res(str(tmp_path)))
    txt = f.read_text()
    assert not txt.startswith("---") and "# N" in txt


def test_fix_dry_run_writes_nothing(tmp_path):
    (tmp_path / "tropo.toml").write_text("[base]\nderive=['id','title']\n")
    f = tmp_path / "n.md"
    f.write_text("---\nid: n\n---\n# N\n")
    tropo.cmd_fix(argparse.Namespace(paths=[], dry_run=True, json=False), res(str(tmp_path)))
    assert "id: n" in f.read_text()


# --- init -------------------------------------------------------------------

def test_init_writes_loadable_config(tmp_path):
    d = tmp_path / "vault"
    tropo.cmd_init(argparse.Namespace(paths=[str(d)], packs="dev-project"))
    c = tropo.load_config(str(d), SCRIPT_DIR)
    assert "decision" in c.types and "runbook" in c.types


# --- JSON surfaces (agent-consumable) --------------------------------------

def _capture(fn, *a, **k):
    import contextlib
    import io
    import json
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*a, **k)
    return json.loads(buf.getvalue())


def test_check_json_has_summary():
    out = _capture(tropo.cmd_check,
                   argparse.Namespace(paths=[], strict=False, lenient=True,
                                      json=True, quiet=False), res())
    assert set(out) >= {"checked", "clean", "errors", "warnings", "findings"}
    assert out["errors"] == 0


# --- opinionated check: strict by default ----------------------------------

def _bad_vault(td):
    """A vault with one broken ref (W220), one unknown field (W202), and one
    untyped doc (W201) — three warnings, no hard errors."""
    Path(td, "tropo.toml").write_text(
        '[base]\nallow_untyped = true\n'
        '[types.module]\nfolder = "modules"\n'
        '[types.module.optional]\nrelated_modules = "ref-list"\n')
    Path(td, "modules").mkdir()
    Path(td, "modules", "alpha.md").write_text(
        "---\nrelated_modules: [missing]\nstray: x\n---\n# Alpha\n")
    Path(td, "notes").mkdir()
    Path(td, "notes", "loose.md").write_text("# Loose\n")


def _check_rc(root, strict=False, lenient=False):
    import contextlib
    import io
    args = argparse.Namespace(paths=[], strict=strict, lenient=lenient,
                              json=False, quiet=False)
    with contextlib.redirect_stdout(io.StringIO()):
        return tropo.cmd_check(args, res(root))


def test_check_is_strict_by_default():
    with temp_workspace() as td:
        _bad_vault(td)
        assert _check_rc(str(td)) == 1  # warnings fail the check


def test_check_lenient_allows_warnings():
    with temp_workspace() as td:
        _bad_vault(td)
        assert _check_rc(str(td), lenient=True) == 0  # warnings shown, exit 0


def test_check_quiet_hides_warning_codes_after_strict_promotion():
    with temp_workspace() as td:
        _bad_vault(td)
        buf = io.StringIO()
        args = argparse.Namespace(paths=[], strict=False, lenient=False,
                                  json=False, quiet=True)
        with contextlib.redirect_stdout(buf):
            rc = tropo.cmd_check(args, res(str(td)))
        out = buf.getvalue()
        assert rc == 1
        assert "W201" not in out and "W202" not in out and "W220" not in out
        assert "3 error(s)" in out


def test_check_strict_config_false_relaxes_and_flag_overrides():
    with temp_workspace() as td:
        _bad_vault(td)
        p = Path(td, "tropo.toml")
        p.write_text(p.read_text().replace(
            "allow_untyped = true", "allow_untyped = true\nstrict = false"))
        assert _check_rc(str(td)) == 0           # config opts into lenient
        assert _check_rc(str(td), strict=True) == 1  # --strict overrides config


def test_overlay_cannot_loosen_strict():
    with temp_workspace() as td:
        Path(td, "tropo.toml").write_text('[base]\nstrict = true\n')
        sub = Path(td, "sub")
        sub.mkdir()
        Path(sub, "tropo.toml").write_text('[base]\nstrict = false\n')
        try:
            tropo.ConfigResolver(str(td), SCRIPT_DIR).for_dir(str(sub))
            assert False, "expected ConfigError for strict false->true loosening"
        except tropo.ConfigError:
            pass


def test_types_and_stats_json():
    t = _capture(tropo.cmd_types, argparse.Namespace(json=True), res())
    assert "person" in t["types"]
    s = _capture(tropo.cmd_stats, argparse.Namespace(paths=[], json=True), res())
    assert s["total"] >= 1 and "by_type" in s


# --- packs + tighten-only law ----------------------------------------------

def test_pack_composes():
    with temp_workspace() as td:
        with open(os.path.join(td, "tropo.toml"), "w") as fh:
            fh.write('packs = ["dev-project"]\n')
        c = tropo.load_config(td, SCRIPT_DIR)
        assert "runbook" in c.types and "spec" in c.types


def test_pack_composes_without_repo_packs_directory():
    with temp_workspace() as td:
        with open(os.path.join(td, "tropo.toml"), "w") as fh:
            fh.write('packs = ["dev-project"]\n')
        fake_script_dir = os.path.join(td, "installed-wheel")
        os.mkdir(fake_script_dir)
        c = tropo.load_config(td, fake_script_dir)
        assert "runbook" in c.types and "spec" in c.types


def test_workspace_pack_overrides_bundled_pack():
    with temp_workspace() as td:
        pack_dir = os.path.join(td, ".tropo", "packs")
        os.makedirs(pack_dir)
        with open(os.path.join(pack_dir, "dev-project.toml"), "w") as fh:
            fh.write('[types.local]\nfolder = "local"\nrequired = { owner = "string" }\n')
        with open(os.path.join(td, "tropo.toml"), "w") as fh:
            fh.write('packs = ["dev-project"]\n')
        c = tropo.load_config(td, SCRIPT_DIR)
        assert "local" in c.types and "runbook" not in c.types


def test_coordination_pack_declares_assignee():
    with temp_workspace() as td:
        with open(os.path.join(td, "tropo.toml"), "w") as fh:
            fh.write('packs = ["coordination"]\n')
        c = tropo.load_config(td, SCRIPT_DIR)
        assert c.base_optional["assignee"] == "string"


def test_bundled_packs_match_tracked_toml_files():
    for pack_path in Path(SCRIPT_DIR, "packs").glob("*.toml"):
        name = pack_path.stem
        assert name in tropo.BUNDLED_PACKS
        bundled = tropo.tomllib.loads(tropo.BUNDLED_PACKS[name])
        tracked = tropo._read_toml(str(pack_path))
        assert bundled == tracked


def test_repo_graph_pack_composes():
    with temp_workspace() as td:
        with open(os.path.join(td, "tropo.toml"), "w") as fh:
            fh.write('packs = ["repo-graph"]\n')
        c = tropo.load_config(td, SCRIPT_DIR)
        assert "module" in c.types
        assert "implementation_slice" in c.types
        assert "verification" in c.types


def test_tighten_only_law_rejects_loosening():
    base = {"base": {}, "types": {}, "exclude": []}
    tropo._merge_config(base, {"types": {"t": {"folder": "t", "required": {"s": "enum:a|b"}}}})
    # narrowing enum: allowed
    tropo._merge_config(base, {"types": {"t": {"folder": "t", "required": {"s": "enum:a"}}}})
    assert base["types"]["t"]["required"]["s"] == "enum:a"
    # widening enum: forbidden
    try:
        tropo._merge_config(base, {"types": {"t": {"folder": "t", "required": {"s": "enum:a|b|c"}}}})
        assert False, "expected ConfigError on enum widening"
    except tropo.ConfigError:
        pass


def test_tighten_only_rejects_required_to_optional():
    base = {"base": {}, "types": {}, "exclude": []}
    tropo._merge_config(base, {"types": {"t": {"folder": "t", "required": {"s": "string"}}}})
    try:
        tropo._merge_config(base, {"types": {"t": {"folder": "t", "optional": {"s": "string"}}}})
        assert False, "expected ConfigError on required->optional"
    except tropo.ConfigError:
        pass


# --- graph + blast (typed edges) -------------------------------------------

def _graph_tree(tmp_path, files):
    """Write a tree whose base config types `depends_on` (ref) and `related`
    (ref-list), then analyze it. `files` maps name -> file content."""
    (tmp_path / "tropo.toml").write_text(
        "[base]\nderive = ['id', 'title']\n"
        'optional = { depends_on = "ref", related = "ref-list" }\n'
        "allow_untyped = true\n")
    for name, content in files.items():
        (tmp_path / name).write_text(content)
    return tropo.analyze(str(tmp_path), [], res(str(tmp_path)))


def test_build_graph_real_vault():
    nodes, edges = tropo.build_graph(tropo.analyze(VAULT, [], res()))
    assert set(nodes) == {"jeff", "tropo", "2026-06-12-kickoff", "0001-folder-as-type"}
    assert {"from": "2026-06-12-kickoff", "field": "project",
            "to": "tropo", "broken": False} in edges
    assert all(not e["broken"] for e in edges)


def test_iter_markdown_skips_symlinked_file_outside_root(tmp_path):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    secret = outside / "secret.md"
    secret.write_text("# Secret\n", encoding="utf-8")
    link = root / "linked.md"
    try:
        link.symlink_to(secret)
    except (OSError, NotImplementedError):
        return

    found = list(tropo.iter_markdown(str(root), [], []))

    assert found == []


def test_iter_markdown_junction_cycle_not_double_counted_by_analyze(tmp_path):
    import subprocess
    if os.name != "nt":
        return
    root = tmp_path / "root"
    root.mkdir()
    (root / "tropo.toml").write_text("[base]\nderive = ['id', 'title']\nallow_untyped = true\n")
    (root / "a.md").write_text("# A\n", encoding="utf-8")
    loop_parent = root / "nested"
    loop_parent.mkdir()
    link = loop_parent / "loop"
    try:
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(root)],
            capture_output=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return
    if result.returncode != 0:
        return
    try:
        docs = tropo.analyze(str(root), [], res(str(root)))
        assert [doc.rel for doc in docs] == ["a.md"]
    finally:
        os.rmdir(link)


def test_build_graph_marks_broken_ref(tmp_path):
    docs = _graph_tree(tmp_path, {"a.md": "---\ndepends_on: ghost\n---\n# A\n"})
    _, edges = tropo.build_graph(docs)
    assert edges == [{"from": "a", "field": "depends_on", "to": "ghost", "broken": True}]


def test_build_graph_ref_list_is_multiple_edges(tmp_path):
    docs = _graph_tree(tmp_path, {"a.md": "---\nrelated: [b, c]\n---\n# A\n",
                                  "b.md": "# B\n", "c.md": "# C\n"})
    _, edges = tropo.build_graph(docs)
    assert {(e["from"], e["to"]) for e in edges} == {("a", "b"), ("a", "c")}


def test_blast_transitive_closure(tmp_path):
    docs = _graph_tree(tmp_path, {"a.md": "---\ndepends_on: b\n---\n# A\n",
                                  "b.md": "---\ndepends_on: c\n---\n# B\n",
                                  "c.md": "# C\n"})
    _, edges = tropo.build_graph(docs)
    impacted = tropo.blast_radius(edges, "c")
    assert impacted["b"]["distance"] == 1 and impacted["a"]["distance"] == 2
    assert "c" not in impacted  # never includes the target itself


def test_blast_depth_limit(tmp_path):
    docs = _graph_tree(tmp_path, {"a.md": "---\ndepends_on: b\n---\n# A\n",
                                  "b.md": "---\ndepends_on: c\n---\n# B\n",
                                  "c.md": "# C\n"})
    _, edges = tropo.build_graph(docs)
    assert set(tropo.blast_radius(edges, "c", max_depth=1)) == {"b"}


def test_blast_handles_cycle(tmp_path):
    docs = _graph_tree(tmp_path, {"a.md": "---\ndepends_on: b\n---\n# A\n",
                                  "b.md": "---\ndepends_on: a\n---\n# B\n"})
    _, edges = tropo.build_graph(docs)
    assert set(tropo.blast_radius(edges, "a")) == {"b"}  # cycle terminates, excludes a


def test_graph_json_surface():
    out = _capture(tropo.cmd_graph, argparse.Namespace(json=True), res())
    assert out["counts"] == {"nodes": 4, "edges": 1, "broken": 0}
    assert {n["id"] for n in out["nodes"]} >= {"tropo", "jeff"}


def test_blast_json_surface():
    out = _capture(tropo.cmd_blast,
                   argparse.Namespace(paths=["tropo"], depth=None, json=True), res())
    assert out["target"] == "tropo"
    assert out["impacted"][0]["id"] == "2026-06-12-kickoff"


def test_blast_unknown_id_exits(tmp_path):
    _graph_tree(tmp_path, {"a.md": "# A\n"})
    try:
        tropo.cmd_blast(argparse.Namespace(paths=["nope"], depth=None, json=True),
                        res(str(tmp_path)))
        assert False, "expected SystemExit for unknown id"
    except SystemExit:
        pass


# --- view (self-contained HTML render) -------------------------------------

def _assert_self_contained(txt):
    assert txt.startswith("<!doctype html>")
    assert "<svg" in txt and "</svg>" in txt
    body = txt.replace('xmlns="http://www.w3.org/2000/svg"', "")
    for bad in ("src=", "http://", "https://", "<link", "<script src"):
        assert bad not in body, f"not self-contained: found {bad!r}"


def test_view_writes_self_contained_html(tmp_path):
    _graph_tree(tmp_path, {"a.md": "---\ndepends_on: b\n---\n# A\n", "b.md": "# B\n"})
    out = tmp_path / "g.html"
    tropo.cmd_view(argparse.Namespace(paths=["graph"], depth=None, out=str(out)),
                   res(str(tmp_path)))
    txt = out.read_text(encoding="utf-8")
    _assert_self_contained(txt)
    for nid in ("a", "b"):
        assert f'data-id="{nid}"' in txt


def test_view_out_rejects_symlink(tmp_path):
    _graph_tree(tmp_path, {"a.md": "# A\n"})
    victim = tmp_path.parent / f"victim-{uuid.uuid4().hex}.txt"
    victim.write_text("keep", encoding="utf-8")
    out = tmp_path / "g.html"
    out.symlink_to(victim)
    try:
        tropo.cmd_view(argparse.Namespace(paths=["graph"], depth=None, out=str(out)),
                       res(str(tmp_path)))
        assert False, "expected SystemExit for symlink output"
    except SystemExit as e:
        assert "must not be a symlink" in str(e)
    assert victim.read_text(encoding="utf-8") == "keep"


def test_view_out_rejects_outside_root(tmp_path):
    _graph_tree(tmp_path, {"a.md": "# A\n"})
    out = tmp_path.parent / f"outside-{uuid.uuid4().hex}.html"
    try:
        tropo.cmd_view(argparse.Namespace(paths=["graph"], depth=None, out=str(out)),
                       res(str(tmp_path)))
        assert False, "expected SystemExit for outside output"
    except SystemExit as e:
        assert "must stay inside tropo root" in str(e)
    assert not out.exists()


def test_view_out_replaces_hard_link_without_mutating_outside_file(tmp_path):
    _graph_tree(tmp_path, {"a.md": "# A\n"})
    outside = tmp_path.parent / f"outside-{uuid.uuid4().hex}.html"
    outside_text = "<!doctype html><title>outside</title>"
    outside.write_text(outside_text, encoding="utf-8")
    out = tmp_path / "g.html"
    try:
        os.link(outside, out)
    except (AttributeError, NotImplementedError, OSError):
        outside.unlink(missing_ok=True)
        return

    try:
        tropo.cmd_view(argparse.Namespace(paths=["graph"], depth=None, out=str(out)),
                       res(str(tmp_path)))
        assert outside.read_text(encoding="utf-8") == outside_text
        _assert_self_contained(out.read_text(encoding="utf-8"))
    finally:
        out.unlink(missing_ok=True)
        outside.unlink(missing_ok=True)


def test_view_blast_subgraph_only_radius(tmp_path):
    _graph_tree(tmp_path, {"a.md": "---\ndepends_on: b\n---\n# A\n",
                           "b.md": "---\ndepends_on: c\n---\n# B\n",
                           "c.md": "# C\n", "z.md": "# Z (unrelated)\n"})
    out = tmp_path / "b.html"
    tropo.cmd_view(argparse.Namespace(paths=["blast", "c"], depth=None, out=str(out)),
                   res(str(tmp_path)))
    txt = out.read_text(encoding="utf-8")
    _assert_self_contained(txt)
    assert all(f'data-id="{n}"' in txt for n in ("a", "b", "c"))
    assert 'data-id="z"' not in txt  # unrelated node not in the blast radius


def test_view_blast_unknown_id_exits(tmp_path):
    _graph_tree(tmp_path, {"a.md": "# A\n"})
    try:
        tropo.cmd_view(argparse.Namespace(paths=["blast", "nope"], depth=None, out=None),
                       res(str(tmp_path)))
        assert False, "expected SystemExit for unknown id"
    except SystemExit:
        pass


def test_render_empty_graph_ok():
    _assert_self_contained(tropo.render_graph_html("graph", {}, []))


def test_layout_ranks_put_target_at_center():
    pos = tropo._layout(["t", "a", "b"], {"t": 0, "a": 1, "b": 1}, 100, 100, 60)
    assert pos["t"] == (100, 100)               # rank-0 sole node sits at centre
    assert pos["a"] != (100, 100) and pos["b"] != (100, 100)


# --- plan + semantic graph-diff --------------------------------------------

def _capture_rc(fn, *a, **k):
    import contextlib
    import io
    import json
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = fn(*a, **k)
    return rc, json.loads(buf.getvalue())


def _chain(tmp_path):
    return tropo.build_graph(_graph_tree(tmp_path, {
        "a.md": "---\ndepends_on: b\n---\n# A\n", "b.md": "# B\n"}))


def test_apply_change_remove_breaks_inbound_edge(tmp_path):
    nodes, edges = _chain(tmp_path)
    n2, e2 = tropo.apply_change(nodes, edges, {"remove": ["b"]})
    assert "b" not in n2
    assert [e for e in e2 if e["from"] == "a"][0]["broken"] is True


def test_apply_change_break_and_add(tmp_path):
    nodes, edges = _chain(tmp_path)
    _, e2 = tropo.apply_change(nodes, edges, {
        "break": [{"from": "a", "to": "b"}],
        "add": [{"from": "b", "field": "depends_on", "to": "a"}]})
    pairs = {(e["from"], e["to"]) for e in e2}
    assert ("a", "b") not in pairs and ("b", "a") in pairs


def test_graph_diff_reports_retype_and_newly_broken(tmp_path):
    nodes, edges = _chain(tmp_path)
    n2, e2 = tropo.apply_change(nodes, edges, {"remove": ["b"], "retype": {"a": "decision"}})
    d = tropo.graph_diff(nodes, edges, n2, e2)
    assert d["nodes_removed"] == ["b"]
    assert any(r["id"] == "a" and r["to"] == "decision" for r in d["nodes_retyped"])
    assert any(e["from"] == "a" and e["to"] == "b" for e in d["edges_newly_broken"])


def test_cmd_plan_breaking_change_exits_1(tmp_path):
    _chain(tmp_path)
    (tmp_path / "plan.toml").write_text('remove = ["b"]\n')
    rc, out = _capture_rc(tropo.cmd_plan,
                          argparse.Namespace(paths=[str(tmp_path / "plan.toml")], json=True),
                          res(str(tmp_path)))
    assert rc == 1 and out["problems"] == 1
    assert out["delta"]["nodes_removed"] == ["b"]
    assert out["affected"]["a"] == ["b"]  # a depends on the removed b


def test_cmd_plan_noop_exits_0(tmp_path):
    _graph_tree(tmp_path, {"a.md": "# A\n"})
    (tmp_path / "plan.toml").write_text("# no changes\n")
    rc, out = _capture_rc(tropo.cmd_plan,
                          argparse.Namespace(paths=[str(tmp_path / "plan.toml")], json=True),
                          res(str(tmp_path)))
    assert rc == 0 and out["problems"] == 0


def test_cmd_plan_missing_file_exits(tmp_path):
    _graph_tree(tmp_path, {"a.md": "# A\n"})
    try:
        tropo.cmd_plan(argparse.Namespace(paths=[str(tmp_path / "nope.toml")], json=True),
                       res(str(tmp_path)))
        assert False, "expected SystemExit for missing change-spec"
    except SystemExit:
        pass


# --- storage layer ------------------------------------------------------------

def _minimal_vault(tmp_path):
    """Scaffold a tiny tropo.toml + two .md files in tmp_path."""
    (tmp_path / "tropo.toml").write_text(
        "[base]\nderive = ['id', 'title']\nallow_untyped = true\n",
        encoding="utf-8",
    )
    (tmp_path / "notes").mkdir()
    (tmp_path / "notes" / "alpha.md").write_text("# Alpha\nSome content about auth.\n", encoding="utf-8")
    (tmp_path / "notes" / "beta.md").write_text("# Beta\nUnrelated content.\n", encoding="utf-8")


def _search_vault(tmp_path):
    """Typed graph fixture for query/find behavior."""
    (tmp_path / "tropo.toml").write_text(
        "[base]\nderive = ['id', 'title']\nallow_untyped = true\n"
        "[types.decision]\nfolder = 'decisions'\noptional = { status = 'string', affects = 'ref' }\n"
        "[types.module]\nfolder = 'modules'\noptional = { owner = 'string' }\n",
        encoding="utf-8",
    )
    (tmp_path / "decisions").mkdir()
    (tmp_path / "modules").mkdir()
    (tmp_path / "decisions" / "release-workflow.md").write_text(
        "---\n"
        "status: accepted\n"
        "affects: agent-workspace\n"
        "---\n"
        "# Release Workflow\n\n"
        "Owns release truth and changelog site sync verification.\n",
        encoding="utf-8",
    )
    (tmp_path / "modules" / "agent-workspace.md").write_text(
        "---\nowner: connie\n---\n"
        "# Agent Workspace\n\n"
        "The always-on contract should stay tiny and route to indexes.\n",
        encoding="utf-8",
    )
    (tmp_path / "modules" / "retrieval.md").write_text(
        "---\nowner: connie\n---\n"
        "# Retrieval\n\n"
        "Context compression helps agents open fewer files.\n",
        encoding="utf-8",
    )


def _init_git_repo(path):
    def git(*args):
        subprocess.run(
            ["git", "-C", str(path), *args],
            check=True,
            capture_output=True,
            text=True,
        )

    git("init", "-q")
    git("add", ".")
    git(
        "-c", "user.name=Vivary Tests",
        "-c", "user.email=tests@vivary.invalid",
        "commit", "-qm", "fixture",
    )


def _query_args(query, **overrides):
    data = {
        "paths": query.split(),
        "json": True,
        "k": None,
        "type": [],
        "path": [],
        "edge": [],
        "snippet": None,
        "explain": False,
        "mode": None,
        "root": None,
        "config": None,
        "strict": False,
        "lenient": False,
        "quiet": False,
        "dry_run": False,
        "yes": False,
        "from_backend": None,
        "to_backend": None,
        "budget": None,
    }
    data.update(overrides)
    return argparse.Namespace(**data)


def _migrate_args(**overrides):
    data = {
        "from_backend": "file",
        "to_backend": "embedded",
        "dry_run": False,
        "json": True,
        "yes": False,
        "paths": [],
        "strict": False,
        "lenient": False,
        "quiet": False,
        "config": None,
    }
    data.update(overrides)
    return argparse.Namespace(**data)


class _RecordingBackend:
    def __init__(self):
        self.records = {}
        self.upsert_calls = 0
        self.replace_calls = 0
        self.vector_query_calls = 0
        self.vector_query_limits = []
        self.closed = False

    def upsert(self, nodes):
        self.upsert_calls += 1
        for node in nodes:
            self.records[node["id"]] = dict(node)

    def replace_all(self, nodes):
        self.replace_calls += 1
        self.records = {node["id"]: dict(node) for node in nodes}

    def all_nodes(self):
        return [dict(row) for row in self.records.values()]

    def count_nodes(self):
        return len(self.records)

    def node_metadata(self, limit=None):
        rows = [
            {
                key: value
                for key, value in row.items()
                if key in tropo._VECTOR_METADATA_COLUMNS
            }
            for row in self.records.values()
        ]
        if limit is None:
            return rows
        return rows[:limit]

    def vector_query(self, query_vector, k=10):
        self.vector_query_calls += 1
        self.vector_query_limits.append(k)
        rows = self.all_nodes()
        rows.sort(
            key=lambda row: -tropo._cosine_score(
                query_vector,
                tropo._coerce_vector(row.get("vector")) or [],
            )
        )
        return rows[:max(0, k)]

    def close(self):
        self.closed = True


def test_file_backend_query_returns_matches(tmp_path):
    _minimal_vault(tmp_path)
    backend = tropo._FileBackend(str(tmp_path))
    results = backend.query("auth")
    assert len(results) >= 1
    assert any("alpha" in r["path"] for r in results)


def test_file_backend_query_no_match(tmp_path):
    _minimal_vault(tmp_path)
    backend = tropo._FileBackend(str(tmp_path))
    results = backend.query("zzznomatch123")
    assert results == []


def test_file_backend_upsert_is_noop(tmp_path):
    _minimal_vault(tmp_path)
    backend = tropo._FileBackend(str(tmp_path))
    backend.upsert([{"id": "x", "type": "note", "path": "x.md", "title": "X", "content": ""}])
    # No error; FS unchanged
    assert not (tmp_path / "x.md").exists()


def test_lance_backend_raises_clear_error_when_not_installed(tmp_path):
    import importlib.util
    if importlib.util.find_spec("lancedb") is not None:
        return  # lancedb is installed — skip this test
    try:
        tropo._LanceBackend(str(tmp_path / "db"))
        assert False, "expected ConfigError"
    except tropo.ConfigError as e:
        assert "pip install vivary-tropo[embedded]" in str(e)


def test_lance_backend_overwrites_when_schema_expands_for_embeddings():
    class SchemaMismatchTable:
        def __init__(self):
            self.added = None
            self.mode = None

        def merge_insert(self, key):
            assert key == "id"
            return self

        def when_matched_update_all(self):
            return self

        def when_not_matched_insert_all(self):
            return self

        def execute(self, nodes):
            raise ValueError("Field 'vector' not found in target schema")

        def add(self, nodes, mode=None):
            self.added = nodes
            self.mode = mode

    backend = object.__new__(tropo._LanceBackend)
    table = SchemaMismatchTable()
    backend._tbl = table

    backend.upsert([{"id": "a", "vector": [1.0]}])

    assert table.added == [{"id": "a", "vector": [1.0]}]
    assert table.mode == "overwrite"


def test_lance_backend_replace_all_recreates_table_for_full_snapshot():
    class FakeDb:
        def __init__(self):
            self.dropped = []
            self.created = []
            self.opened = False

        def open_table(self, name):
            assert name == "nodes"
            self.opened = True
            return object()

        def drop_table(self, name):
            self.dropped.append(name)

        def create_table(self, name, data):
            self.created.append((name, data))
            return {"name": name, "data": data}

    backend = object.__new__(tropo._LanceBackend)
    backend._db = FakeDb()
    backend._tbl = None

    backend.replace_all([{"id": "a", "vector": [1.0]}])

    assert backend._db.dropped == ["nodes"]
    assert backend._db.created == [("nodes", [{"id": "a", "vector": [1.0]}])]
    assert backend._tbl == {"name": "nodes", "data": [{"id": "a", "vector": [1.0]}]}


def test_get_backend_defaults_to_file(tmp_path):
    _minimal_vault(tmp_path)
    backend = tropo.get_backend(str(tmp_path))
    assert isinstance(backend, tropo._FileBackend)


def test_get_backend_auto_without_lancedb_falls_back(tmp_path):
    import importlib.util
    if importlib.util.find_spec("lancedb") is not None:
        return  # lancedb installed; auto would succeed — skip
    _minimal_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage]\nbackend = \"auto\"\n", encoding="utf-8"
    )
    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):
        backend = tropo.get_backend(str(tmp_path))
    assert isinstance(backend, tropo._FileBackend)
    assert "lancedb not installed" in buf.getvalue()


def test_cmd_migrate_dry_run(tmp_path):
    _minimal_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage]\nbackend = \"file\"\n", encoding="utf-8"
    )
    rc, out = _capture_rc(
        tropo.cmd_migrate,
        argparse.Namespace(from_backend="file", to_backend="embedded",
                           dry_run=True, json=True, yes=False,
                           paths=[], strict=False, lenient=False,
                           quiet=False, config=None),
        res(str(tmp_path)),
    )
    assert rc == 0
    assert out["dry_run"] is True
    assert out["migrated"] >= 1
    assert out["from"] == "file"
    assert out["to"] == "embedded"


def test_cmd_migrate_refuses_vector_only_storage_config(tmp_path):
    _minimal_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage.embedding]\n"
        "enabled = true\n"
        "provider = \"local-hash\"\n",
        encoding="utf-8",
    )
    rc, out = _capture_rc(
        tropo.cmd_migrate,
        argparse.Namespace(from_backend="file", to_backend="embedded",
                           dry_run=False, json=True, yes=False,
                           paths=[], strict=False, lenient=False,
                           quiet=False, config=None),
        res(str(tmp_path)),
    )
    assert rc == 1
    assert out["migrated"] == 0
    assert out["failed"] == 0
    assert "configured storage backend" in out["error"]


def test_cmd_migrate_dry_run_ignores_malformed_embedding_config(tmp_path):
    _minimal_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage]\n"
        "backend = \"file\"\n"
        "[storage.embedding]\n"
        "enabled = \"yes\"\n",
        encoding="utf-8",
    )
    rc, out = _capture_rc(
        tropo.cmd_migrate,
        argparse.Namespace(from_backend="file", to_backend="embedded",
                           dry_run=True, json=True, yes=False,
                           paths=[], strict=False, lenient=False,
                           quiet=False, config=None),
        res(str(tmp_path)),
    )
    assert rc == 0
    assert out["dry_run"] is True
    assert out["migrated"] >= 1


def test_cmd_migrate_same_backend_reports_json_error(tmp_path):
    _minimal_vault(tmp_path)

    rc, out = _capture_rc(
        tropo.cmd_migrate,
        _migrate_args(from_backend="file", to_backend="file"),
        res(str(tmp_path)),
    )

    assert rc == 1
    assert out["migrated"] == 0
    assert out["failed"] == 0
    assert "--from and --to must be different backends" in out["error"]
    assert out["embedding"]["status"] == "disabled"


def test_storage_config_accepts_leading_utf8_bom(tmp_path):
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage.embedding]\n"
        "enabled = true\n"
        "provider = \"local-hash\"\n",
        encoding="utf-8-sig",
    )

    config = tropo._load_vector_query_config(str(tmp_path))

    assert config["status"] == "ok"
    assert config["provider"] == "local-hash"


def test_cmd_migrate_non_table_storage_config_reports_json_error(tmp_path):
    _minimal_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        'storage = "embedded"\n',
        encoding="utf-8",
    )

    rc, out = _capture_rc(
        tropo.cmd_migrate,
        _migrate_args(),
        res(str(tmp_path)),
    )

    assert rc == 1
    assert out["migrated"] == 0
    assert out["failed"] == 0
    assert "storage must be a TOML table" in out["error"]


def test_cmd_migrate_non_table_embedded_config_reports_json_error(tmp_path):
    _minimal_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage]\n"
        "backend = \"embedded\"\n"
        "embedded = \"bad\"\n",
        encoding="utf-8",
    )

    rc, out = _capture_rc(
        tropo.cmd_migrate,
        _migrate_args(),
        res(str(tmp_path)),
    )

    assert rc == 1
    assert out["migrated"] == 0
    assert "storage.embedded must be a TOML table" in out["error"]


def test_cmd_migrate_rejects_out_of_root_embedded_storage_path(tmp_path):
    _minimal_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage]\n"
        "backend = \"embedded\"\n"
        "[storage.embedded]\n"
        "path = \"../outside-db\"\n",
        encoding="utf-8",
    )

    rc, out = _capture_rc(
        tropo.cmd_migrate,
        _migrate_args(),
        res(str(tmp_path)),
    )

    assert rc == 1
    assert out["migrated"] == 0
    assert "storage.embedded.path must stay inside the workspace" in out["error"]
    assert not (tmp_path.parent / "outside-db").exists()


def test_cmd_migrate_missing_storage_config_reports_json_error(tmp_path):
    _minimal_vault(tmp_path)

    rc, out = _capture_rc(
        tropo.cmd_migrate,
        _migrate_args(),
        res(str(tmp_path)),
    )

    assert rc == 1
    assert out["migrated"] == 0
    assert out["failed"] == 0
    assert "no .vivary/storage.toml found" in out["error"]
    assert out["embedding"]["status"] == "disabled"


def test_cmd_migrate_embedded_without_embedding_config_persists_plain_nodes(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage]\n"
        "backend = \"embedded\"\n",
        encoding="utf-8",
    )
    backend = _RecordingBackend()

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(
            tropo.cmd_migrate,
            _migrate_args(),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["migrated"] == 3
    assert out["embedding"]["status"] == "disabled"
    assert backend.closed is True
    assert backend.replace_calls == 1
    assert "release-workflow" in backend.records
    assert "vector" not in backend.records["release-workflow"]
    assert "embedding_provider" not in backend.records["release-workflow"]


def test_cmd_migrate_embedded_with_local_hash_stores_typed_node_embeddings(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage]\n"
        "backend = \"embedded\"\n"
        "[storage.embedding]\n"
        "enabled = true\n"
        "provider = \"local-hash\"\n"
        "dimensions = 64\n",
        encoding="utf-8",
    )
    backend = _RecordingBackend()

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(
            tropo.cmd_migrate,
            _migrate_args(),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["embedding"] == {
        "status": "ok",
        "provider": "local-hash",
        "dimensions": 64,
        "embedded": 3,
    }
    row = backend.records["release-workflow"]
    assert row["id"] == "release-workflow"
    assert row["type"] == "decision"
    assert row["path"] == "decisions/release-workflow.md"
    assert len(row["vector"]) == 64
    assert any(row["vector"])
    assert row["embedding_provider"] == "local-hash"
    assert row["embedding_dimensions"] == 64
    assert row["embedding_version"] == "local-hash-v2"
    assert row["embedding_scope"] == "typed-node"
    assert row["source_fingerprint"].startswith("sha256:")
    assert row["embedding_text_fingerprint"].startswith("sha256:")


def test_cmd_migrate_embedding_repeated_runs_update_by_node_id(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage]\n"
        "backend = \"embedded\"\n"
        "[storage.embedding]\n"
        "enabled = true\n"
        "provider = \"local-hash\"\n",
        encoding="utf-8",
    )
    backend = _RecordingBackend()

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc1, out1 = _capture_rc(tropo.cmd_migrate, _migrate_args(), res(str(tmp_path)))
        first_fingerprint = backend.records["release-workflow"]["source_fingerprint"]
        (tmp_path / "decisions" / "release-workflow.md").write_text(
            "---\n"
            "status: accepted\n"
            "affects: agent-workspace\n"
            "---\n"
            "# Release Workflow\n\n"
            "Owns release truth, changelog verification, and a new benchmark proof.\n",
            encoding="utf-8",
        )
        rc2, out2 = _capture_rc(tropo.cmd_migrate, _migrate_args(), res(str(tmp_path)))

    assert rc1 == 0
    assert rc2 == 0
    assert out1["migrated"] == 3
    assert out2["migrated"] == 3
    assert backend.replace_calls == 2
    assert sorted(backend.records) == ["agent-workspace", "release-workflow", "retrieval"]
    assert backend.records["release-workflow"]["source_fingerprint"] != first_fingerprint


def test_cmd_migrate_embedding_removes_deleted_or_newly_excluded_rows(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage]\n"
        "backend = \"embedded\"\n"
        "[storage.embedding]\n"
        "enabled = true\n"
        "provider = \"local-hash\"\n",
        encoding="utf-8",
    )
    backend = _RecordingBackend()

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc1, out1 = _capture_rc(tropo.cmd_migrate, _migrate_args(), res(str(tmp_path)))
        (tmp_path / "modules" / "retrieval.md").unlink()
        rc2, out2 = _capture_rc(tropo.cmd_migrate, _migrate_args(), res(str(tmp_path)))

    assert rc1 == 0
    assert rc2 == 0
    assert out1["migrated"] == 3
    assert out2["migrated"] == 2
    assert sorted(backend.records) == ["agent-workspace", "release-workflow"]
    assert "retrieval" not in backend.records


def test_cmd_migrate_embedding_bad_config_fails_before_backend_write(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage]\n"
        "backend = \"embedded\"\n"
        "[storage.embedding]\n"
        "enabled = true\n"
        "provider = \"remote-mystery\"\n",
        encoding="utf-8",
    )
    backend = _RecordingBackend()

    with mock.patch.object(tropo, "get_backend", return_value=backend) as get_backend:
        rc, out = _capture_rc(
            tropo.cmd_migrate,
            _migrate_args(),
            res(str(tmp_path)),
        )

    assert rc == 1
    assert out["migrated"] == 0
    assert out["failed"] == 0
    assert out["embedding"]["status"] == "misconfigured"
    assert "remote-mystery" in out["error"]
    assert get_backend.call_count == 0
    assert backend.records == {}


def test_cmd_migrate_missing_embedded_dependency_reports_json_error(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage]\n"
        "backend = \"embedded\"\n",
        encoding="utf-8",
    )

    with mock.patch.object(
        tropo,
        "get_backend",
        side_effect=tropo.ConfigError("LanceDB is not installed. Run: pip install vivary-tropo[embedded]"),
    ):
        rc, out = _capture_rc(
            tropo.cmd_migrate,
            _migrate_args(),
            res(str(tmp_path)),
        )

    assert rc == 1
    assert out["migrated"] == 0
    assert out["failed"] == 3
    assert "pip install vivary-tropo[embedded]" in out["error"]
    assert out["embedding"]["status"] == "disabled"


def test_cmd_migrate_embedding_respects_root_privacy_excludes(tmp_path):
    (tmp_path / "tropo.toml").write_text(
        "exclude = ['private']\n"
        "[base]\n"
        "derive = ['id', 'title']\n"
        "allow_untyped = true\n",
        encoding="utf-8",
    )
    (tmp_path / "public.md").write_text("# Public\nRelease truth note.\n", encoding="utf-8")
    (tmp_path / "private").mkdir()
    (tmp_path / "private" / "secret.md").write_text(
        "# Secret\nDo not embed this private note.\n",
        encoding="utf-8",
    )
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage]\n"
        "backend = \"embedded\"\n"
        "[storage.embedding]\n"
        "enabled = true\n"
        "provider = \"local-hash\"\n",
        encoding="utf-8",
    )
    backend = _RecordingBackend()

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(tropo.cmd_migrate, _migrate_args(), res(str(tmp_path)))

    assert rc == 0
    assert out["embedding"]["embedded"] == 1
    assert sorted(backend.records) == ["public"]
    assert all("Secret" not in row.get("content", "") for row in backend.records.values())


def test_cmd_migrate_embedding_respects_nested_privacy_excludes(tmp_path):
    (tmp_path / "tropo.toml").write_text(
        "[base]\n"
        "derive = ['id', 'title']\n"
        "allow_untyped = true\n",
        encoding="utf-8",
    )
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "tropo.toml").write_text(
        "exclude = ['private/secret.md']\n"
        "[base]\n"
        "strict = true\n",
        encoding="utf-8",
    )
    (tmp_path / "docs" / "public.md").write_text("# Public\nVisible docs note.\n", encoding="utf-8")
    (tmp_path / "docs" / "private").mkdir()
    (tmp_path / "docs" / "private" / "secret.md").write_text(
        "# Secret\nNested private note must not be embedded.\n",
        encoding="utf-8",
    )
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage]\n"
        "backend = \"embedded\"\n"
        "[storage.embedding]\n"
        "enabled = true\n"
        "provider = \"local-hash\"\n",
        encoding="utf-8",
    )
    backend = _RecordingBackend()

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(tropo.cmd_migrate, _migrate_args(), res(str(tmp_path)))

    assert rc == 0
    assert out["embedding"]["embedded"] == 1
    assert sorted(backend.records) == ["public"]
    assert all("Nested private" not in row.get("content", "") for row in backend.records.values())


def test_cmd_migrate_embedding_respects_nested_dot_privacy_excludes(tmp_path):
    (tmp_path / "tropo.toml").write_text(
        "[base]\n"
        "derive = ['id', 'title']\n"
        "allow_untyped = true\n",
        encoding="utf-8",
    )
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "tropo.toml").write_text(
        "exclude = ['.private/secret.md']\n"
        "[base]\n"
        "strict = true\n",
        encoding="utf-8",
    )
    (tmp_path / "docs" / "public.md").write_text("# Public\nVisible docs note.\n", encoding="utf-8")
    (tmp_path / "docs" / ".private").mkdir()
    (tmp_path / "docs" / ".private" / "secret.md").write_text(
        "# Secret\nDotted private note must not be embedded.\n",
        encoding="utf-8",
    )
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage]\n"
        "backend = \"embedded\"\n"
        "[storage.embedding]\n"
        "enabled = true\n"
        "provider = \"local-hash\"\n",
        encoding="utf-8",
    )
    backend = _RecordingBackend()

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(tropo.cmd_migrate, _migrate_args(), res(str(tmp_path)))

    assert rc == 0
    assert out["embedding"]["embedded"] == 1
    assert sorted(backend.records) == ["public"]
    assert all("Dotted private" not in row.get("content", "") for row in backend.records.values())


def test_cmd_query_returns_graph_aware_typed_matches(tmp_path):
    _search_vault(tmp_path)
    rc, out = _capture_rc(
        tropo.cmd_query,
        _query_args("release truth"),
        res(str(tmp_path)),
    )
    assert rc == 0
    assert "results" in out
    assert out["query"] == "release truth"
    assert len(out["results"]) >= 1
    assert out["results"][0]["id"] == "release-workflow"
    assert out["results"][0]["type"] == "decision"
    assert "release truth" in out["results"][0]["snippet"].lower()


def test_cmd_query_filters_by_type_path_and_edge(tmp_path):
    _search_vault(tmp_path)
    rc, out = _capture_rc(
        tropo.cmd_query,
        _query_args(
            "release",
            type=["decision"],
            path=["decisions/*"],
            edge=["affects:agent-workspace"],
        ),
        res(str(tmp_path)),
    )
    assert rc == 0
    assert [r["id"] for r in out["results"]] == ["release-workflow"]


def test_cmd_query_snippet_zero_and_explain(tmp_path):
    _search_vault(tmp_path)
    rc, out = _capture_rc(
        tropo.cmd_query,
        _query_args("accepted", snippet=0, explain=True),
        res(str(tmp_path)),
    )
    assert rc == 0
    assert out["results"][0]["id"] == "release-workflow"
    assert "snippet" not in out["results"][0]
    assert any("frontmatter" in reason for reason in out["results"][0]["reasons"])


def test_cmd_find_returns_context_packet(tmp_path):
    _search_vault(tmp_path)
    rc, out = _capture_rc(
        tropo.cmd_find,
        _query_args("where is release truth owned", k=5, budget=1200),
        res(str(tmp_path)),
    )
    assert rc == 0
    assert out["query"] == "where is release truth owned"
    assert out["budget"] == 1200
    assert out["estimated_tokens"] > 0
    assert out["results"][0]["id"] == "release-workflow"
    assert out["results"][0]["reason"]


def test_cmd_find_budget_trims_context(tmp_path):
    _search_vault(tmp_path)
    rc, out = _capture_rc(
        tropo.cmd_find,
        _query_args("release truth context compression", k=10, budget=30),
        res(str(tmp_path)),
    )
    assert rc == 0
    assert out["estimated_tokens"] <= 30
    assert len(out["results"]) >= 1


def test_cmd_find_governed_returns_bounded_core_capsule(tmp_path):
    terms = tropo._governed_query_terms(
        "repeat repeat " + " ".join(f"term{index}" for index in range(20))
    )
    assert terms == ["repeat", *(f"term{index}" for index in range(15))]
    assert tropo._governed_query_terms("Réparer l’authentification 身份验证") == [
        "réparer",
        "authentification",
        "身份验证",
    ]
    assert tropo._governed_query_terms("what's authentication") == [
        "authentication"
    ]
    assert tropo._governed_query_terms("what's this") == []

    _search_vault(tmp_path)
    (tmp_path / "package.json").write_text(
        '{"scripts":{"test":"node --test"}}\n',
        encoding="utf-8",
    )
    _init_git_repo(tmp_path)

    rc, out = _capture_rc(
        tropo.cmd_find,
        _query_args(
            "release workflow",
            governed=True,
            max_claims=2,
        ),
        res(str(tmp_path)),
    )

    assert rc == 0
    assert out["schema"] == "vivary.task-capsule/v0"
    assert out["task"] == {
        "question": "release workflow",
        "scope": [normalize_path(str(tmp_path))],
    }
    assert 0 < len(out["claims"]) <= 2
    assert all(
        claim["subject_path"] == normalize_path(str(tmp_path))
        for claim in out["claims"]
    )
    assert any(claim["fact"] == "content_match" for claim in out["claims"])
    assert [
        (check["name"].split("@", 1)[0], check["command"])
        for check in out["required_checks"]
    ] == [
        ("vivary-graph-check", "tropo check --root . --json"),
        ("project-tests", "npm test"),
    ]
    assert all("@" in check["name"] for check in out["required_checks"])
    assert {
        check["command"]: check["evidence"] for check in out["required_checks"]
    } == {
        "tropo check --root . --json": {
            "command": "fs.stat workspace markers"
        },
        "npm test": {"command": "fs.read package.json scripts.test"},
    }
    assert all(
        check["cwd"] == normalize_path(str(tmp_path))
        for check in out["required_checks"]
    )
    assert out["budget"] == {"max_claims": 2}
    assert out["fingerprint"].startswith("sha256:")


def test_governed_find_drops_contraction_fragments_before_file_cap(tmp_path):
    _search_vault(tmp_path)
    for index in range(8):
        (tmp_path / f"{index:02}-status.md").write_text(
            "status noise\n",
            encoding="utf-8",
        )
    (tmp_path / "z-authentication.md").write_text(
        "authentication is the meaningful match\n",
        encoding="utf-8",
    )
    _init_git_repo(tmp_path)

    rc, out = _capture_rc(
        tropo.cmd_find,
        _query_args("what's authentication", governed=True, max_claims=24),
        res(str(tmp_path)),
    )

    assert rc == 0
    assert any(
        claim["fact"] == "content_match"
        and "z-authentication.md" in claim["claim"]
        for claim in out["claims"]
    )
    assert not any(
        "status noise" in claim["claim"] for claim in out["claims"]
    )


def test_governed_find_supports_non_latin_content_and_records_unrankable_facts(
    tmp_path,
):
    workspace = tmp_path / "项目"
    workspace.mkdir()
    _search_vault(workspace)
    content_path = workspace / "身份验证.md"
    content_path.write_text("# 身份验证\n\n受管上下文。\n", encoding="utf-8")
    _init_git_repo(workspace)
    subprocess.run(
        ["git", "-C", str(workspace), "config", "core.quotepath", "false"],
        check=True,
        capture_output=True,
        text=True,
    )
    content_path.write_text("# 身份验证\n\n已修改的受管上下文。\n", encoding="utf-8")

    rc, out = _capture_rc(
        tropo.cmd_find,
        _query_args("身份验证", governed=True, max_claims=24),
        res(str(workspace)),
    )

    assert rc == 0
    assert any(
        claim["fact"] == "content_match" and "身份验证.md" in claim["claim"]
        for claim in out["claims"]
    )
    assert any(
        omission.get("kind") == "collation_domain_excluded"
        and omission.get("fact") == "dirty_entries"
        for omission in out["omissions"]
    )


def test_governed_find_excludes_tracked_paths_added_to_ignore_policy(tmp_path):
    _search_vault(tmp_path)
    private_path = tmp_path / "USER.md"
    private_path.write_text("PRIVATE_TRACKED_MARKER original\n", encoding="utf-8")
    _init_git_repo(tmp_path)
    (tmp_path / ".gitignore").write_text("USER.md\n", encoding="utf-8")
    subprocess.run(
        ["git", "-C", str(tmp_path), "add", ".gitignore"],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(tmp_path),
            "-c",
            "user.name=Vivary Tests",
            "-c",
            "user.email=tests@vivary.invalid",
            "commit",
            "-qm",
            "privacy policy",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    private_path.write_text("PRIVATE_TRACKED_MARKER modified\n", encoding="utf-8")

    rc, out = _capture_rc(
        tropo.cmd_find,
        _query_args("private", governed=True, max_claims=24),
        res(str(tmp_path)),
    )

    assert rc == 0
    serialized = json.dumps(out)
    assert "USER.md" not in serialized
    assert "PRIVATE_TRACKED_MARKER" not in serialized
    assert "ignored_dirty_entries_excluded" in serialized
    assert "privacy_matches_excluded" in serialized


def test_governed_find_excludes_an_ignored_tracked_manifest_and_npm_check(tmp_path):
    _search_vault(tmp_path)
    manifest = tmp_path / "package.json"
    manifest.write_text(
        '{"scripts":{"test":"PRIVATE_MANIFEST_TEST_COMMAND"}}\n',
        encoding="utf-8",
    )
    _init_git_repo(tmp_path)
    (tmp_path / ".gitignore").write_text("package.json\n", encoding="utf-8")
    subprocess.run(
        ["git", "-C", str(tmp_path), "add", ".gitignore"],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(tmp_path),
            "-c",
            "user.name=Vivary Tests",
            "-c",
            "user.email=tests@vivary.invalid",
            "commit",
            "-qm",
            "manifest privacy policy",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    capsule = tropo.governed_find(str(tmp_path), "release workflow", max_claims=24)

    assert "npm test" not in [check["command"] for check in capsule["required_checks"]]
    assert "tropo check --root . --json" in [
        check["command"] for check in capsule["required_checks"]
    ]
    serialized = json.dumps(capsule)
    assert "package.json" not in serialized
    assert "PRIVATE_MANIFEST_TEST_COMMAND" not in serialized


def test_governed_find_keeps_content_when_checkout_state_is_stable(tmp_path):
    _search_vault(tmp_path)
    (tmp_path / "state.md").write_text(
        "STABLE_GOVERNED_CONTENT_MARKER\n",
        encoding="utf-8",
    )
    _init_git_repo(tmp_path)

    capsule = tropo.governed_find(
        str(tmp_path),
        "STABLE_GOVERNED_CONTENT_MARKER",
        max_claims=24,
    )

    assert any(
        claim["fact"] == "content_match"
        and "STABLE_GOVERNED_CONTENT_MARKER" in claim["claim"]
        for claim in capsule["claims"]
    )
    assert any(
        claim["fact"] == "is_dirty" and claim["claim"] == "worktree is clean"
        for claim in capsule["claims"]
    )
    assert not any(
        unknown.get("kind") == "content_search_incomplete"
        for unknown in capsule["unknowns"]
    )


def test_governed_find_labels_unknown_dirty_state_without_claiming_a_race():
    with tempfile.TemporaryDirectory(prefix="tropo-non-git-") as workspace_dir:
        workspace = Path(workspace_dir)
        _search_vault(workspace)

        capsule = tropo.governed_find(
            str(workspace),
            "release workflow",
            max_claims=24,
        )

        assert not any(
            claim["fact"] == "content_match" for claim in capsule["claims"]
        )
        assert any(
            unknown.get("kind") == "content_search_incomplete"
            and unknown.get("reason") == "dirty_state_unknown"
            for unknown in capsule["unknowns"]
        )
        assert not any(
            unknown.get("reason")
            == "worktree_state_changed_during_content_observation"
            for unknown in capsule["unknowns"]
        )


def test_governed_find_retries_when_content_mutates_after_facts(tmp_path):
    _search_vault(tmp_path)
    state_path = tmp_path / "state.md"
    state_path.write_text("before mutation\n", encoding="utf-8")
    _init_git_repo(tmp_path)
    original_observe_content = vivary_core.observe_content
    content_calls = []

    def mutate_before_first_content(*args, **kwargs):
        if not content_calls:
            state_path.write_text(
                "RETRIED_GOVERNED_CONTENT_MARKER\n",
                encoding="utf-8",
            )
        content_calls.append(None)
        return original_observe_content(*args, **kwargs)

    with mock.patch.object(
        vivary_core,
        "observe_content",
        side_effect=mutate_before_first_content,
    ):
        capsule = tropo.governed_find(
            str(tmp_path),
            "RETRIED_GOVERNED_CONTENT_MARKER",
            max_claims=24,
        )

    assert len(content_calls) == 3
    assert any(
        claim["fact"] == "content_match"
        and "RETRIED_GOVERNED_CONTENT_MARKER" in claim["claim"]
        for claim in capsule["claims"]
    )
    assert any(
        claim["fact"] == "is_dirty"
        and claim["claim"] == "worktree has uncommitted changes"
        for claim in capsule["claims"]
    )
    assert not any(
        claim["fact"] == "is_dirty" and claim["claim"] == "worktree is clean"
        for claim in capsule["claims"]
    )


def test_governed_find_retries_when_already_dirty_content_changes(tmp_path):
    _search_vault(tmp_path)
    state_path = tmp_path / "state.md"
    state_path.write_text("committed content\n", encoding="utf-8")
    _init_git_repo(tmp_path)
    state_path.write_text(
        "DIRTY_CHURN_MARKER first read\n",
        encoding="utf-8",
    )
    original_observe_content = vivary_core.observe_content
    content_calls = []

    def mutate_after_first_content(*args, **kwargs):
        result = original_observe_content(*args, **kwargs)
        content_calls.append(None)
        if len(content_calls) == 1:
            state_path.write_text(
                "DIRTY_CHURN_MARKER stable read\n",
                encoding="utf-8",
            )
        return result

    with mock.patch.object(
        vivary_core,
        "observe_content",
        side_effect=mutate_after_first_content,
    ):
        capsule = tropo.governed_find(
            str(tmp_path),
            "DIRTY_CHURN_MARKER",
            max_claims=24,
        )

    assert len(content_calls) == 4
    content_claims = [
        claim["claim"]
        for claim in capsule["claims"]
        if claim["fact"] == "content_match"
    ]
    assert any("DIRTY_CHURN_MARKER stable read" in claim for claim in content_claims)
    assert all("DIRTY_CHURN_MARKER first read" not in claim for claim in content_claims)
    assert any(
        claim["fact"] == "is_dirty"
        and claim["claim"] == "worktree has uncommitted changes"
        for claim in capsule["claims"]
    )


def test_governed_find_marks_content_unavailable_after_two_changed_brackets(tmp_path):
    _search_vault(tmp_path)
    state_path = tmp_path / "state.md"
    state_path.write_text("before mutation\n", encoding="utf-8")
    _init_git_repo(tmp_path)
    original_observe_content = vivary_core.observe_content
    content_calls = []

    def mutate_before_each_content(*args, **kwargs):
        state_path.write_text(
            f"UNSTABLE_GOVERNED_CONTENT_MARKER {len(content_calls)}\n",
            encoding="utf-8",
        )
        if content_calls:
            (tmp_path / "second-observation-change.md").write_text(
                "changes the second status snapshot\n",
                encoding="utf-8",
            )
        content_calls.append(None)
        return original_observe_content(*args, **kwargs)

    with mock.patch.object(
        vivary_core,
        "observe_content",
        side_effect=mutate_before_each_content,
    ):
        capsule = tropo.governed_find(
            str(tmp_path),
            "UNSTABLE_GOVERNED_CONTENT_MARKER",
            max_claims=24,
        )

    assert len(content_calls) == 2
    assert not any(claim["fact"] == "content_match" for claim in capsule["claims"])
    assert any(
        unknown.get("kind") == "content_search_incomplete"
        and unknown.get("reason") == "worktree_state_changed_during_content_observation"
        for unknown in capsule["unknowns"]
    )


def test_governed_find_accepts_symlink_alias_of_worktree_root(tmp_path):
    workspace = tmp_path / "workspace"
    alias = tmp_path / "workspace-alias"
    workspace.mkdir()
    _search_vault(workspace)
    _init_git_repo(workspace)
    try:
        alias.symlink_to(workspace, target_is_directory=True)
    except OSError:
        return

    rc, out = _capture_rc(
        tropo.cmd_find,
        _query_args("release workflow", governed=True, max_claims=2),
        res(str(alias)),
    )

    assert rc == 0
    assert out["task"]["scope"] == [normalize_path(os.path.realpath(workspace))]


def test_governed_find_accepts_equivalent_windows_root_casing(tmp_path):
    if os.name != "nt":
        return
    workspace = tmp_path / "MixedCaseWorkspace"
    workspace.mkdir()
    _search_vault(workspace)
    _init_git_repo(workspace)

    rc, out = _capture_rc(
        tropo.cmd_find,
        _query_args("release workflow", governed=True, max_claims=2),
        res(str(workspace).swapcase()),
    )

    assert rc == 0
    assert out["schema"] == "vivary.task-capsule/v0"


def test_governed_find_rejects_a_tropo_root_nested_inside_a_git_worktree(
    tmp_path,
):
    repo = tmp_path / "repo"
    nested = repo / "vault"
    nested.mkdir(parents=True)
    _search_vault(nested)
    _init_git_repo(repo)
    stderr = io.StringIO()

    with contextlib.redirect_stderr(stderr):
        rc = tropo.cmd_find(
            _query_args("release workflow", governed=True, max_claims=2),
            res(str(nested)),
        )

    assert rc == 2
    assert "must be the Git worktree root" in stderr.getvalue()


def test_governed_find_flags_fail_closed_in_both_directions(tmp_path):
    incompatible = (
        ({"budget": 0}, "--budget"),
        ({"k": 0}, "--k"),
        ({"mode": "text"}, "--mode"),
        ({"snippet": 0}, "--snippet"),
        ({"type": ["decision"]}, "--type"),
        ({"path": ["decisions/*"]}, "--path"),
        ({"edge": ["affects"]}, "--edge"),
        ({"explain": True}, "--explain"),
    )
    for overrides, expected_flag in incompatible:
        args = _query_args(
            "release workflow",
            governed=True,
            max_claims=2,
            **overrides,
        )
        stderr = io.StringIO()
        with (
            mock.patch.object(tropo, "governed_find") as facade,
            contextlib.redirect_stderr(stderr),
        ):
            rc = tropo.cmd_find(
                args,
                types.SimpleNamespace(root=str(tmp_path)),
            )
        assert rc == 2
        assert stderr.getvalue() == (
            "tropo find --governed: unsupported option(s): "
            f"{expected_flag}\n"
        )
        facade.assert_not_called()

    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        rc = tropo.cmd_find(
            _query_args("release workflow", max_claims=2),
            types.SimpleNamespace(root=str(tmp_path)),
        )
    assert rc == 2
    assert stderr.getvalue() == (
        "tropo find: --max-claims requires --governed\n"
    )

    for argv in (
        ["query", "release", "--governed"],
        ["query", "release", "--max-claims", "2"],
    ):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            try:
                tropo._main(argv)
                assert False, "expected parser usage failure"
            except SystemExit as error:
                assert error.code == 2
        assert stderr.getvalue().endswith(
            "tropo: error: --governed and --max-claims "
            "are only valid with find\n"
        )


def test_cmd_find_governed_maps_invalid_core_input_to_usage_error(tmp_path):
    args = _query_args(
        "release workflow",
        governed=True,
        max_claims=-1,
    )
    stderr = io.StringIO()

    with (
        mock.patch.object(
            tropo,
            "governed_find",
            side_effect=ValueError(
                "budget.max_claims must be a non-negative integer (got -1)"
            ),
        ),
        contextlib.redirect_stderr(stderr),
    ):
        rc = tropo.cmd_find(args, types.SimpleNamespace(root=str(tmp_path)))

    assert rc == 2
    assert stderr.getvalue() == (
        "tropo find --governed: "
        "budget.max_claims must be a non-negative integer (got -1)\n"
    )


def test_cmd_find_governed_maps_missing_core_to_install_error(tmp_path):
    args = _query_args(
        "release workflow",
        governed=True,
        max_claims=2,
    )
    stderr = io.StringIO()

    with (
        mock.patch.object(
            tropo,
            "governed_find",
            side_effect=ImportError("cannot import vivary_core"),
        ),
        contextlib.redirect_stderr(stderr),
    ):
        rc = tropo.cmd_find(args, types.SimpleNamespace(root=str(tmp_path)))

    assert rc == 2
    assert stderr.getvalue() == (
        "tropo find --governed: vivary-core>=0.2.1 is required; "
        "install Tropo with its declared dependencies\n"
    )


def test_cmd_query_no_results(tmp_path):
    _search_vault(tmp_path)
    rc, out = _capture_rc(
        tropo.cmd_query,
        _query_args("zzznomatch123"),
        res(str(tmp_path)),
    )
    assert rc == 0
    assert out["results"] == []


def test_cmd_query_vector_mode_falls_back_without_embedding_config(tmp_path):
    _search_vault(tmp_path)
    rc, out = _capture_rc(
        tropo.cmd_query,
        _query_args("release truth", mode="vector"),
        res(str(tmp_path)),
    )
    assert rc == 0
    assert out["mode"] == "vector"
    assert out["vector"]["status"] == "fallback"
    assert out["vector"]["fallback"] == "text"
    assert out["results"][0]["id"] == "release-workflow"
    assert out["results"][0]["type"] == "decision"


def test_cmd_query_vector_mode_returns_typed_local_hash_matches(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage.embedding]\n"
        "enabled = true\n"
        "provider = \"local-hash\"\n"
        "dimensions = 64\n",
        encoding="utf-8",
    )
    rc, out = _capture_rc(
        tropo.cmd_query,
        _query_args("changelog verification", mode="vector", explain=True),
        res(str(tmp_path)),
    )
    assert rc == 0
    assert out["mode"] == "vector"
    assert out["vector"]["status"] == "ok"
    assert out["vector"]["provider"] == "local-hash"
    assert out["vector"]["dimensions"] == 64
    assert out["results"][0]["id"] == "release-workflow"
    assert out["results"][0]["type"] == "decision"
    assert out["results"][0]["provider"] == "local-hash"
    assert out["results"][0]["score"] > 0
    assert "typed vector match" in out["results"][0]["reason"]


def test_cmd_query_vector_mode_applies_graph_filters(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage.embedding]\n"
        "enabled = true\n"
        "provider = \"local-hash\"\n",
        encoding="utf-8",
    )
    rc, out = _capture_rc(
        tropo.cmd_query,
        _query_args(
            "release",
            mode="vector",
            type=["decision"],
            path=["decisions/*"],
            edge=["affects:agent-workspace"],
        ),
        res(str(tmp_path)),
    )
    assert rc == 0
    assert [r["id"] for r in out["results"]] == ["release-workflow"]
    assert out["results"][0]["edges"] == [
        {"from": "release-workflow", "field": "affects", "to": "agent-workspace"}
    ]


def _write_embedded_vector_config(tmp_path, dimensions=64):
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir(exist_ok=True)
    (vivary_dir / "storage.toml").write_text(
        "[storage]\n"
        "backend = \"embedded\"\n"
        "[storage.embedding]\n"
        "enabled = true\n"
        "provider = \"local-hash\"\n"
        f"dimensions = {dimensions}\n",
        encoding="utf-8",
    )


def _stored_vector_backend(tmp_path):
    config = tropo._load_vector_query_config(str(tmp_path))
    docs = tropo.analyze(str(tmp_path), [], res(str(tmp_path)))
    backend = _RecordingBackend()
    backend.replace_all(tropo._migrate_nodes_with_embeddings(docs, config))
    return backend


def test_cmd_query_vector_mode_uses_stored_embedded_vectors_for_wording_drift(tmp_path):
    _search_vault(tmp_path)
    _write_embedded_vector_config(tmp_path, dimensions=64)
    backend = _stored_vector_backend(tmp_path)

    rc_text, out_text = _capture_rc(
        tropo.cmd_query,
        _query_args("verify"),
        res(str(tmp_path)),
    )
    assert rc_text == 0
    assert out_text["results"] == []

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("verify", mode="vector", explain=True),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["vector"]["status"] == "ok"
    assert out["vector"]["source"] == "stored"
    assert out["vector"]["index"] == "embedded"
    assert out["vector"]["embedding_version"] == "local-hash-v2"
    assert out["results"][0]["id"] == "release-workflow"
    assert out["results"][0]["source"] == "stored"
    assert "stored typed vector match" in out["results"][0]["reason"]
    assert backend.vector_query_calls == 1
    assert backend.closed is True


def test_cmd_query_vector_mode_stored_vectors_keep_filters_and_windows_path_shapes(tmp_path):
    _search_vault(tmp_path)
    _write_embedded_vector_config(tmp_path, dimensions=64)
    backend = _stored_vector_backend(tmp_path)

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args(
                "release",
                mode="vector",
                k=1_000_000,
                type=["decision"],
                path=["decisions\\*"],
                edge=["affects:agent-workspace"],
            ),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["vector"]["source"] == "stored"
    assert [r["id"] for r in out["results"]] == ["release-workflow"]
    assert out["results"][0]["edges"] == [
        {"from": "release-workflow", "field": "affects", "to": "agent-workspace"}
    ]
    assert backend.vector_query_limits == [3]


def test_cmd_query_vector_mode_limits_stored_vector_candidates(tmp_path):
    (tmp_path / "tropo.toml").write_text(
        "[base]\n"
        "derive = ['id', 'title']\n"
        "allow_untyped = true\n",
        encoding="utf-8",
    )
    for index in range(300):
        (tmp_path / f"note-{index:03}.md").write_text(
            f"# Note {index:03}\nRelease verification note {index:03}.\n",
            encoding="utf-8",
        )
    _write_embedded_vector_config(tmp_path, dimensions=64)
    backend = _stored_vector_backend(tmp_path)

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release", mode="vector", k=1_000_000),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["vector"]["source"] == "stored"
    assert out["vector"]["candidate_limit"] == 250
    assert backend.vector_query_limits == [250]
    assert len(out["results"]) == 250


def test_cmd_query_vector_mode_empty_stored_index_falls_back_to_text(tmp_path):
    _search_vault(tmp_path)
    _write_embedded_vector_config(tmp_path, dimensions=64)
    backend = _RecordingBackend()

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="vector"),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["vector"]["status"] == "fallback"
    assert out["vector"]["fallback"] == "text"
    assert "empty" in out["vector"]["detail"]
    assert out["results"][0]["id"] == "release-workflow"


def test_cmd_query_vector_mode_missing_stored_vector_falls_back_to_text(tmp_path):
    _search_vault(tmp_path)
    _write_embedded_vector_config(tmp_path, dimensions=64)
    backend = _stored_vector_backend(tmp_path)
    backend.records["release-workflow"].pop("vector")

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="vector"),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["vector"]["status"] == "fallback"
    assert "missing" in out["vector"]["detail"]
    assert out["results"][0]["id"] == "release-workflow"


def test_cmd_query_vector_mode_bad_stored_dimensions_falls_back_to_text(tmp_path):
    _search_vault(tmp_path)
    _write_embedded_vector_config(tmp_path, dimensions=64)
    backend = _stored_vector_backend(tmp_path)
    backend.records["release-workflow"]["vector"] = [1.0]

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="vector"),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["vector"]["status"] == "fallback"
    assert "wrong dimensions" in out["vector"]["detail"]
    assert out["results"][0]["id"] == "release-workflow"


def test_cmd_query_vector_mode_non_finite_stored_vector_falls_back_to_text(tmp_path):
    _search_vault(tmp_path)
    _write_embedded_vector_config(tmp_path, dimensions=64)
    backend = _stored_vector_backend(tmp_path)
    backend.records["release-workflow"]["vector"] = [float("nan")] * 64

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="vector"),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["vector"]["status"] == "fallback"
    assert "non-finite" in out["vector"]["detail"]
    assert out["results"][0]["id"] == "release-workflow"


def test_cmd_query_vector_mode_stale_stored_fingerprint_falls_back_to_text(tmp_path):
    _search_vault(tmp_path)
    _write_embedded_vector_config(tmp_path, dimensions=64)
    backend = _stored_vector_backend(tmp_path)
    (tmp_path / "decisions" / "release-workflow.md").write_text(
        "---\n"
        "status: accepted\n"
        "affects: agent-workspace\n"
        "---\n"
        "# Release Workflow\n\n"
        "Owns release truth, changelog verification, and updated launch proof.\n",
        encoding="utf-8",
    )

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="vector"),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["vector"]["status"] == "fallback"
    assert "source_fingerprint" in out["vector"]["detail"]
    assert out["results"][0]["id"] == "release-workflow"


def test_cmd_query_vector_mode_deleted_stored_rows_fall_back_to_text(tmp_path):
    _search_vault(tmp_path)
    _write_embedded_vector_config(tmp_path, dimensions=64)
    backend = _stored_vector_backend(tmp_path)
    (tmp_path / "modules" / "retrieval.md").unlink()

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="vector"),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["vector"]["status"] == "fallback"
    assert "deleted node" in out["vector"]["detail"]
    assert out["results"][0]["id"] == "release-workflow"


def test_cmd_query_vector_mode_all_deleted_stored_rows_fall_back_to_text(tmp_path):
    _search_vault(tmp_path)
    _write_embedded_vector_config(tmp_path, dimensions=64)
    backend = _stored_vector_backend(tmp_path)
    shutil.rmtree(tmp_path / "decisions")
    shutil.rmtree(tmp_path / "modules")

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="vector"),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["vector"]["status"] == "fallback"
    assert "deleted node" in out["vector"]["detail"]
    assert out["results"] == []


def test_cmd_query_vector_mode_old_stored_version_falls_back_to_text(tmp_path):
    _search_vault(tmp_path)
    _write_embedded_vector_config(tmp_path, dimensions=64)
    backend = _stored_vector_backend(tmp_path)
    backend.records["release-workflow"]["embedding_version"] = "local-hash-v1"

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="vector"),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["vector"]["status"] == "fallback"
    assert "embedding_version" in out["vector"]["detail"]
    assert out["results"][0]["id"] == "release-workflow"


def test_cmd_query_vector_mode_backend_search_failure_falls_back_to_text(tmp_path):
    _search_vault(tmp_path)
    _write_embedded_vector_config(tmp_path, dimensions=64)

    class SearchFailBackend(_RecordingBackend):
        def vector_query(self, query_vector, k=10):
            raise RuntimeError(f"cannot search {tmp_path / '.vivary' / 'data'}")

    backend = SearchFailBackend()
    backend.records = _stored_vector_backend(tmp_path).records

    with mock.patch.object(tropo, "get_backend", return_value=backend):
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="vector"),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["vector"]["status"] == "fallback"
    assert "backend search failed" in out["vector"]["detail"]
    assert "<workspace>" in out["vector"]["detail"]
    assert str(tmp_path) not in out["vector"]["detail"]
    assert out["results"][0]["id"] == "release-workflow"


def test_cmd_query_vector_mode_embedded_backend_unavailable_falls_back_to_text(tmp_path):
    _search_vault(tmp_path)
    _write_embedded_vector_config(tmp_path, dimensions=64)

    with mock.patch.object(
        tropo,
        "get_backend",
        side_effect=tropo.ConfigError("LanceDB is not installed. Run: pip install vivary-tropo[embedded]"),
    ):
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="vector"),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["vector"]["status"] == "fallback"
    assert "unavailable" in out["vector"]["detail"]
    assert "pip install vivary-tropo[embedded]" in out["vector"]["detail"]
    assert out["results"][0]["id"] == "release-workflow"


def test_vector_detail_redaction_handles_windows_case_and_extended_prefix(tmp_path):
    root = str(tmp_path)
    lower = root.lower()
    slash_lower = lower.replace("\\", "/")
    detail = f"cannot open \\\\?\\{lower}\\.vivary\\data or {slash_lower}/secret"

    redacted = tropo._redact_workspace_detail(detail, root)

    assert "<workspace>" in redacted
    assert lower not in redacted.lower()


def test_cmd_query_vector_mode_backend_crash_falls_back_without_absolute_path(tmp_path):
    _search_vault(tmp_path)
    _write_embedded_vector_config(tmp_path, dimensions=64)

    with mock.patch.object(
        tropo,
        "get_backend",
        side_effect=RuntimeError(f"cannot open {tmp_path / '.vivary' / 'data'}"),
    ):
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="vector"),
            res(str(tmp_path)),
        )

    assert rc == 0
    assert out["vector"]["status"] == "fallback"
    assert "unavailable" in out["vector"]["detail"]
    assert "<workspace>" in out["vector"]["detail"]
    assert str(tmp_path) not in out["vector"]["detail"]
    assert out["results"][0]["id"] == "release-workflow"


def test_cmd_query_vector_mode_rejects_invalid_embedding_config(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage.embedding]\n"
        "enabled = \"yes\"\n"
        "provider = \"local-hash\"\n",
        encoding="utf-8",
    )
    rc, out = _capture_rc(
        tropo.cmd_query,
        _query_args("release truth", mode="vector"),
        res(str(tmp_path)),
    )
    assert rc == 1
    assert out["vector"]["status"] == "misconfigured"
    assert "embedding.enabled" in out["vector"]["detail"]
    assert out["results"] == []


def test_cmd_query_vector_mode_rejects_too_small_dimensions(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage.embedding]\n"
        "enabled = true\n"
        "provider = \"local-hash\"\n"
        "dimensions = 1\n",
        encoding="utf-8",
    )
    rc, out = _capture_rc(
        tropo.cmd_query,
        _query_args("release truth", mode="vector"),
        res(str(tmp_path)),
    )
    assert rc == 1
    assert out["vector"]["status"] == "misconfigured"
    assert "embedding.dimensions" in out["vector"]["detail"]
    assert out["results"] == []


def test_cmd_query_vector_mode_redacts_malformed_storage_config_path(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_text(
        "[storage.embedding\n"
        "enabled = true\n",
        encoding="utf-8",
    )
    rc, out = _capture_rc(
        tropo.cmd_query,
        _query_args("release truth", mode="vector"),
        res(str(tmp_path)),
    )
    assert rc == 1
    assert out["vector"]["status"] == "misconfigured"
    assert ".vivary/storage.toml" in out["vector"]["detail"]
    assert str(tmp_path) not in out["vector"]["detail"]
    assert out["results"] == []


def test_cmd_query_vector_mode_reports_invalid_utf8_storage_config(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "storage.toml").write_bytes(b"\xff\xfe\x00")
    rc, out = _capture_rc(
        tropo.cmd_query,
        _query_args("release truth", mode="vector"),
        res(str(tmp_path)),
    )
    assert rc == 1
    assert out["vector"]["status"] == "misconfigured"
    assert ".vivary/storage.toml" in out["vector"]["detail"]
    assert str(tmp_path) not in out["vector"]["detail"]
    assert out["results"] == []


def test_vector_storage_config_oserror_redacts_path(tmp_path):
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    storage_path = vivary_dir / "storage.toml"
    storage_path.write_text("[storage.embedding]\n", encoding="utf-8")
    error = PermissionError(13, "Access is denied", str(storage_path))
    with mock.patch("builtins.open", side_effect=error):
        config = tropo._load_vector_query_config(str(tmp_path))
    assert config["status"] == "misconfigured"
    assert ".vivary/storage.toml" in config["detail"]
    assert str(tmp_path) not in config["detail"]


def test_cmd_query_semantic_mode_reports_unavailable_without_memory(tmp_path):
    _search_vault(tmp_path)
    rc, out = _capture_rc(
        tropo.cmd_query,
        _query_args("release truth", mode="semantic"),
        res(str(tmp_path)),
    )
    assert rc == 1
    assert out["mode"] == "semantic"
    assert out["results"] == []
    assert out["semantic"]["status"] == "disabled"
    assert "memory.toml" in out["semantic"]["detail"]


def test_cmd_query_semantic_mode_rejects_invalid_memory_config(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "memory.toml").write_text(
        '[memory]\nenabled = "false"\nprovider = "cognee"\n',
        encoding="utf-8",
    )

    rc, out = _capture_rc(
        tropo.cmd_query,
        _query_args("release truth", mode="semantic"),
        res(str(tmp_path)),
    )

    assert rc == 1
    assert out["semantic"]["status"] == "misconfigured"
    assert "memory.enabled" in out["semantic"]["detail"]


def test_semantic_memory_query_config_accepts_leading_utf8_bom(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "memory.toml").write_text(
        '[memory]\nenabled = true\nprovider = "cognee"\n',
        encoding="utf-8-sig",
    )

    config = tropo._load_memory_query_config(str(tmp_path))

    assert config["status"] == "configured"
    assert config["provider"] == "cognee"


def test_cmd_query_semantic_mode_reports_invalid_utf8_memory_config(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "memory.toml").write_bytes(b"\xff\xfe\x00")

    rc, out = _capture_rc(
        tropo.cmd_query,
        _query_args("release truth", mode="semantic"),
        res(str(tmp_path)),
    )

    assert rc == 1
    assert out["semantic"]["status"] == "misconfigured"
    assert ".vivary/memory.toml" in out["semantic"]["detail"]
    assert str(tmp_path) not in out["semantic"]["detail"]
    assert out["results"] == []


def test_semantic_memory_config_oserror_does_not_disclose_path(tmp_path):
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    memory_path = vivary_dir / "memory.toml"
    memory_path.write_text("[memory]\n", encoding="utf-8")
    error = PermissionError(13, "Access is denied", str(memory_path))

    with mock.patch("builtins.open", side_effect=error):
        config = tropo._load_memory_query_config(str(tmp_path))

    assert config["status"] == "misconfigured"
    assert ".vivary/memory.toml" in config["detail"]
    assert str(tmp_path) not in config["detail"]


def test_semantic_adapter_origin_rejects_workspace_local_module(tmp_path):
    malicious = tmp_path / "vivary_cognee.py"
    malicious.write_text("raise AssertionError('should not import')\n", encoding="utf-8")
    allowed = Path(ROOT).parent / "memory-cognee" / "vivary_cognee.py"

    assert tropo._adapter_origin_is_unsafe(str(malicious), str(tmp_path), str(allowed))


def test_semantic_adapter_origin_rejects_project_local_venv_install(tmp_path):
    site_packages = tmp_path / ".venv" / "Lib" / "site-packages"
    origin = site_packages / "vivary_cognee.py"
    allowed = Path(ROOT).parent / "memory-cognee" / "vivary_cognee.py"
    original_get_paths = tropo.sysconfig.get_paths
    tropo.sysconfig.get_paths = lambda: {
        "purelib": str(site_packages),
        "platlib": str(site_packages),
    }
    try:
        assert tropo._adapter_origin_is_unsafe(str(origin), str(tmp_path), str(allowed))
    finally:
        tropo.sysconfig.get_paths = original_get_paths


def test_semantic_adapter_origin_allows_external_venv_install(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    external_venv = Path(tempfile.mkdtemp(prefix="vivary-external-venv-"))
    try:
        site_packages = external_venv / "Lib" / "site-packages"
        origin = site_packages / "vivary_cognee.py"
        allowed = Path(ROOT).parent / "memory-cognee" / "vivary_cognee.py"
        original_get_paths = tropo.sysconfig.get_paths
        tropo.sysconfig.get_paths = lambda: {
            "purelib": str(site_packages),
            "platlib": str(site_packages),
        }
        try:
            assert not tropo._adapter_origin_is_unsafe(str(origin), str(workspace), str(allowed))
        finally:
            tropo.sysconfig.get_paths = original_get_paths
    finally:
        shutil.rmtree(external_venv, ignore_errors=True)


def test_semantic_adapter_source_loader_registers_module_for_dataclasses():
    adapter_path = Path(ROOT).parent / "memory-cognee" / "vivary_cognee.py"

    module = tropo._load_cognee_adapter_from_path(str(adapter_path))

    assert hasattr(module, "CogneeMemoryAdapter")


def test_cmd_query_semantic_mode_returns_optional_provider_hits(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "memory.toml").write_text(
        '[memory]\nenabled = true\nprovider = "cognee"\n',
        encoding="utf-8",
    )

    class FakeHit:
        node_id = "release-workflow"
        type = "decision"
        path = "decisions/release-workflow.md"
        score = 0.98
        reason = "typed semantic match"
        provider = "cognee"
        edge_context = []

    class FakeAdapter:
        def __init__(self, root):
            self.root = root

        async def recall(self, query, *, k=10):
            assert query == "release truth"
            assert k == 10
            return [FakeHit()]

    previous = sys.modules.get("vivary_cognee")
    allowed = Path(ROOT).parent / "memory-cognee" / "vivary_cognee.py"
    sys.modules["vivary_cognee"] = types.SimpleNamespace(
        CogneeMemoryAdapter=FakeAdapter,
        AdapterError=RuntimeError,
        __file__=str(allowed),
        __version__="0.1.1",
        TROPO_SEMANTIC_ADAPTER_API=1,
        REQUIRES_EXPLICIT_PROVIDER_GATES=True,
    )
    try:
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="semantic"),
            res(str(tmp_path)),
        )
    finally:
        if previous is None:
            sys.modules.pop("vivary_cognee", None)
        else:
            sys.modules["vivary_cognee"] = previous

    assert rc == 0
    assert out["mode"] == "semantic"
    assert out["semantic"]["provider"] == "cognee"
    assert out["semantic"]["status"] == "ok"
    assert [r["id"] for r in out["results"]] == ["release-workflow"]
    assert out["results"][0]["reason"] == "typed semantic match"


def test_cmd_query_semantic_provider_error_does_not_disclose_path(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "memory.toml").write_text(
        '[memory]\nenabled = true\nprovider = "cognee"\n',
        encoding="utf-8",
    )
    sensitive_path = tmp_path.parent / "outside-secret" / "database.sqlite"

    class FakeAdapter:
        def __init__(self, root):
            self.root = root

        async def recall(self, query, *, k=10):
            raise RuntimeError(f"cannot open {sensitive_path}")

    previous = sys.modules.get("vivary_cognee")
    allowed = Path(ROOT).parent / "memory-cognee" / "vivary_cognee.py"
    sys.modules["vivary_cognee"] = types.SimpleNamespace(
        CogneeMemoryAdapter=FakeAdapter,
        AdapterError=RuntimeError,
        __file__=str(allowed),
        __version__="0.1.1",
        TROPO_SEMANTIC_ADAPTER_API=1,
        REQUIRES_EXPLICIT_PROVIDER_GATES=True,
    )
    try:
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="semantic"),
            res(str(tmp_path)),
        )
    finally:
        if previous is None:
            sys.modules.pop("vivary_cognee", None)
        else:
            sys.modules["vivary_cognee"] = previous

    assert rc == 1
    assert out["semantic"]["status"] == "unavailable"
    assert "semantic-memory provider query failed" in out["semantic"]["detail"]
    assert str(sensitive_path) not in out["semantic"]["detail"]
    assert out["results"] == []


def test_cmd_query_semantic_mode_rejects_stale_adapter(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "memory.toml").write_text(
        '[memory]\nenabled = true\nprovider = "cognee"\n',
        encoding="utf-8",
    )

    class FakeAdapter:
        def __init__(self, root):
            self.root = root

        async def recall(self, query, *, k=10):
            return []

    previous = sys.modules.get("vivary_cognee")
    allowed = Path(ROOT).parent / "memory-cognee" / "vivary_cognee.py"
    sys.modules["vivary_cognee"] = types.SimpleNamespace(
        CogneeMemoryAdapter=FakeAdapter,
        AdapterError=RuntimeError,
        __file__=str(allowed),
        __version__="0.1.0",
    )
    try:
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="semantic"),
            res(str(tmp_path)),
        )
    finally:
        if previous is None:
            sys.modules.pop("vivary_cognee", None)
        else:
            sys.modules["vivary_cognee"] = previous

    assert rc == 1
    assert out["semantic"]["status"] == "unavailable"
    assert out["results"] == []


def test_cmd_query_semantic_mode_rejects_noncallable_adapter(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "memory.toml").write_text(
        '[memory]\nenabled = true\nprovider = "cognee"\n',
        encoding="utf-8",
    )

    previous = sys.modules.get("vivary_cognee")
    allowed = Path(ROOT).parent / "memory-cognee" / "vivary_cognee.py"
    sys.modules["vivary_cognee"] = types.SimpleNamespace(
        CogneeMemoryAdapter=None,
        AdapterError=RuntimeError,
        __file__=str(allowed),
        __version__="0.1.1",
        TROPO_SEMANTIC_ADAPTER_API=1,
        REQUIRES_EXPLICIT_PROVIDER_GATES=True,
    )
    try:
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="semantic"),
            res(str(tmp_path)),
        )
    finally:
        if previous is None:
            sys.modules.pop("vivary_cognee", None)
        else:
            sys.modules["vivary_cognee"] = previous

    assert rc == 1
    assert out["semantic"]["status"] == "unavailable"
    assert out["results"] == []


def test_cmd_query_semantic_mode_zero_k_does_not_call_provider(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "memory.toml").write_text(
        '[memory]\nenabled = true\nprovider = "cognee"\n',
        encoding="utf-8",
    )

    class FakeAdapter:
        def __init__(self, root):
            self.root = root

        async def recall(self, query, *, k=10):
            raise AssertionError("provider should not be called for k=0")

    previous = sys.modules.get("vivary_cognee")
    allowed = Path(ROOT).parent / "memory-cognee" / "vivary_cognee.py"
    sys.modules["vivary_cognee"] = types.SimpleNamespace(
        CogneeMemoryAdapter=FakeAdapter,
        AdapterError=RuntimeError,
        __file__=str(allowed),
        __version__="0.1.1",
        TROPO_SEMANTIC_ADAPTER_API=1,
        REQUIRES_EXPLICIT_PROVIDER_GATES=True,
    )
    try:
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="semantic", k=0),
            res(str(tmp_path)),
        )
    finally:
        if previous is None:
            sys.modules.pop("vivary_cognee", None)
        else:
            sys.modules["vivary_cognee"] = previous

    assert rc == 0
    assert out["semantic"]["status"] == "ok"
    assert out["results"] == []


def test_cmd_query_semantic_mode_applies_graph_filters(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "memory.toml").write_text(
        '[memory]\nenabled = true\nprovider = "cognee"\n',
        encoding="utf-8",
    )

    class FakeHit:
        node_id = "release-workflow"
        type = "decision"
        path = "decisions/release-workflow.md"
        score = 0.98
        reason = "typed semantic match"
        provider = "cognee"
        edge_context = [{"source_id": "release-workflow", "field": "affects", "target_id": "agent-workspace"}]

    class FakeAdapter:
        def __init__(self, root):
            self.root = root

        async def recall(self, query, *, k=10):
            return [FakeHit()]

    previous = sys.modules.get("vivary_cognee")
    allowed = Path(ROOT).parent / "memory-cognee" / "vivary_cognee.py"
    sys.modules["vivary_cognee"] = types.SimpleNamespace(
        CogneeMemoryAdapter=FakeAdapter,
        AdapterError=RuntimeError,
        __file__=str(allowed),
        __version__="0.1.1",
        TROPO_SEMANTIC_ADAPTER_API=1,
        REQUIRES_EXPLICIT_PROVIDER_GATES=True,
    )
    try:
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args(
                "release truth",
                mode="semantic",
                type=["decision"],
                path=["decisions/*"],
                edge=["affects:agent-workspace"],
            ),
            res(str(tmp_path)),
        )
        rc_wrong_type, out_wrong_type = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="semantic", type=["module"]),
            res(str(tmp_path)),
        )
    finally:
        if previous is None:
            sys.modules.pop("vivary_cognee", None)
        else:
            sys.modules["vivary_cognee"] = previous

    assert rc == 0
    assert [r["id"] for r in out["results"]] == ["release-workflow"]
    assert rc_wrong_type == 0
    assert out_wrong_type["results"] == []


def test_cmd_query_semantic_mode_overfetches_before_filtering(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "memory.toml").write_text(
        '[memory]\nenabled = true\nprovider = "cognee"\n',
        encoding="utf-8",
    )
    recall_ks = []

    class ModuleHit:
        node_id = "agent-workspace"
        type = "module"
        path = "modules/agent-workspace/index.md"
        score = 0.99
        reason = "semantic module match"
        provider = "cognee"
        edge_context = []

    class DecisionHit:
        node_id = "release-workflow"
        type = "decision"
        path = "decisions/release-workflow.md"
        score = 0.98
        reason = "typed semantic match"
        provider = "cognee"
        edge_context = []

    class FakeAdapter:
        def __init__(self, root):
            self.root = root

        async def recall(self, query, *, k=10):
            recall_ks.append(k)
            return [ModuleHit(), DecisionHit()][:k]

    previous = sys.modules.get("vivary_cognee")
    allowed = Path(ROOT).parent / "memory-cognee" / "vivary_cognee.py"
    sys.modules["vivary_cognee"] = types.SimpleNamespace(
        CogneeMemoryAdapter=FakeAdapter,
        AdapterError=RuntimeError,
        __file__=str(allowed),
        __version__="0.1.1",
        TROPO_SEMANTIC_ADAPTER_API=1,
        REQUIRES_EXPLICIT_PROVIDER_GATES=True,
    )
    try:
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="semantic", k=1, type=["decision"]),
            res(str(tmp_path)),
        )
    finally:
        if previous is None:
            sys.modules.pop("vivary_cognee", None)
        else:
            sys.modules["vivary_cognee"] = previous

    assert rc == 0
    assert recall_ks == [50]
    assert out["k"] == 1
    assert [r["id"] for r in out["results"]] == ["release-workflow"]


def test_cmd_query_semantic_mode_caps_provider_overfetch(tmp_path):
    _search_vault(tmp_path)
    vivary_dir = tmp_path / ".vivary"
    vivary_dir.mkdir()
    (vivary_dir / "memory.toml").write_text(
        '[memory]\nenabled = true\nprovider = "cognee"\n',
        encoding="utf-8",
    )
    recall_ks = []

    class FakeAdapter:
        def __init__(self, root):
            self.root = root

        async def recall(self, query, *, k=10):
            recall_ks.append(k)
            return []

    previous = sys.modules.get("vivary_cognee")
    allowed = Path(ROOT).parent / "memory-cognee" / "vivary_cognee.py"
    sys.modules["vivary_cognee"] = types.SimpleNamespace(
        CogneeMemoryAdapter=FakeAdapter,
        AdapterError=RuntimeError,
        __file__=str(allowed),
        __version__="0.1.1",
        TROPO_SEMANTIC_ADAPTER_API=1,
        REQUIRES_EXPLICIT_PROVIDER_GATES=True,
    )
    try:
        rc, out = _capture_rc(
            tropo.cmd_query,
            _query_args("release truth", mode="semantic", k=1_000_000, type=["decision"]),
            res(str(tmp_path)),
        )
    finally:
        if previous is None:
            sys.modules.pop("vivary_cognee", None)
        else:
            sys.modules["vivary_cognee"] = previous

    assert rc == 0
    assert recall_ks == [250]
    assert out["k"] == 1_000_000
    assert out["results"] == []


# --- map: read-only filesystem inventory -----------------------------------

def _map_tree(tmp_path):
    """Nested code + docs + an ignored folder (node_modules) + an oversized
    file, plus one module with an index and one without."""
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.py").write_text("print('a')\n", encoding="utf-8")
    (tmp_path / "src" / "b.py").write_text("print('b')\n", encoding="utf-8")
    (tmp_path / "src" / "c.py").write_text("print('c')\n", encoding="utf-8")
    (tmp_path / "src" / "d.py").write_text("print('d')\n", encoding="utf-8")
    (tmp_path / "src" / "e.py").write_text("print('e')\n", encoding="utf-8")
    # src has 5 files and no index -> should be flagged as a likely module.

    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "README.md").write_text("# Docs\n", encoding="utf-8")
    (tmp_path / "docs" / "guide.md").write_text("# Guide\n", encoding="utf-8")
    # docs has an index (README.md) -> should NOT be flagged.

    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "pkg.js").write_text("// pkg\n", encoding="utf-8")
    (tmp_path / "node_modules" / "sub").mkdir()
    (tmp_path / "node_modules" / "sub" / "x.js").write_text("// x\n", encoding="utf-8")
    # node_modules is fixed-skip-list -> must be entirely absent from output.

    (tmp_path / "big.bin").write_bytes(b"0" * 5000)  # the oversized file


def _map_args(root, json_out=True, depth=None, max_entries=None, paths=()):
    return argparse.Namespace(root=root, json=json_out, depth=depth,
                              max_entries=max_entries, paths=list(paths))


def test_map_counts_and_ignored_folder_absent(tmp_path):
    _map_tree(tmp_path)
    rc, out = _capture_rc(tropo.cmd_map, _map_args(str(tmp_path)))
    assert rc == 0
    # 5 .py + 2 .md + 1 .bin = 8 files; node_modules' 2 files must not be counted.
    assert out["summary"]["total_files"] == 8
    dir_paths = [d["path"] for d in out["directories"]]
    assert not any("node_modules" in p for p in dir_paths)
    assert not any("pkg.js" in f["path"] for f in out["summary"]["largest_files"])
    assert not any("node_modules" in p for p in out["summary"]["index_files"])

    src_row = next(d for d in out["directories"] if d["path"] == "src")
    assert src_row["files"] == 5
    docs_row = next(d for d in out["directories"] if d["path"] == "docs")
    assert docs_row["files"] == 2
    assert docs_row["has_index"] is True

    largest_paths = [f["path"] for f in out["summary"]["largest_files"]]
    assert "big.bin" in largest_paths
    assert out["summary"]["largest_files"][0]["path"] == "big.bin"  # biggest first


def test_map_missing_index_detection(tmp_path):
    _map_tree(tmp_path)
    rc, out = _capture_rc(tropo.cmd_map, _map_args(str(tmp_path)))
    assert rc == 0
    flagged = out["summary"]["likely_modules_without_index"]
    assert "src" in flagged        # 5 files, no index.md/README.md
    assert "docs" not in flagged   # has README.md
    assert "docs/README.md" in out["summary"]["index_files"]


def test_map_json_is_deterministic(tmp_path):
    import contextlib
    import io
    import json as _json
    _map_tree(tmp_path)

    def run():
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            tropo.cmd_map(_map_args(str(tmp_path)))
        return buf.getvalue()

    first, second = run(), run()
    assert first == second
    _json.loads(first)  # parses cleanly


def test_map_paths_use_forward_slashes(tmp_path):
    _map_tree(tmp_path)
    rc, out = _capture_rc(tropo.cmd_map, _map_args(str(tmp_path)))
    assert rc == 0
    assert "\\" not in out["root"]
    src_row = next(d for d in out["directories"] if d["path"] == "src")
    assert "\\" not in src_row["path"]
    for f in out["summary"]["largest_files"]:
        assert "\\" not in f["path"]
    for p in out["summary"]["index_files"]:
        assert "\\" not in p


def test_map_is_read_only(tmp_path):
    import contextlib
    import io
    _map_tree(tmp_path)
    before = {}
    for dirpath, dirnames, filenames in os.walk(tmp_path):
        for fname in filenames:
            full = os.path.join(dirpath, fname)
            st = os.stat(full)
            before[full] = (st.st_mtime_ns, st.st_size)

    with contextlib.redirect_stdout(io.StringIO()):
        tropo.cmd_map(_map_args(str(tmp_path), json_out=False, depth=2, max_entries=3))
        tropo.cmd_map(_map_args(str(tmp_path)))

    after = {}
    for dirpath, dirnames, filenames in os.walk(tmp_path):
        for fname in filenames:
            full = os.path.join(dirpath, fname)
            st = os.stat(full)
            after[full] = (st.st_mtime_ns, st.st_size)

    assert before == after  # same file set, same sizes, same mtimes


def test_map_markdown_output_and_max_entries(tmp_path):
    _map_tree(tmp_path)
    import contextlib
    import io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = tropo.cmd_map(_map_args(str(tmp_path), json_out=False, max_entries=1))
    out = buf.getvalue()
    assert rc == 0
    assert out.startswith("# tropo map:")
    assert "## Directories" in out
    assert "## Likely modules without an index" in out
    # max_entries=1 caps the table to the root row only: the header row plus
    # exactly one data row (the "|---|" divider does not start with "| ").
    table_lines = [ln for ln in out.splitlines() if ln.startswith("| ")]
    assert len(table_lines) == 2
    assert table_lines[1].startswith("| . |")


def test_map_depth_limits_table_not_counts(tmp_path):
    _map_tree(tmp_path)
    rc, out = _capture_rc(tropo.cmd_map, _map_args(str(tmp_path), depth=0))
    assert rc == 0
    assert out["directories"] == [{
        "path": ".", "depth": 0, "files": 8, "size": out["directories"][0]["size"],
        "dominant_extensions": out["directories"][0]["dominant_extensions"],
        "has_index": False,
    }]
    # counts still reflect the whole tree even though the table is depth 0
    assert out["summary"]["total_files"] == 8


def test_map_json_max_entries_caps_directories(tmp_path):
    _map_tree(tmp_path)
    rc, out = _capture_rc(tropo.cmd_map, _map_args(str(tmp_path), max_entries=1))
    assert rc == 0
    # --max-entries must cap the JSON directories array exactly like the
    # markdown table (it was silently ignored in --json mode).
    assert len(out["directories"]) == 1
    assert out["directories"][0]["path"] == "."
    # summary sections are not affected by the row cap
    assert out["summary"]["total_files"] == 8
    assert len(out["summary"]["largest_files"]) == 8


def test_map_root_is_basename_only(tmp_path):
    _map_tree(tmp_path)
    rc, out = _capture_rc(tropo.cmd_map, _map_args(str(tmp_path)))
    assert rc == 0
    # The JSON map is pitched as shareable: `root` must be the basename only,
    # never the absolute local path (which contains the username).
    assert out["root"] == os.path.basename(str(tmp_path))
    assert "/" not in out["root"] and "\\" not in out["root"]

    import contextlib
    import io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        tropo.cmd_map(_map_args(str(tmp_path), json_out=False))
    first_line = buf.getvalue().splitlines()[0]
    assert first_line == f"# tropo map: {os.path.basename(str(tmp_path))}"


def test_map_junction_cycle_not_double_counted(tmp_path):
    """A junction (mklink /J) pointing back up the tree must not loop or
    double-count: os.walk's followlinks=False does not stop junctions because
    Windows does not classify them as symlinks. Skips gracefully when junction
    creation is unavailable (non-Windows, or mklink fails)."""
    import subprocess
    if os.name != "nt":
        return  # junctions are a Windows/NTFS concept
    _map_tree(tmp_path)
    link = tmp_path / "src" / "loop"
    try:
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(tmp_path)],
            capture_output=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return  # cannot create a junction here — skip gracefully
    if result.returncode != 0:
        return  # mklink unavailable/refused — skip gracefully
    try:
        rc, out = _capture_rc(tropo.cmd_map, _map_args(str(tmp_path)))
        assert rc == 0
        assert out["summary"]["total_files"] == 8  # not inflated by the cycle
        assert not any("loop" in d["path"] for d in out["directories"])
        assert not any("loop" in f["path"] for f in out["summary"]["largest_files"])
    finally:
        os.rmdir(link)  # removes the junction only, never its target's contents


def test_map_prunes_junction_to_outside_root(tmp_path):
    """A junction inside the mapped tree must not leak outside-root files into
    the inventory. Skips gracefully where NTFS junctions cannot be created."""
    import subprocess
    if os.name != "nt":
        return
    _map_tree(tmp_path)
    outside = tmp_path.parent / f"outside-map-{uuid.uuid4().hex}"
    outside.mkdir()
    link = tmp_path / "src" / "outside"
    try:
        (outside / "leak.md").write_text("# Secret\n" * 500, encoding="utf-8")
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(outside)],
            capture_output=True, timeout=15)
        if result.returncode != 0:
            return

        rc, out = _capture_rc(tropo.cmd_map, _map_args(str(tmp_path)))

        assert rc == 0
        assert out["summary"]["total_files"] == 8
        assert not any("outside" in d["path"] for d in out["directories"])
        assert not any("outside" in f["path"] for f in out["summary"]["largest_files"])
        assert not any("leak" in f["path"] for f in out["summary"]["largest_files"])
    finally:
        if link.exists():
            os.rmdir(link)
        shutil.rmtree(outside, ignore_errors=True)


def test_map_counts_hardlinked_files(tmp_path):
    """Hard-linked files are counted like any other file.

    This deliberately replaces `test_map_skips_hardlinked_private_file`, which
    encoded the opposite intent. A hard link is an ordinary directory entry — unlike
    a symlink or reparse point, it is not an alternate route that risks cycles or
    double-walking. Skipping them silently undercut totals, largest-file and module
    detection for ordinary public files, and it was never a privacy control: that is
    what `exclude` and `MAP_SKIP_DIRS` are for. `map` counts paths and sums per-path
    sizes; it does not claim to report disk usage.
    """
    (tmp_path / "src").mkdir()
    (tmp_path / "docs").mkdir()
    original = tmp_path / "docs" / "guide.md"
    original.write_text("# Guide\n" * 500, encoding="utf-8")
    linked = tmp_path / "src" / "guide-copy.md"
    try:
        os.link(original, linked)
    except (AttributeError, OSError):
        return
    (tmp_path / "src" / "open.md").write_text("# Open\n", encoding="utf-8")

    rc, out = _capture_rc(tropo.cmd_map, _map_args(str(tmp_path)))

    assert rc == 0
    assert out["summary"]["total_files"] == 3, out["summary"]["total_files"]
    largest = [f["path"] for f in out["summary"]["largest_files"]]
    assert any("guide-copy" in path for path in largest), largest
    assert any("guide.md" in path for path in largest), largest


def test_map_skips_symlinked_file(tmp_path):
    """Symlinks and reparse points stay omitted, and for a reason that does not
    apply to hard links: they are an alternate route to a file the walk may already
    have counted, and following them can cycle."""
    (tmp_path / "src").mkdir()
    real = tmp_path / "src" / "real.md"
    real.write_text("# Real\n" * 200, encoding="utf-8")
    link = tmp_path / "src" / "linked.md"
    try:
        link.symlink_to(real)
    except (AttributeError, OSError, NotImplementedError):
        return

    rc, out = _capture_rc(tropo.cmd_map, _map_args(str(tmp_path)))

    assert rc == 0
    assert out["summary"]["total_files"] == 1
    assert not any("linked" in f["path"] for f in out["summary"]["largest_files"])


def test_map_markdown_escapes_table_cells():
    # '|' would split a Markdown table cell; newlines would break the row.
    assert tropo._md_cell("a|b.md") == "a\\|b.md"
    assert tropo._md_cell("a\nb") == "a b"
    assert tropo._md_cell("a\r\nb") == "a  b"
    assert tropo._md_cell("plain/path.md") == "plain/path.md"


def test_map_file_level_excludes(tmp_path):
    (tmp_path / "tropo.toml").write_text(
        "exclude = ['notes/secret.md', 'vault/README.md']\n"
        "[base]\nallow_untyped = true\n", encoding="utf-8")
    (tmp_path / "notes").mkdir()
    # big enough that a leak would top largest_files
    (tmp_path / "notes" / "secret.md").write_text("# Secret\n" * 500, encoding="utf-8")
    (tmp_path / "notes" / "open.md").write_text("# Open\n", encoding="utf-8")
    (tmp_path / "vault").mkdir()
    (tmp_path / "vault" / "README.md").write_text("# Vault\n", encoding="utf-8")

    rc, out = _capture_rc(tropo.cmd_map, _map_args(str(tmp_path)))
    assert rc == 0
    # tropo.toml + notes/open.md = 2; both excluded files out of every surface
    assert out["summary"]["total_files"] == 2
    assert not any("secret" in f["path"] for f in out["summary"]["largest_files"])
    assert "vault/README.md" not in out["summary"]["index_files"]
    notes_row = next(d for d in out["directories"] if d["path"] == "notes")
    assert notes_row["files"] == 1
    vault_row = next(d for d in out["directories"] if d["path"] == "vault")
    assert vault_row["has_index"] is False  # its only index file is excluded


def test_map_positional_path_is_root(tmp_path):
    _map_tree(tmp_path)
    rc, out = _capture_rc(
        tropo.cmd_map, _map_args(None, paths=[str(tmp_path)]))
    assert rc == 0
    assert out["summary"]["total_files"] == 8
    assert out["root"] == os.path.basename(str(tmp_path))


def test_map_rejects_multiple_or_conflicting_paths(tmp_path):
    _map_tree(tmp_path)
    for bad in (
        _map_args(None, paths=[str(tmp_path), str(tmp_path / "src")]),
        _map_args(str(tmp_path), paths=[str(tmp_path)]),  # --root AND positional
    ):
        try:
            tropo.cmd_map(bad)
            assert False, "expected SystemExit for ambiguous map root"
        except SystemExit:
            pass


def test_map_subtree_rebases_config_excludes(tmp_path):
    """`exclude = ["docs/private"]` is anchored at the config root; mapping
    --root docs must still keep private/ out (the pattern gets rebased)."""
    (tmp_path / "tropo.toml").write_text(
        "exclude = ['docs/private']\n[base]\nallow_untyped = true\n",
        encoding="utf-8")
    docs = tmp_path / "docs"
    (docs / "private").mkdir(parents=True)
    (docs / "private" / "secret.md").write_text("# Secret\n", encoding="utf-8")
    (docs / "guide.md").write_text("# Guide\n", encoding="utf-8")

    rc, out = _capture_rc(tropo.cmd_map, _map_args(str(docs)))
    assert rc == 0
    assert out["summary"]["total_files"] == 1  # guide.md only
    assert not any("private" in d["path"] for d in out["directories"])
    assert not any("secret" in f["path"] for f in out["summary"]["largest_files"])

    # same exclude still works when mapping from the config root itself
    rc, out = _capture_rc(tropo.cmd_map, _map_args(str(tmp_path)))
    assert rc == 0
    assert not any("private" in d["path"] for d in out["directories"])


def test_version_constant_matches_pyproject(tmp_path):
    import tomllib
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    declared = tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]["version"]
    assert tropo.__version__ == declared, (
        f"tropo.__version__ {tropo.__version__} != pyproject {declared} — "
        "bump both together at release time"
    )


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        import inspect
        kw = {}
        if "tmp_path" in inspect.signature(fn).parameters:
            kw["tmp_path"] = make_tmp_path()
        try:
            fn(**kw)
            print(f"  ok  {fn.__name__}")
            passed += 1
        except Exception as e:
            print(f"FAIL  {fn.__name__}: {e}")
        finally:
            tmp_path = kw.get("tmp_path")
            if tmp_path is not None and tmp_path.exists():
                remove_workspace(tmp_path)
    print(f"\n{passed}/{len(fns)} passed")
    sys.exit(0 if passed == len(fns) else 1)
