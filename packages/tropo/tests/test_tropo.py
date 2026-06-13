"""Tests for the tropo engine. Run: python -m pytest tests/ (or python tests/test_tropo.py)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tropo  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VAULT = os.path.join(ROOT, "examples", "vault")
SCRIPT_DIR = ROOT


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
                   argparse.Namespace(paths=[], strict=False, json=True, quiet=False), res())
    assert set(out) >= {"checked", "clean", "errors", "warnings", "findings"}
    assert out["errors"] == 0


def test_types_and_stats_json():
    t = _capture(tropo.cmd_types, argparse.Namespace(json=True), res())
    assert "person" in t["types"]
    s = _capture(tropo.cmd_stats, argparse.Namespace(paths=[], json=True), res())
    assert s["total"] >= 1 and "by_type" in s


# --- packs + tighten-only law ----------------------------------------------

def test_pack_composes():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        with open(os.path.join(td, "tropo.toml"), "w") as fh:
            fh.write('packs = ["dev-project"]\n')
        c = tropo.load_config(td, SCRIPT_DIR)
        assert "runbook" in c.types and "spec" in c.types


def test_repo_graph_pack_composes():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
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


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        import inspect
        kw = {}
        if "tmp_path" in inspect.signature(fn).parameters:
            import tempfile, pathlib
            kw["tmp_path"] = pathlib.Path(tempfile.mkdtemp())
        try:
            fn(**kw)
            print(f"  ok  {fn.__name__}")
            passed += 1
        except Exception as e:
            print(f"FAIL  {fn.__name__}: {e}")
    print(f"\n{passed}/{len(fns)} passed")
    sys.exit(0 if passed == len(fns) else 1)
