from vivary_gui.services import approval
from vivary_gui.services.approval import Action


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


def test_policy_persists(tmp_path, monkeypatch):
    path = tmp_path / "policy.json"
    monkeypatch.setattr(approval.config, "POLICY_PATH", path)
    policy = approval.default_policy()
    approval.add_rule(policy, "rg", "allow", "global", "fast read")
    approval.save_policy(policy)
    loaded = approval.load_policy()
    assert loaded["rules"][0]["pattern"] == "rg"
