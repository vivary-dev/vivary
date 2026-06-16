"""A fake agent that streams NDJSON events — used to verify the run/stream/cancel
pipeline without invoking (or paying for) a real agent runtime."""

import json
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
emit("done", "complete")
