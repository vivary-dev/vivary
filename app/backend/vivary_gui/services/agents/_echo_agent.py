"""A fake agent that streams NDJSON events — used to verify the run/stream/cancel
pipeline without invoking (or paying for) a real agent runtime."""

import json
import os
import sys
import time

prompt = sys.argv[1] if len(sys.argv) > 1 else ""


def emit(type_: str, text: str = "") -> None:
    print(json.dumps({"type": type_, "text": text}))
    sys.stdout.flush()


emit("status", "echo run started")
for token in (prompt.split() or ["(empty prompt)"]):
    emit("message", token)
    time.sleep(0.15)
# Test hook: a RAISE_GATE marker makes the echo agent stop and raise a Vivary gate in cwd,
# mirroring what a real agent does before a durable action. Normal turns are untouched.
if "RAISE_GATE" in prompt:
    gdir = os.path.join(os.getcwd(), "gates")
    os.makedirs(gdir, exist_ok=True)
    with open(os.path.join(gdir, "echo-gate.md"), "w", encoding="utf-8") as f:
        f.write("---\nproject: test\nstatus: open\ngate: echo test gate\n---\n# Echo gate\n")
emit("done", "complete")
