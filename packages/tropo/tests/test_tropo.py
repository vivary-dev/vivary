"""Tests for the tropo engine. Run: python -m pytest tests/ (or python tests/test_tropo.py)."""
import contextlib
import io
import json
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


def _query_args(query, **overrides):
    data = {
        "paths": query.split(),
        "json": True,
        "k": 10,
        "type": [],
        "path": [],
        "edge": [],
        "snippet": 160,
        "explain": False,
        "root": None,
        "config": None,
        "strict": False,
        "lenient": False,
        "quiet": False,
        "dry_run": False,
        "yes": False,
        "from_backend": None,
        "to_backend": None,
        "budget": 1200,
    }
    data.update(overrides)
    return argparse.Namespace(**data)


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


def test_cmd_query_no_results(tmp_path):
    _search_vault(tmp_path)
    rc, out = _capture_rc(
        tropo.cmd_query,
        _query_args("zzznomatch123"),
        res(str(tmp_path)),
    )
    assert rc == 0
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
                shutil.rmtree(tmp_path)
    print(f"\n{passed}/{len(fns)} passed")
    sys.exit(0 if passed == len(fns) else 1)
