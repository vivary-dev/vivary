"""Run one ci.yml job's steps in order, the way the GitHub runner does.

The Dagger module writes a plan and runs this file once per job inside its
container. Each step gets fresh GITHUB_PATH and GITHUB_ENV files, and what a
step writes there applies to the steps after it. One process per job keeps the
engine from committing the container filesystem after every step.
"""

import json
import os
import re
import subprocess
import sys
import time

SYSTEM_PATH = ["/usr/local/bin", "/usr/local/sbin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]


def parse_env_file(text):
    """GitHub's environment file format: NAME=value lines and NAME<<DELIMITER blocks."""
    lines = text.split("\n")
    entries = {}
    index = 0
    while index < len(lines):
        line = lines[index]
        index += 1
        if not line:
            continue
        block = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)<<(.+)", line)
        if block:
            if block.group(2) not in lines[index:]:
                raise SystemExit(f"unterminated {block.group(1)} block in GITHUB_ENV")
            end = lines.index(block.group(2), index)
            entries[block.group(1)] = "\n".join(lines[index:end])
            index = end + 1
            continue
        pair = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)=(.*)", line)
        if not pair:
            raise SystemExit("malformed GITHUB_ENV line")
        entries[pair.group(1)] = pair.group(2)
    return entries


def main():
    with open(sys.argv[1], encoding="utf-8") as handle:
        plan = json.load(handle)
    env = {**os.environ, **plan["env"]}
    path = list(plan["path"])
    commands = os.path.join(plan["temp"], "_runner_file_commands")
    os.makedirs(commands, exist_ok=True)
    for index, step in enumerate(plan["steps"]):
        os.makedirs(os.path.dirname(step["script"]), exist_ok=True)
        with open(step["script"], "w", encoding="utf-8") as handle:
            handle.write(step["run"])
        files = {name: os.path.join(commands, f"{name}_{index}") for name in ("path", "env")}
        for file in files.values():
            open(file, "w").close()
        step_env = {**env, **step["env"], "GITHUB_PATH": files["path"], "GITHUB_ENV": files["env"],
                    "PATH": ":".join(path + SYSTEM_PATH)}
        print(f"::step {index} {step['label']}", flush=True)
        started = time.monotonic()
        result = subprocess.run(step["argv"], cwd=step["cwd"], env=step_env)
        print(f"::step {index} exit {result.returncode} after {time.monotonic() - started:.1f}s", flush=True)
        if result.returncode:
            raise SystemExit(f"step failed: {step['label']}")
        with open(files["path"], encoding="utf-8") as handle:
            for line in filter(None, handle.read().split("\n")):
                path.insert(0, line)
        with open(files["env"], encoding="utf-8") as handle:
            env.update(parse_env_file(handle.read()))


if __name__ == "__main__":
    main()
