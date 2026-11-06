import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fail, type ActionRunContext } from "@agent-native/core/action";

import { projectPreviewResult } from "../shared/project-preview.ts";
import { createProjectPreviewService, resolveLauncher } from "../server/project-preview.ts";

const owner = { userEmail: "owner@local.vivary.test", orgId: "local", caller: "frontend" } satisfies ActionRunContext;
const workspace = (root: string, projectId: string) => ({
  root, label: projectId, projectId, actorId: "actor", bindingId: "binding-" + projectId,
  bindingRevision: 1, policyRevision: 1, rootId: "root-" + projectId,
  locationRef: "location", verificationKind: "local-stat-revalidated-v1" as const,
});
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
async function fixture(root: string): Promise<void> {
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "vivary-preview-fixture", private: true,
    scripts: { dev: "node server.mjs" },
  }));
  await writeFile(path.join(root, "server.mjs"),
    "import { createServer } from 'node:http';\n" +
    "createServer((_req, res) => {\n" +
    "  res.setHeader('X-Frame-Options', 'DENY');\n" +
    "  res.end(process.env.VIVARY_TEST_SECRET ? 'leaked' : 'clean');\n" + // guard:allow-env-credential - Synthetic fixture sentinel used to prove child env stripping.
    "}).listen(Number(process.env.PORT), process.env.HOST);\n");
}

