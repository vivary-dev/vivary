#!/bin/sh
# Vivary HLDD pre-commit v1
# Linked worktrees share hooks. Only opted-in source trees run this check.
set -eu
root=$(git rev-parse --show-toplevel)
if git cat-file -e HEAD:scripts/check_hldd.py 2>/dev/null ||
   git ls-files --error-unmatch scripts/check_hldd.py >/dev/null 2>&1; then
    if [ ! -f "$root/scripts/check_hldd.py" ]; then
        echo "HLDD checker is missing. Restore it before committing." >&2
        exit 1
    fi
    if command -v python3 >/dev/null 2>&1; then
        python3 "$root/scripts/check_hldd.py" --staged
    elif command -v python >/dev/null 2>&1; then
        python "$root/scripts/check_hldd.py" --staged
    else
        echo "Python is required for the HLDD pre-commit check." >&2
        exit 1
    fi
fi
