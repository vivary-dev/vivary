#!/usr/bin/env python3
"""Tests-only resume and regression probes for the headless-loop sequencer."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))

from hoh.protocol import ProtocolError  # noqa: E402
from hoh_loop import (  # noqa: E402
    HeadlessLoop,
    HarnessError,
    RunFault,
    _native_adapter,
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run one isolated headless-loop fault probe")
    parser.add_argument("mode", choices=("resume", "regression"))
    parser.add_argument("--runtime", choices=("claude",), required=True)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--receipt-dir", type=Path, required=True)
    parser.add_argument("--iteration-timeout-seconds", type=float, required=True)
    parser.add_argument("--reported-token-budget", type=int, required=True)
    parser.add_argument("--usage-ledger", type=Path, required=True)
    return parser


def _loop(values: argparse.Namespace, run_id: str) -> HeadlessLoop:
    return HeadlessLoop(
        project=values.project,
        receipt_dir=values.receipt_dir,
        prompt_dir=ROOT / "tools" / "hoh" / "prompts",
        run_id=run_id,
        iterations=1,
        iteration_timeout_seconds=values.iteration_timeout_seconds,
        reported_token_budget=values.reported_token_budget,
        usage_ledger=values.usage_ledger,
        adapter=_native_adapter(values.runtime, values.receipt_dir),
    )


def _inject_missing_target_regression(project: Path) -> None:
    source = project / "linkcheck.py"
    original = source.read_text(encoding="utf-8")
    marker = "# hoh-regression-probe: remove missing-target findings"
    if marker in original:
        raise HarnessError("regression probe marker already exists")
    changed = original + f"""\

{marker}
_healthy_check_tree = check_tree
def check_tree(root):
    return [item for item in _healthy_check_tree(root) if item.get("code") != "missing_target"]
"""
    source.write_text(changed, encoding="utf-8")


def main(arguments: list[str] | None = None) -> int:
    values = _parser().parse_args(arguments)
    run_id = f"{values.runtime}-{values.mode}-fault"
    try:
        if values.mode == "resume":
            first = _loop(values, run_id).run(RunFault(interrupt_after_developer=True))
            if first["status"] != "interrupted":
                raise HarnessError("resume probe did not stop after the developer checkpoint")
            second = _loop(values, run_id).run()
            result = {"mode": "resume", "interrupted": first, "resumed": second}
        else:
            result = {
                "mode": "regression",
                "result": _loop(values, run_id).run(
                    RunFault(regress_before_qa=_inject_missing_target_regression)
                ),
            }
            if result["result"]["status"] != "regressed":
                raise HarnessError("regression probe did not stop acceptance")
        print(json.dumps(result, sort_keys=True))
        return 0
    except (HarnessError, ProtocolError) as error:
        print(f"fault probe refused: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