test("reviewed package preview runs under its project owner, reports readiness, and stops after rebind",
  { timeout: 25_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vivary-project-preview-"));
    const second = await mkdtemp(path.join(tmpdir(), "vivary-project-preview-second-"));
    const projects = new Map([["alpha", workspace(root, "alpha")], ["beta", workspace(second, "beta")]]);
    const service = createProjectPreviewService({
      mode: () => "local",
      resolveWorkspace: async (_context, projectId) => {
        const value = projects.get(projectId);
        if (!value) throw new Error("Project binding unavailable");
        return value;
      },
    });
    const prior = process.env.VIVARY_TEST_SECRET; // guard:allow-env-credential - Synthetic test sentinel, restored in cleanup.
    process.env.VIVARY_TEST_SECRET = "do-not-inherit"; // guard:allow-env-credential - Synthetic test sentinel to verify child isolation.
    try {
      await fixture(root);
      await fixture(second);
      const port = await freePort();
      const url = "http://127.0.0.1:" + port + "/";
      const discovered = projectPreviewResult.parse(await service.run(
        { operation: "discover", projectId: "alpha" }, owner));
      assert.equal(discovered.code, "discovered");
      if (discovered.code !== "discovered") return;
      assert.deepEqual(discovered.scripts, [{ script: "dev", scriptText: "node server.mjs" }]);
      const reviewed = projectPreviewResult.parse(await service.run(
        { operation: "review", projectId: "alpha", script: "dev", url }, owner));
      assert.equal(reviewed.code, "review");
      if (reviewed.code !== "review") return;
      assert.match(reviewed.command, /run dev/);
      const requestId = "d4390ca5-803b-4a0e-9dc4-14cd38724376";
      const input = { operation: "start" as const, projectId: "alpha", script: "dev" as const,
        url, requestId, acceptedManifestDigest: reviewed.manifestDigest, reviewExpiresAt: reviewed.reviewExpiresAt };
      const started = projectPreviewResult.parse(await service.run(input, owner));
      assert.equal(started.code, "ready");
      if (started.code !== "ready") return;
      assert.ok(started.pid && started.pid > 0);
      assert.equal(started.embedding, "blocked");
      assert.equal((await fetch(url)).status, 200);
      assert.equal(await (await fetch(url)).text(), "clean");
      assert.equal(projectPreviewResult.parse(await service.run(input, owner)).code, "ready");
      await assert.rejects(service.run({
        ...input, acceptedManifestDigest: "sha256:" + "a".repeat(64),
      }, owner), /different reviewed preview/);
      const inspected = projectPreviewResult.parse(await service.run(
        { operation: "inspect", projectId: "alpha", url }, owner));
      assert.equal(inspected.code, "checked");
      if (inspected.code === "checked") {
        assert.equal(inspected.reachable, true);
        assert.equal(inspected.embedding, "blocked");
      }
      const occupiedReview = projectPreviewResult.parse(await service.run(
        { operation: "review", projectId: "beta", script: "dev", url }, owner));
      assert.equal(occupiedReview.code, "review");
      if (occupiedReview.code !== "review") return;
      await assert.rejects(service.run({
        operation: "start", projectId: "beta", script: "dev", url,
        requestId: "30eaa9d9-d111-436d-9c03-574df167d589",
        acceptedManifestDigest: occupiedReview.manifestDigest, reviewExpiresAt: occupiedReview.reviewExpiresAt,
      }, owner), /already in use/);
      const betaUrl = "http://127.0.0.1:" + await freePort() + "/";
      const betaReview = projectPreviewResult.parse(await service.run(
        { operation: "review", projectId: "beta", script: "dev", url: betaUrl }, owner));
      assert.equal(betaReview.code, "review");
      if (betaReview.code !== "review") return;
      const beta = projectPreviewResult.parse(await service.run({
        operation: "start", projectId: "beta", script: "dev", url: betaUrl,
        requestId: "6db87a2f-8dd1-40db-86cd-82837e7c41e2",
        acceptedManifestDigest: betaReview.manifestDigest, reviewExpiresAt: betaReview.reviewExpiresAt,
      }, owner));
      assert.equal(beta.code, "ready");
      assert.equal(await (await fetch(betaUrl)).text(), "clean");
      await assert.rejects(service.run(
        { operation: "stop", projectId: "alpha", launchId: started.launchId },
        { ...owner, userEmail: "other@local.vivary.test" }), /not owned/);
      projects.delete("alpha");
      const stale = projectPreviewResult.parse(await service.run(
        { operation: "status", projectId: "alpha" }, owner));
      assert.equal(stale.code, "ready");
      if (stale.code === "ready") assert.equal(stale.staleBinding, true);
      const stopped = projectPreviewResult.parse(await service.run(
        { operation: "stop", projectId: "alpha", launchId: started.launchId }, owner));
      assert.equal(stopped.code, "stopped");
      if (stopped.code === "stopped") assert.equal(stopped.staleBinding, true);
      assert.equal(projectPreviewResult.parse(await service.run(
        { operation: "stop", projectId: "alpha", launchId: started.launchId }, owner)).code, "stopped");
      await assert.rejects(fetch(url));
      assert.equal(await (await fetch(betaUrl)).text(), "clean");
      projects.set("alpha", workspace(root, "alpha"));
      const replacement = projectPreviewResult.parse(await service.run({
        ...input, requestId: "4942581d-5504-4fca-a1b5-6e9e19276d16",
      }, owner));
      assert.equal(replacement.code, "ready");
      if (replacement.code === "ready") {
        assert.notEqual(replacement.launchId, started.launchId);
        assert.equal(projectPreviewResult.parse(await service.run(
          { operation: "stop", projectId: "alpha", launchId: started.launchId }, owner)).code, "stopped");
        assert.equal(await (await fetch(url)).text(), "clean");
        await service.run({ operation: "stop", projectId: "alpha", launchId: replacement.launchId }, owner);
      }
      await service.shutdown();
      await assert.rejects(fetch(betaUrl));
    } finally {
      await service.shutdown();
      if (prior === undefined) delete process.env.VIVARY_TEST_SECRET; // guard:allow-env-credential - Restore synthetic test sentinel.
      else process.env.VIVARY_TEST_SECRET = prior; // guard:allow-env-credential - Restore synthetic test sentinel.
      await rm(root, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });

test("shutdown blocks an in-flight reviewed start before it spawns",
  { timeout: 12_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vivary-preview-shutdown-"));
    await fixture(root);
    const project = workspace(root, "shutdown");
    let hold = false;
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const service = createProjectPreviewService({
      mode: () => "local",
      resolveWorkspace: async () => {
        if (hold) { entered?.(); await gate; }
        return project;
      },
    });
    try {
      const url = "http://127.0.0.1:" + await freePort() + "/";
      const reviewed = projectPreviewResult.parse(await service.run(
        { operation: "review", projectId: "shutdown", script: "dev", url }, owner));
      assert.equal(reviewed.code, "review");
      if (reviewed.code !== "review") return;
      hold = true;
      const starting = service.run({
        operation: "start", projectId: "shutdown", script: "dev", url,
        requestId: "4afba4c8-8052-41ee-b190-e5c9b3370f7d",
        acceptedManifestDigest: reviewed.manifestDigest, reviewExpiresAt: reviewed.reviewExpiresAt,
      }, owner);
      await waiting;
      await service.shutdown();
      release?.();
      await assert.rejects(starting, /shutting down/);
      await assert.rejects(fetch(url));
      assert.equal((await service.run({ operation: "status", projectId: "shutdown" }, owner)).code, "idle");
    } finally {
      release?.();
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

test("the complete package manifest is checked after the port probe",
  { timeout: 12_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vivary-preview-manifest-"));
    await fixture(root);
    const project = workspace(root, "manifest");
    let alterOnPortCheck = false;
    const service = createProjectPreviewService({
      mode: () => "local",
      resolveWorkspace: async () => project,
      portOccupied: async () => {
        if (alterOnPortCheck) await writeFile(path.join(root, "package.json"), JSON.stringify({
          name: "changed-after-review", private: true, scripts: { dev: "node server.mjs" },
        }));
        return false;
      },
    });
    try {
      const url = "http://127.0.0.1:" + await freePort() + "/";
      const reviewed = projectPreviewResult.parse(await service.run(
        { operation: "review", projectId: "manifest", script: "dev", url }, owner));
      assert.equal(reviewed.code, "review");
      if (reviewed.code !== "review") return;
      alterOnPortCheck = true;
      await assert.rejects(service.run({
        operation: "start", projectId: "manifest", script: "dev", url,
        requestId: "7b739814-1369-4736-8843-54f54e576482",
        acceptedManifestDigest: reviewed.manifestDigest, reviewExpiresAt: reviewed.reviewExpiresAt,
      }, owner), /package contents or launcher changed/);
      assert.equal((await service.run({ operation: "status", projectId: "manifest" }, owner)).code, "idle");
      await assert.rejects(fetch(url));
      alterOnPortCheck = false;
      const fresh = await service.run({ operation: "review", projectId: "manifest", script: "dev", url }, owner);
      assert.equal(fresh.code, "review");
      if (fresh.code === "review") {
        const started = await service.run({ operation: "start", projectId: "manifest", script: "dev", url,
          requestId: "e2c84727-5c39-43cb-bd77-25b6b36d6963",
          acceptedManifestDigest: fresh.manifestDigest, reviewExpiresAt: fresh.reviewExpiresAt }, owner);
        assert.equal(started.code, "ready", "the refused start releases its port reservation");
        if ("launchId" in started) await service.run(
          { operation: "stop", projectId: "manifest", launchId: started.launchId }, owner);
      }
    } finally {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

test("status rechecks a live preview URL and recovers when it responds again",
  { timeout: 12_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vivary-preview-status-"));
    await fixture(root);
    const project = workspace(root, "status");
    let reachable = true;
    let heldProbe: Promise<void> | undefined;
    let enteredProbe = () => {};
    let releaseProbe = () => {};
    const service = createProjectPreviewService({
      mode: () => "local",
      resolveWorkspace: async () => project,
      probe: async () => {
        if (heldProbe) { enteredProbe(); await heldProbe; }
        return reachable
          ? { reachable: true, embedding: "unknown" }
          : { reachable: false, embedding: "unknown", reason: "The fixture stopped responding." };
      },
    });
    try {
      const url = "http://127.0.0.1:" + await freePort() + "/";
      const reviewed = projectPreviewResult.parse(await service.run(
        { operation: "review", projectId: "status", script: "dev", url }, owner));
      assert.equal(reviewed.code, "review");
      if (reviewed.code !== "review") return;
      const started = projectPreviewResult.parse(await service.run({
        operation: "start", projectId: "status", script: "dev", url,
        requestId: "c4548bcb-759b-4785-9aac-b11472ad4f84",
        acceptedManifestDigest: reviewed.manifestDigest, reviewExpiresAt: reviewed.reviewExpiresAt,
      }, owner));
      assert.equal(started.code, "ready");
      reachable = false;
      const unavailable = projectPreviewResult.parse(await service.run(
        { operation: "status", projectId: "status" }, owner));
      assert.equal(unavailable.code, "unavailable");
      if (unavailable.code === "unavailable") assert.match(unavailable.reason, /stopped responding/);
      reachable = true;
      assert.equal((await service.run({ operation: "status", projectId: "status" }, owner)).code, "ready");
      if (started.code !== "ready") return;
      const entered = new Promise<void>(resolve => { enteredProbe = resolve; });
      heldProbe = new Promise<void>(resolve => { releaseProbe = resolve; });
      const checking = service.run({ operation: "status", projectId: "status" }, owner);
      await entered;
      await service.run({ operation: "stop", projectId: "status", launchId: started.launchId }, owner);
      releaseProbe();
      assert.equal((await checking).code, "stopped", "a delayed status probe cannot revive a stopped command");
    } finally {
      releaseProbe();
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });


test("a launcher exit cleans its background server before a later Stop",
  { timeout: 15_000, skip: process.platform === "win32" }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vivary-preview-launcher-exit-"));
    const project = workspace(root, "exiting");
    const service = createProjectPreviewService({
      mode: () => "local", resolveWorkspace: async () => project,
    });
    let launchPid: number | null = null;
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({
        name: "vivary-preview-exit-fixture", private: true, scripts: { dev: "node manager.mjs" },
      }));
      await writeFile(path.join(root, "server.mjs"),
        "import { createServer } from 'node:http';\n" +
        "createServer((_req, res) => res.end('owned')).listen(Number(process.env.PORT), process.env.HOST, () => process.send('ready'));\n");
      await writeFile(path.join(root, "manager.mjs"),
        "import { fork } from 'node:child_process';\n" +
        "import { writeFileSync } from 'node:fs';\n" +
        "const child = fork('./server.mjs', [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });\n" +
        "child.once('message', () => { writeFileSync('server-was-ready', 'yes'); setTimeout(() => process.exit(0), 200); });\n");
      const url = "http://127.0.0.1:" + await freePort() + "/";
      const review = await service.run({ operation: "review", projectId: project.projectId, script: "dev", url }, owner);
      assert.equal(review.code, "review");
      if (review.code !== "review") return;
      const started = await service.run({ operation: "start", projectId: project.projectId, script: "dev", url,
        requestId: "e8755927-609f-4d85-8ea1-e7c3e9ba3125", acceptedManifestDigest: review.manifestDigest, reviewExpiresAt: review.reviewExpiresAt }, owner);
      assert.ok("launchId" in started);
      if (!("launchId" in started)) return;
      launchPid = started.pid;
      assert.equal(await readFile(path.join(root, "server-was-ready"), "utf8"), "yes");
      let status = await service.run({ operation: "status", projectId: project.projectId }, owner);
      for (let n = 0; n < 30 && status.code !== "unavailable"; n++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        status = await service.run({ operation: "status", projectId: project.projectId }, owner);
      }
      assert.equal(status.code, "unavailable");
      await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
      const stopped = await service.run({ operation: "stop", projectId: project.projectId, launchId: started.launchId }, owner);
      assert.equal(stopped.code, "stopped");
      await service.shutdown();
      launchPid = null;
    } finally {
      try { await service.shutdown(); }
      finally {
        // The regression fixture owns this process group even when cleanup under test fails.
        if (launchPid) { try { process.kill(-launchPid, "SIGKILL"); } catch { /* Already gone. */ } }
        await rm(root, { recursive: true, force: true });
      }
    }
  });


test("concurrent projects cannot claim the same host preview port while launch checks are pending",
  { timeout: 12_000 }, async () => {
    const alphaRoot = await mkdtemp(path.join(tmpdir(), "vivary-preview-reserve-alpha-"));
    const betaRoot = await mkdtemp(path.join(tmpdir(), "vivary-preview-reserve-beta-"));
    await fixture(alphaRoot);
    await fixture(betaRoot);
    let unblock = () => {};
    let entered = () => {};
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const checking = new Promise<void>(resolve => { entered = resolve; });
    let held = true;
    const service = createProjectPreviewService({
      mode: () => "local",
      resolveWorkspace: async (_context, projectId) => workspace(projectId === "alpha" ? alphaRoot : betaRoot, projectId),
      portOccupied: async () => {
        if (held) { held = false; entered(); await gate; }
        return false;
      },
    });
    try {
      const url = "http://127.0.0.1:" + await freePort() + "/";
      const alphaReview = await service.run({ operation: "review", projectId: "alpha", script: "dev", url }, owner);
      const betaReview = await service.run({ operation: "review", projectId: "beta", script: "dev", url }, owner);
      assert.equal(alphaReview.code, "review");
      assert.equal(betaReview.code, "review");
      if (alphaReview.code !== "review" || betaReview.code !== "review") return;
      const starting = service.run({ operation: "start", projectId: "alpha", script: "dev", url,
        requestId: "32dd8f0b-a253-4460-9d2a-18472edf81c5",
        acceptedManifestDigest: alphaReview.manifestDigest,
        reviewExpiresAt: alphaReview.reviewExpiresAt }, owner);
      await checking;
      await assert.rejects(service.run({ operation: "start", projectId: "alpha", script: "dev", url,
        requestId: "32dd8f0b-a253-4460-9d2a-18472edf81c5",
        acceptedManifestDigest: alphaReview.manifestDigest,
        reviewExpiresAt: alphaReview.reviewExpiresAt - 1 }, owner), /different preview request/);
      await assert.rejects(service.run({ operation: "start", projectId: "beta", script: "dev", url,
        requestId: "0ef8118a-59a4-413b-bbb6-959754c9ded3",
        acceptedManifestDigest: betaReview.manifestDigest,
        reviewExpiresAt: betaReview.reviewExpiresAt }, owner), /already in use or reserved/);
      assert.equal((await service.run({ operation: "status", projectId: "beta" }, owner)).code, "idle");
      unblock();
      const started = await starting;
      assert.equal(started.code, "ready");
      if (started.code === "ready") {
        assert.equal(started.processRunning, true);
        assert.equal(await (await fetch(url)).text(), "clean");
      }
    } finally {
      unblock();
      await service.shutdown();
      await rm(alphaRoot, { recursive: true, force: true });
      await rm(betaRoot, { recursive: true, force: true });
    }
  });


test("settled request history stays bounded without relaunching an expired request ID",
  { timeout: 12_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vivary-preview-expiry-"));
    await fixture(root);
    let clock = Date.now();
    const service = createProjectPreviewService({
      mode: () => "local", now: () => clock, maxRetainedRequests: 1,
      resolveWorkspace: async () => workspace(root, "expiry"),
    });
    try {
      const url = "http://127.0.0.1:" + await freePort() + "/";
      const review = await service.run({ operation: "review", projectId: "expiry", script: "dev", url }, owner);
      assert.equal(review.code, "review");
      if (review.code !== "review") return;
      const oldInput = { operation: "start" as const, projectId: "expiry", script: "dev" as const,
        url, requestId: "ec8fac49-0a9d-4243-a8d7-df5b77af70fe",
        acceptedManifestDigest: review.manifestDigest, reviewExpiresAt: review.reviewExpiresAt };
      const first = await service.run(oldInput, owner);
      assert.equal(first.code, "ready");
      if (!("launchId" in first)) return;
      const stopped = await service.run({ operation: "stop", projectId: "expiry", launchId: first.launchId }, owner);
      assert.equal(stopped.code, "stopped");
      if (stopped.code === "stopped") assert.equal(stopped.processRunning, false);
      assert.equal((await service.run(oldInput, owner)).code, "stopped");
      await assert.rejects(service.run({ ...oldInput,
        requestId: "339d77e7-6c94-42c6-8e4e-17a963177977" }, owner), /Too many preview requests/);
      clock = review.reviewExpiresAt + 1;
      await assert.rejects(service.run(oldInput, owner), /review expired/);
      assert.equal((await service.run({ operation: "status", projectId: "expiry" }, owner)).code, "idle");
      const renewed = await service.run({ operation: "review", projectId: "expiry", script: "dev", url }, owner);
      assert.equal(renewed.code, "review");
      if (renewed.code !== "review") return;
      const replacement = await service.run({ ...oldInput,
        acceptedManifestDigest: renewed.manifestDigest, reviewExpiresAt: renewed.reviewExpiresAt }, owner);
      assert.equal(replacement.code, "ready");
      if (replacement.code === "ready") {
        assert.notEqual(replacement.launchId, first.launchId);
        await assert.rejects(service.run(oldInput, owner), /different reviewed preview/);
        await service.run({ operation: "stop", projectId: "expiry", launchId: replacement.launchId }, owner);
      }
    } finally {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });


test("native pnpm binaries resolve while a text shim is rejected",
  { timeout: 5_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vivary-preview-pnpm-project-"));
    const bin = await mkdtemp(path.join(tmpdir(), "vivary-preview-pnpm-bin-"));
    const file = path.join(bin, process.platform === "win32" ? "pnpm.exe" : "pnpm");
    try {
      const signature = process.platform === "win32"
        ? Buffer.from([0x4d, 0x5a, 0x00, 0x00])
        : Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
      await writeFile(file, signature);
      if (process.platform !== "win32") await chmod(file, 0o755);
      const launcher = await resolveLauncher("pnpm", root, [bin]);
      assert.deepEqual(launcher, { manager: "pnpm", executable: file, prefix: [] });
      await writeFile(file, "#!/bin/sh\necho unsafe\n");
      assert.equal(await resolveLauncher("pnpm", root, [bin]), null);
      await writeFile(path.join(bin, "pnpm.cmd"), "echo unsafe\n");
      assert.equal(await resolveLauncher("pnpm", root, [bin]), null);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
    }
  });


test("a revoked project refuses start with 403 before spawn",
  { timeout: 5_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vivary-preview-revoked-"));
    await fixture(root);
    let denied = false;
    let spawnCount = 0;
    const service = createProjectPreviewService({
      mode: () => "local",
      resolveWorkspace: async () => denied
        ? fail("Project access revoked.", { statusCode: 403, errorCode: "vivary_project_access" })
        : workspace(root, "revoked"),
      spawn: () => { spawnCount++; throw new Error("Spawn must not run"); },
    });
    try {
      const url = "http://127.0.0.1:" + await freePort() + "/";
      const review = await service.run({ operation: "review", projectId: "revoked", script: "dev", url }, owner);
      assert.equal(review.code, "review");
      if (review.code !== "review") return;
      denied = true;
      await assert.rejects(service.run({ operation: "start", projectId: "revoked", script: "dev", url,
        requestId: "13fdf62f-6623-4699-92f3-5c95f19ad1ef",
        acceptedManifestDigest: review.manifestDigest, reviewExpiresAt: review.reviewExpiresAt }, owner),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Project access revoked/);
        assert.equal("statusCode" in error && error.statusCode, 403);
        return true;
      });
      assert.equal(spawnCount, 0);
    } finally {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });


test("a new host generation refuses an old reviewed digest before spawn",
  { timeout: 5_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vivary-preview-generation-"));
    await fixture(root);
    let spawnCount = 0;
    const dependencies = { mode: () => "local",
      resolveWorkspace: async () => workspace(root, "generation") };
    const oldHost = createProjectPreviewService(dependencies);
    const newHost = createProjectPreviewService({ ...dependencies,
      spawn: () => { spawnCount++; throw new Error("Spawn must not run"); } });
    try {
      const url = "http://127.0.0.1:" + await freePort() + "/";
      const review = await oldHost.run({ operation: "review", projectId: "generation", script: "dev", url }, owner);
      assert.equal(review.code, "review");
      if (review.code !== "review") return;
      const renewed = await newHost.run({ operation: "review", projectId: "generation", script: "dev", url }, owner);
      assert.equal(renewed.code, "review");
      if (renewed.code === "review") assert.notEqual(renewed.manifestDigest, review.manifestDigest);
      await assert.rejects(newHost.run({ operation: "start", projectId: "generation", script: "dev", url,
        requestId: "722d7dd4-178f-4eca-8960-c1ea89ddd9d2",
        acceptedManifestDigest: review.manifestDigest, reviewExpiresAt: review.reviewExpiresAt }, owner),
      /script, launcher, address, or folder changed/);
      assert.equal(spawnCount, 0);
    } finally {
      await oldHost.shutdown();
      await newHost.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

test("an active launch replays its original request after review expiry without spawning again",
  { timeout: 12_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vivary-preview-live-replay-"));
    await fixture(root);
    let clock = Date.now();
    const service = createProjectPreviewService({ mode: () => "local", now: () => clock,
      resolveWorkspace: async () => workspace(root, "replay") });
    try {
      const url = "http://127.0.0.1:" + await freePort() + "/";
      const review = await service.run({ operation: "review", projectId: "replay", script: "dev", url }, owner);
      assert.equal(review.code, "review");
      if (review.code !== "review") return;
      const input = { operation: "start" as const, projectId: "replay", script: "dev" as const,
        url, requestId: "68af7dc9-a454-4818-aefe-d90618dcf1e1",
        acceptedManifestDigest: review.manifestDigest, reviewExpiresAt: review.reviewExpiresAt };
      const first = await service.run(input, owner);
      assert.equal(first.code, "ready");
      if (!("launchId" in first)) return;
      clock = review.reviewExpiresAt + 1;
      const replay = await service.run(input, owner);
      assert.equal(replay.code, "ready");
      if (replay.code === "ready") assert.equal(replay.launchId, first.launchId);
      await service.run({ operation: "stop", projectId: "replay", launchId: first.launchId }, owner);
      await assert.rejects(service.run(input, owner), /review expired/);
    } finally {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });


test("a legacy bun.lockb selects Bun when packageManager is absent",
  { timeout: 5_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vivary-preview-bun-lockb-"));
    await fixture(root);
    await writeFile(path.join(root, "bun.lockb"), "legacy fixture");
    const service = createProjectPreviewService({
      mode: () => "local",
      resolveWorkspace: async () => workspace(root, "legacy-bun"),
      resolveLauncher: async manager => ({ manager, executable: process.execPath, prefix: [] }),
    });
    try {
      const url = "http://127.0.0.1:" + await freePort() + "/";
      const review = await service.run({ operation: "review", projectId: "legacy-bun", script: "dev", url }, owner);
      assert.equal(review.code, "review");
      if (review.code === "review") assert.equal(review.command, "bun run dev");
    } finally {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });


test("legacy bun.lockb starts and stops with an installed Bun launcher",
  { timeout: 15_000 }, async context => {
    const root = await mkdtemp(path.join(tmpdir(), "vivary-preview-bun-runtime-"));
    await fixture(root);
    await writeFile(path.join(root, "bun.lockb"), Buffer.alloc(0));
    const launcher = await resolveLauncher("bun", root);
    if (!launcher) {
      context.skip("No supported Bun launcher is installed on this host");
      await rm(root, { recursive: true, force: true });
      return;
    }
    const service = createProjectPreviewService({
      mode: () => "local", resolveWorkspace: async () => workspace(root, "legacy-bun-runtime"),
    });
    try {
      const url = "http://127.0.0.1:" + await freePort() + "/";
      const review = await service.run({ operation: "review", projectId: "legacy-bun-runtime", script: "dev", url }, owner);
      assert.equal(review.code, "review");
      if (review.code !== "review") return;
      assert.equal(review.command, "bun run dev");
      const started = await service.run({ operation: "start", projectId: "legacy-bun-runtime", script: "dev", url,
        requestId: "f4ced5d2-3ad4-4078-a536-ce0be8f6e1c1",
        acceptedManifestDigest: review.manifestDigest, reviewExpiresAt: review.reviewExpiresAt }, owner);
      assert.equal(started.code, "ready");
      if (started.code !== "ready") return;
      assert.equal(await (await fetch(url)).text(), "clean");
      assert.equal((await service.run({ operation: "stop", projectId: "legacy-bun-runtime",
        launchId: started.launchId }, owner)).code, "stopped");
      await assert.rejects(fetch(url));
    } finally {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });


for (const failure of ["non-launch", "launched failure"] as const) {
  test("a Windows preview " + failure + (failure === "non-launch"
    ? " releases its reservation" : " retains unverified cleanup"), { timeout: 15_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vivary-preview-spawn-failure-"));
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(platform);
    const previousBundle = process.env.VIVARY_ORIGINAL_RUNTIME; // guard:allow-env-credential - Restore fixture runtime selection.
    delete process.env.VIVARY_ORIGINAL_RUNTIME; // guard:allow-env-credential - Exercise source owner selection in this fixture.
    const children: ChildProcess[] = [];
    let recovered = false;
    const service = createProjectPreviewService({
      mode: () => "local", resolveWorkspace: async (_context, projectId) => workspace(root, projectId),
      resolveLauncher: async manager => ({ manager, executable: process.execPath, prefix: [] }),
      spawn: new Proxy(spawn, {
        apply(_target, _receiver, [_command, _arguments, options]) {
          // Select the Windows service path, then use the real host spawn API and events.
          Object.defineProperty(process, "platform", platform);
          const child = !recovered && failure === "non-launch"
            ? spawn(path.join(root, "missing-preview-interpreter"), [], options)
            : !recovered
              ? spawn(process.execPath, ["-e", "process.exit(7)"], options)
              : spawn(process.execPath, [path.join(root, "owner.mjs")], options);
          children.push(child);
          return child;
        },
      }),
    });
    try {
      await fixture(root);
      await writeFile(path.join(root, "owner.mjs"),
        "import { createServer } from 'node:http';\n" +
        "const server = createServer((_req, res) => res.end('owned')).listen(Number(process.env.PORT), '127.0.0.1');\n" +
        "process.stdin.resume(); process.stdin.once('end', () => server.close(() => process.exit(0)));\n");
      const url = "http://127.0.0.1:" + await freePort() + "/";
      const review = await service.run({ operation: "review", projectId: "spawn-failure", script: "dev", url }, owner);
      assert.equal(review.code, "review");
      if (review.code !== "review") return;
      const input = { operation: "start" as const, projectId: "spawn-failure", script: "dev" as const, url,
        requestId: randomUUID(), acceptedManifestDigest: review.manifestDigest, reviewExpiresAt: review.reviewExpiresAt };
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      const failed = await service.run(input, owner);
      assert.equal(failed.code, "unavailable");
      if (failed.code !== "unavailable") return;
      assert.equal(failed.processRunning, false);
      recovered = true;
      if (failure === "non-launch") {
        assert.equal(failed.pid, null);
        assert.equal(children[0].pid, undefined, "real ENOENT emitted an error without a PID");
        Object.defineProperty(process, "platform", { ...platform, value: "win32" });
        const retried = await service.run({ ...input, requestId: randomUUID() }, owner);
        assert.equal(retried.code, "ready", "retry owns the same port without an intervening Stop");
        if (retried.code !== "ready") return;
        const stoppedFailure = await service.run({ operation: "stop", projectId: input.projectId, launchId: failed.launchId }, owner);
        assert.equal(stoppedFailure.code, "stopped");
        assert.equal(await (await fetch(url)).text(), "owned", "stopping the non-launch cannot stop its replacement");
        assert.equal((await service.run({ operation: "stop", projectId: input.projectId, launchId: retried.launchId }, owner)).code, "stopped");
        await service.shutdown();
      } else {
        assert.ok(failed.pid && failed.pid > 0, "the failed owner really launched");
        await assert.rejects(service.run({ operation: "stop", projectId: input.projectId, launchId: failed.launchId }, owner), /could not be stopped/);
        await assert.rejects(service.run({ ...input, requestId: randomUUID() }, owner), /existing owned preview/);
        const other = await service.run({ operation: "review", projectId: "other-project", script: "dev", url }, owner);
        assert.equal(other.code, "review");
        if (other.code === "review") await assert.rejects(service.run({ ...input, projectId: "other-project", requestId: randomUUID(),
          acceptedManifestDigest: other.manifestDigest, reviewExpiresAt: other.reviewExpiresAt }, owner), /already in use or reserved/);
        await assert.rejects(service.shutdown(), /could not be stopped/);
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
      if (previousBundle === undefined) delete process.env.VIVARY_ORIGINAL_RUNTIME; // guard:allow-env-credential - Restore fixture runtime selection.
      else process.env.VIVARY_ORIGINAL_RUNTIME = previousBundle; // guard:allow-env-credential - Restore fixture runtime selection.
      await service.shutdown().catch(() => {});
      for (const child of children) {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
