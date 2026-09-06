# 10c Habitat fallback receipt

Evidence-record: 10c
Date: 2026-09-05. Verification kind: runtime. Result: one toolchain test passed;
no registry decision tests or real coding-agent execution are claimed here.

## Authority and environment

The owner's subsequent Habitat authorization is recorded in
[the execution decision](../design.md#execution-decision-2026-09-05).
Habitat is the current bounded development environment. BrowserPod is unavailable;
its separate 10b proof remains inactive and unproved.

The existing `habitat/vivary-dev:2026-08-31` image was used without installation.
Image identity: `sha256:ffdba5d54dd6f91875fa60fc15103b6b30bb23ecaaf2d8ed65559d3cdff05bee`.
The probe reported Linux, Node v22.23.2, and a non-root process.

Inspected container configuration:

- `network=none`; no bind mounts or credential volumes.
- User `1000:1000`; root filesystem read-only; all capabilities dropped;
  `no-new-privileges` enabled.
- 384 MiB memory and memory-plus-swap cap, one CPU, 64 processes.
- `/tmp` provided the task workspace as a 128 MiB `nosuid,nodev` tmpfs.
  The probe refused a root-level write; it did not audit every virtual mount.

No app server or coding agent was started. The existing Habitat proxy service
auto-started with WSL; this offline container is not connected to its network.

## Probe and observed result

Two synthetic files were transferred over stdin into the container; no host
folder was mounted. The fixture is [the 03a oracle](../fixtures/project-registry.json).
Exact command inside the container:

```console
node --test /tmp/habitat-toolchain-proof.mjs
```

The probe used Node's built-in `node:test`, strict assertions, `node:fs`, and
`node:crypto`. It parsed the fixture and asserted `cases.length === 57`, verified
the standard SHA-256 digest of `abc`, wrote/read/deleted a disposable `/tmp`
file, observed `EROFS` or `EACCES` when attempting a root-level write, and
asserted a nonzero UID. Result: `tests 1`, `pass 1`, `fail 0`, approximately
97 ms total. Parsing 57 records does not establish their expected decisions.

## Failure and correction

The first transfer assumed a host path was mounted into Habitat; it was not.
The container also exited with code 255 while WSL stopped between bounded host
commands. Docker reported no OOM kill. A task-owned hidden WSL keepalive and
stdin-only transfer corrected those conditions. The passing probe used that
corrected arrangement; no file-association or global environment settings changed.

## Limits and next work

03b must still execute its evaluator, exact fixture assertions, contender/crash
schedules, and deliberate mutation failures. This probe establishes none of
those behaviors. It also does not prove durable state, process fencing,
BrowserPod, host-folder write-back, native CLI authentication, cancellation,
resume, or the HoH product acceptance cycle.

The task-owned container was retained through the [03b verification](03b-registry-contract-model.md),
then stopped and removed. Its identified hidden keepalive was stopped. Existing
authentication volumes and source repositories remain intact.

## Exact probe source

Save this as `/tmp/habitat-toolchain-proof.mjs` only inside the disposable container.

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';

test('Node, fixture reads, SHA-256, and disposable filesystem work', () => {
  const fixture = JSON.parse(readFileSync('/tmp/project-registry.json', 'utf8'));
  assert.equal(fixture.cases.length, 57);
  assert.equal(createHash('sha256').update('abc').digest('hex'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  writeFileSync('/tmp/toolchain-roundtrip.txt', 'disposable proof');
  assert.equal(readFileSync('/tmp/toolchain-roundtrip.txt', 'utf8'), 'disposable proof');
  unlinkSync('/tmp/toolchain-roundtrip.txt');
  assert.throws(() => writeFileSync('/toolchain-denied.txt', 'deny'),
    error => ['EROFS', 'EACCES'].includes(error.code));
  assert.notEqual(process.getuid(), 0);
  console.log(`toolchain=${process.version}; platform=${process.platform}; fixtures=57; nonroot=true`);
});
```
