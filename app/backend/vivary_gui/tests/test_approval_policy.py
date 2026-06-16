from vivary_gui.services import approval
from vivary_gui.services.approval import Action
from vivary_gui.services.agents.manager import Manager


def test_read_is_allowed_by_default():
    result = approval.evaluate(approval.default_policy(), Action(kind="read", command="rg --files"))
    assert result["decision"] == "allow"
    assert result["risk"] == "read"


def test_write_and_execute_ask_by_default():
    assert approval.evaluate(approval.default_policy(), Action(kind="write", command="apply_patch"))["decision"] == "ask"
    assert approval.evaluate(approval.default_policy(), Action(kind="execute", command="npm test"))["decision"] == "ask"


def test_protected_paths_never_auto_approve():
    result = approval.evaluate(approval.default_policy(), Action(kind="read", command="cat .env", target=".env"))
    assert result["decision"] == "ask"
    assert result["risk"] == "protected"


def test_dotfile_path_segments_are_protected():
    policy = approval.default_policy()
    for target in (".env.local", ".github/workflows/ci.yml", "nested/.npmrc"):
        result = approval.evaluate(policy, Action(kind="read", command=f"Get-Content {target}", target=target))
        assert result["decision"] == "ask"
        assert result["risk"] == "protected"


def test_protected_command_text_is_protected_without_structured_target():
    policy = approval.default_policy()
    commands = (
        "Get-Content .env.local",
        '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content nested/.npmrc"',
        "cat package.json",
    )
    for command in commands:
        result = approval.evaluate(policy, Action(kind="read", command=command))
        assert result["decision"] == "ask"
        assert result["risk"] == "protected"


def test_windows_shell_wrappers_classify_inner_command():
    policy = approval.default_policy()
    read = approval.evaluate(
        policy,
        Action(kind="execute", command='"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'Get-Content README.md\''),
    )
    write = approval.evaluate(
        policy,
        Action(kind="execute", command='powershell.exe -Command "Set-Content README.md changed"'),
    )
    assert read["decision"] == "allow"
    assert read["risk"] == "read"
    assert write["decision"] == "ask"
    assert write["risk"] == "write"


def test_deny_rule_beats_allow_rule():
    policy = approval.default_policy()
    approval.add_rule(policy, "npm", "allow")
    approval.add_rule(policy, "npm test", "deny")
    result = approval.evaluate(policy, Action(kind="execute", command="npm test -- --runInBand"))
    assert result["decision"] == "deny"


def test_circuit_breaker_falls_back_to_ask():
    policy = approval.default_policy()
    policy["circuit_breaker"] = {"per_turn": 1}
    result = approval.evaluate(policy, Action(kind="read", command="rg --files"), auto_count=1)
    assert result["decision"] == "ask"
    assert result["reason"] == "circuit breaker"


def test_rule_matching_normalizes_spacing_and_ignores_empty_patterns():
    policy = approval.default_policy()
    approval.add_rule(policy, "npm    test", "allow")
    approval.add_rule(policy, "", "deny")
    result = approval.evaluate(policy, Action(kind="execute", command="npm test -- --runInBand"))
    assert result["decision"] == "allow"


def test_project_scope_rules_do_not_apply_without_project_policy_context():
    policy = approval.default_policy()
    approval.add_rule(policy, "npm test", "allow", scope="project")
    result = approval.evaluate(policy, Action(kind="execute", command="npm test"))
    assert result["decision"] == "ask"


def test_policy_persists(tmp_path, monkeypatch):
    path = tmp_path / "policy.json"
    monkeypatch.setattr(approval.config, "POLICY_PATH", path)
    policy = approval.default_policy()
    approval.add_rule(policy, "rg", "allow", "global", "fast read")
    approval.save_policy(policy)
    loaded = approval.load_policy()
    assert loaded["rules"][0]["pattern"] == "rg"


def test_manager_approval_decision_persists_and_emits(tmp_path, monkeypatch):
    path = tmp_path / "policy.json"
    monkeypatch.setattr(approval.config, "POLICY_PATH", path)
    manager = Manager()
    sid = manager.create(tmp_path, "ws1", "echo")

    meta = manager.decide_approval(sid, "approval_1", "allow_always", pattern="npm test")

    assert meta["status"] == "approved"
    assert meta["saved_rule"]["pattern"] == "npm test"
    assert approval.load_policy()["rules"][0]["decision"] == "allow"
    assert manager.sessions[sid].events[-1].type == "approval_request"
    assert manager.sessions[sid].events[-1].meta["status"] == "approved"


def test_manager_project_scope_does_not_write_global_policy(tmp_path, monkeypatch):
    path = tmp_path / "policy.json"
    monkeypatch.setattr(approval.config, "POLICY_PATH", path)
    manager = Manager()
    sid = manager.create(tmp_path, "ws1", "echo")

    meta = manager.decide_approval(sid, "approval_1", "allow_always", scope="project", pattern="npm test")

    assert meta["status"] == "approved"
    assert meta["scope"] == "project"
    assert meta["saved_rule"] is None
    assert approval.load_policy()["rules"] == []
