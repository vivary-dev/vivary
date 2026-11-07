#!/usr/bin/env python3
"""Pin the upstream answer key before driving the workbench."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def git(*args):
    return subprocess.check_output(['git', *args], stderr=subprocess.PIPE)


def main():
    if len(sys.argv) != 2:
        raise ValueError('Usage: key.py NEW_EVIDENCE_DIRECTORY')
    root = Path(git('rev-parse', '--show-toplevel').decode().strip()).resolve()
    evidence = Path(sys.argv[1]).resolve()
    if evidence == root or root in evidence.parents:
        raise ValueError('Evidence must be outside the checkout')
    temp_root = Path(tempfile.gettempdir()).resolve()
    if evidence != temp_root and temp_root not in evidence.parents:
        raise ValueError('Evidence must be under the system temp directory')
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    try:
        git('fetch', 'origin', 'dev')
        upstream = git('rev-parse', 'FETCH_HEAD').decode().strip()
        candidate = git('rev-parse', 'HEAD').decode().strip()
        key = '.claude/skills/verify/acceptance.md'
        trusted = git('show', f'{upstream}:{key}')
        if not trusted.strip():
            raise ValueError('origin/dev answer key is empty')
        current = (root / key).read_bytes()
        committed = git('show', f'{candidate}:{key}')
        if current != trusted or committed != trusted:
            raise ValueError('Candidate answer key differs from origin/dev')
        if git('status', '--porcelain', '--untracked-files=all').strip():
            raise ValueError('Candidate checkout has uncommitted files')
        (evidence / 'acceptance.md').write_bytes(trusted)
        receipt = {'candidate': candidate, 'origin_dev': upstream,
                   'key_sha256': hashlib.sha256(trusted).hexdigest()}
        (evidence / 'key-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print('Answer key pinned. Browser verification has not run.')
    except Exception:
        (evidence / 'report.md').write_text('FAIL: answer-key admission failed. No UI pass.\n')
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'FAIL: {type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
