"""Tests for the tropo engine. Run: python -m pytest tests/ (or python tests/test_tropo.py)."""
import os
import shutil
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tropo  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VAULT = os.path.join(ROOT, "examples", "vault")
SCRIPT_DIR = ROOT
REPO_TMP = os.path.abspath(os.path.join(ROOT, "..", "..", "sandboxes"))


def make_tmp_path():
    base = REPO_TMP if os.path.isdir(REPO_TMP) else os.getcwd()
    path = Path(base) / f"test-tropo-{uuid.uuid4().hex}"
    path.mkdir(parents=True)
    return path


@contextmanager
def temp_workspace():
    path = make_tmp_path()
    try:
        yield path
    finally:
        shutil.rmtree(path)


import argparse  # noqa: E402


def cfg(root=VAULT):
    return tropo.load_config(tropo.find_root(root), SCRIPT_DIR)


def res(root=VAULT):
    """An overlay-aware resolver rooted at the nearest tropo.toml."""
    return tropo.ConfigResolver(tropo.find_root(root), SCRIPT_DIR)


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
    out = tmp_path / "g.html"
    tropo.cmd_view(argparse.Namespace(paths=["graph"], depth=None, out=str(out)), res())
    txt = out.read_text(encoding="utf-8")
    _assert_self_contained(txt)
    for nid in ("tropo", "jeff", "2026-06-12-kickoff", "0001-folder-as-type"):
        assert f'data-id="{nid}"' in txt


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


def test_cmd_query_file_backend(tmp_path):
    _minimal_vault(tmp_path)
    rc, out = _capture_rc(
        tropo.cmd_query,
        argparse.Namespace(paths=["auth"], json=True, k=10,
                           root=str(tmp_path), config=None,
                           strict=False, lenient=False, quiet=False,
                           dry_run=False, yes=False,
                           from_backend=None, to_backend=None),
        res(str(tmp_path)),
    )
    assert rc == 0
    assert "results" in out
    assert out["query"] == "auth"
    assert len(out["results"]) >= 1


def test_cmd_query_no_results(tmp_path):
    _minimal_vault(tmp_path)
    rc, out = _capture_rc(
        tropo.cmd_query,
        argparse.Namespace(paths=["zzznomatch123"], json=True, k=10,
                           root=str(tmp_path), config=None,
                           strict=False, lenient=False, quiet=False,
                           dry_run=False, yes=False,
                           from_backend=None, to_backend=None),
        res(str(tmp_path)),
    )
    assert rc == 0
    assert out["results"] == []


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
                shutil.rmtree(tmp_path)
    print(f"\n{passed}/{len(fns)} passed")
    sys.exit(0 if passed == len(fns) else 1)
