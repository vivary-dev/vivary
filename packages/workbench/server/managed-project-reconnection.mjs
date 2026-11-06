/** Owner-confirmed replacement of one recorded local folder identity. */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createDbExec, getRuntimeDatabaseUrl } from "@agent-native/core/db";
import { getSettingsEmitter } from "@agent-native/core/settings";
import { isActiveCodeAgentRun, listCodeAgentRunRecords } from "@agent-native/core/code-agents";
import { z } from "zod";
import {
  localRootActorId, localRootIdentity, localRootInventoryKey, parseLocalRootInventory,
} from "./local-root-provider.mjs";
import { getLocalProjectReconnectionService } from "./project-services.mjs";
import { claimProjectReconnection } from "./project-reconnection-admission.mjs";
import { managedProjectDataDirectory } from "./managed-projects.mjs";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const LOCAL = "local-stat-revalidated-v1";
const OPERATION = "reconnect-managed-folder";

function refuse(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}
function hash(value) {
  return "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function nextRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw refuse("The project revision cannot advance. Contact the workspace owner.");
  }
  return value + 1;
}
function physical(value) {
  return { platform: value.platform, dev: value.dev, ino: value.ino, birthtimeNs: value.birthtimeNs };
}
function receiptKey(scope, operationId) {
  return [scope.actorId, scope.collectionId, scope.deviceId, OPERATION, operationId].join(":");
}
function requestDigest(input) {
  return hash({ projectId: input.projectId, operationId: input.operationId,
    acceptedPlanSha256: input.acceptedPlanSha256 });
}
function replacementRootId(scope, operationId) {
  return "root_" + createHash("sha256").update(
    [scope.actorId, scope.collectionId, scope.deviceId, operationId].join("\0"),
  ).digest("hex").slice(0, 32);
}
async function localExec() {
  const url = getRuntimeDatabaseUrl();
  if (!url.startsWith("file:")) {
    throw refuse("Project reconnection requires the local Vivary database.", 503);
  }
  return createDbExec({ url });
}
async function one(tx, sql, args) {
  const { rows } = await tx.execute({ sql, args });
  return rows;
}

/** Every authority and scope row is read through the transaction's private connection. */
async function loadSnapshot(tx, owner, projectId) {
  const email = owner.owner.userEmail.trim().toLowerCase();
  const actorId = localRootActorId(email, owner.owner.orgId);
  const [member] = await one(tx, `SELECT m.role AS ownerRole, r.role AS appRole
    FROM org_members m LEFT JOIN app_member_roles r
      ON r.org_id = m.org_id AND r.app_id = 'workbench'
      AND LOWER(r.email) = LOWER(m.email)
    WHERE m.org_id = ? AND LOWER(m.email) = ? LIMIT 1`, [owner.owner.orgId, email]);
  if (member?.ownerRole !== "owner"
    || !["project-registrar", "project-mutator"].includes(member?.appRole)) {
    throw refuse("Only the authorized workspace owner can reconnect this project.", 403);
  }
  const [device] = await one(tx, "SELECT value FROM settings WHERE key = ?", ["vivary-local-device-v1"]);
  let savedDevice;
  try { savedDevice = JSON.parse(device?.value ?? "null"); }
  catch { throw refuse("The local device identity is invalid.", 403); }
  if (savedDevice?.deviceId !== owner.service.provider.deviceId) {
    throw refuse("The local device identity changed. Restart Vivary before reconnecting.", 403);
  }
  const settingKey = localRootInventoryKey(email, owner.owner.orgId);
  const [setting] = await one(tx, "SELECT value, updated_at AS updatedAt FROM settings WHERE key = ?", [settingKey]);
  let inventory;
  try { inventory = parseLocalRootInventory(JSON.parse(setting?.value ?? "null")); }
  catch { throw refuse("The saved project folder grant is unavailable.", 403); }
  const scope = { actorId, collectionId: inventory.collectionId,
    deviceId: savedDevice.deviceId, policyRevision: inventory.policyRevision };
  const rows = await one(tx, `SELECT b.binding_id AS bindingId, b.project_id AS projectId,
      b.root_id AS rootId, b.location_ref AS locationRef,
      b.binding_revision AS bindingRevision, b.policy_revision AS bindingPolicyRevision,
      b.verification_kind AS verificationKind, p.display_name AS displayName
    FROM vivary_registry_bindings b
    JOIN vivary_registry_projects p ON p.project_id = b.project_id
    WHERE b.project_id = ? AND b.actor_id = ? AND b.collection_id = ?
      AND b.device_id = ? LIMIT 2`,
    [projectId, actorId, inventory.collectionId, savedDevice.deviceId]);
  if (rows.length !== 1 || rows[0].verificationKind !== LOCAL) {
    throw refuse("This project has no single recorded local folder.", 404);
  }
  const binding = rows[0];
  const grant = inventory.grants.find(item => item.locationRef === binding.locationRef);
  if (!grant || grant.rootId !== binding.rootId) {
    throw refuse("The recorded project folder grant and binding disagree. Review the project access.", 409);
  }
  const [revision] = await one(tx, `SELECT revision, collection_id AS collectionId,
      device_id AS deviceId FROM vivary_registry_revisions WHERE scope_key = ?`,
    [inventory.collectionId + ":" + savedDevice.deviceId]);
  if (!revision || revision.collectionId !== inventory.collectionId
    || revision.deviceId !== savedDevice.deviceId) {
    throw refuse("The project registry revision is unavailable.", 409);
  }
  return { ownerEmail: email, orgId: owner.owner.orgId, settingKey, settingRaw: setting.value,
    settingUpdatedAt: Number(setting.updatedAt), inventory, scope, binding, grant,
    registryRevision: Number(revision.revision) };
}

async function reconnectFolder(grant, dataDir, provider) {
  if (!path.isAbsolute(grant.canonicalPath)) {
    throw refuse("The saved project folder path is invalid.", 409);
  }
  const parent = path.dirname(grant.canonicalPath);
  const name = path.basename(grant.canonicalPath) || path.parse(grant.canonicalPath).root;
  const canonicalData = dataDir && path.isAbsolute(dataDir) ? await realpath(dataDir) : null;
  const managed = canonicalData !== null && parent === path.join(canonicalData, "projects")
    && await provider.isManagedLocation(grant.locationRef, dataDir);
  let parentInfo;
  let targetInfo;
  try {
    parentInfo = await lstat(parent, { bigint: true });
    targetInfo = await lstat(grant.canonicalPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw refuse("The saved project folder is missing. Restore it at the recorded path, then review again.", 409);
    }
    throw refuse("The saved project folder cannot be checked. Restore access, then review again.", 409);
  }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()
    || !targetInfo.isDirectory() || targetInfo.isSymbolicLink()
    || await realpath(parent) !== parent
    || await realpath(grant.canonicalPath) !== grant.canonicalPath) {
    throw refuse("The saved project path is linked or changed. Restore the recorded folder, then review again.", 409);
  }
  return { folderName: name, folderPath: grant.canonicalPath,
    folderKind: managed ? "managed" : "external", parent, target: grant.canonicalPath,
    parentIdentity: { dev: String(parentInfo.dev), ino: String(parentInfo.ino),
      birthtimeNs: String(parentInfo.birthtimeNs) } };
}

function plan(snapshot, managed, observed, operationId) {
  const rootId = replacementRootId(snapshot.scope, operationId);
  const planSha256 = hash({
    version: 1, operation: OPERATION, operationId,
    ownerEmail: snapshot.ownerEmail, orgId: snapshot.orgId,
    actorId: snapshot.scope.actorId, collectionId: snapshot.scope.collectionId,
    deviceId: snapshot.scope.deviceId, projectId: snapshot.binding.projectId,
    bindingId: snapshot.binding.bindingId, locationRef: snapshot.binding.locationRef,
    oldRootId: snapshot.binding.rootId, oldIdentity: physical(snapshot.grant),
    newRootId: rootId, newIdentity: physical(observed),
    canonicalPath: snapshot.grant.canonicalPath,
    managedParent: managed.parent, managedParentIdentity: managed.parentIdentity,
    folderKind: managed.folderKind,
    settingRaw: snapshot.settingRaw, settingUpdatedAt: snapshot.settingUpdatedAt,
    policyRevision: snapshot.scope.policyRevision,
    bindingRevision: snapshot.binding.bindingRevision,
    bindingPolicyRevision: snapshot.binding.bindingPolicyRevision,
    registryRevision: snapshot.registryRevision,
  });
  return { rootId, planSha256 };
}
function assertReplacement(snapshot, observed) {
  if (snapshot.grant.platform !== process.platform || observed.canonicalPath !== snapshot.grant.canonicalPath) {
    throw refuse("The recorded folder changed platforms or location.", 409);
  }
  if (localRootIdentity(snapshot.grant) === localRootIdentity(observed)) {
    throw refuse("The recorded folder identity has not changed. Refresh the project list.", 409);
  }
  if (snapshot.inventory.grants.some(grant => grant.locationRef !== snapshot.grant.locationRef
    && localRootIdentity(grant) === localRootIdentity(observed))) {
    throw refuse("This physical folder is already connected to another project.", 409);
  }
}
async function assertStillObserved(managed, observed) {
  const current = await stat(managed.target, { bigint: true });
  const held = await observed.handle.stat({ bigint: true });
  const currentIdentity = { platform: process.platform, dev: String(current.dev),
    ino: String(current.ino), birthtimeNs: String(current.birthtimeNs) };
  const heldIdentity = { platform: process.platform, dev: String(held.dev),
    ino: String(held.ino), birthtimeNs: String(held.birthtimeNs) };
  if (!current.isDirectory() || !held.isDirectory()
    || localRootIdentity(currentIdentity) !== localRootIdentity(observed)
    || localRootIdentity(heldIdentity) !== localRootIdentity(observed)
    || await realpath(managed.target) !== managed.target) {
    throw refuse("The replacement folder changed during confirmation. Review it again.", 409);
  }
}
async function assertCommittedPath(managed, observed) {
  try {
    await assertStillObserved(managed, observed);
  } catch {
    throw refuse("The reconnection was recorded, but the reviewed folder moved or changed before access was restored. Restore that folder and retry this same confirmation.");
  }
}

function assertStillFolderSync(snapshot, folder, observed, dataDir) {
  const parentInfo = lstatSync(folder.parent, { bigint: true });
  const targetInfo = lstatSync(folder.target, { bigint: true });
  const currentParentIdentity = { dev: String(parentInfo.dev), ino: String(parentInfo.ino),
    birthtimeNs: String(parentInfo.birthtimeNs) };
  const currentTargetIdentity = { platform: process.platform, dev: String(targetInfo.dev),
    ino: String(targetInfo.ino), birthtimeNs: String(targetInfo.birthtimeNs) };
  const managedParent = folder.folderKind === "managed"
    ? path.join(realpathSync(dataDir), "projects") : null;
  if (snapshot.grant.canonicalPath !== folder.target
    || (managedParent !== null && managedParent !== folder.parent)
    || !parentInfo.isDirectory() || parentInfo.isSymbolicLink()
    || !targetInfo.isDirectory() || targetInfo.isSymbolicLink()
    || realpathSync(folder.parent) !== folder.parent || realpathSync(folder.target) !== folder.target
    || JSON.stringify(currentParentIdentity) !== JSON.stringify(folder.parentIdentity)
    || localRootIdentity(currentTargetIdentity) !== localRootIdentity(observed)) {
    throw refuse("The saved project path or its parent changed. Review the reconnection again.");
  }
}

function nextGrant(snapshot, observed, rootId) {
  return { ...snapshot.grant, rootId, ...physical(observed) };
}
async function readReceipt(tx, snapshot, input) {
  const key = receiptKey(snapshot.scope, input.operationId);
  const [row] = await one(tx, `SELECT receipt_key AS receiptKey, actor_id AS actorId,
      collection_id AS collectionId, device_id AS deviceId, operation, operation_id AS operationId,
      request_digest AS requestDigest, record
    FROM vivary_registry_receipts WHERE receipt_key = ?`, [key]);
  if (!row) return null;
  let record;
  try { record = JSON.parse(row.record); }
  catch { throw refuse("The reconnection receipt is invalid.", 409); }
  if (row.receiptKey !== key || row.actorId !== snapshot.scope.actorId
    || row.collectionId !== snapshot.scope.collectionId || row.deviceId !== snapshot.scope.deviceId
    || row.operation !== OPERATION || row.operationId !== input.operationId
    || row.requestDigest !== requestDigest(input)
    || record?.requestDigest !== row.requestDigest
    || record?.planSha256 !== input.acceptedPlanSha256
    || record?.output?.projectId !== input.projectId) {
    throw refuse("This operation ID belongs to a different reconnection request. Review again.", 409);
  }
  if (snapshot.binding.bindingId !== record.output.bindingId
    || snapshot.binding.rootId !== record.output.rootId
    || snapshot.binding.bindingRevision !== record.output.bindingRevision
    || snapshot.grant.rootId !== record.output.rootId
    || JSON.stringify(snapshot.grant) !== JSON.stringify(record.newGrant)) {
    throw refuse("This completed reconnection was superseded. Review the current project.", 409);
  }
  return { ...record.output, code: "already-reconnected", newGrant: record.newGrant };
}

async function requireCurrentPreviewSnapshot(exec, owner, projectId, previous) {
  const current = await loadSnapshot(exec, owner, projectId);
  if (current.settingRaw !== previous.settingRaw
    || current.settingUpdatedAt !== previous.settingUpdatedAt
    || current.registryRevision !== previous.registryRevision
    || JSON.stringify(current.binding) !== JSON.stringify(previous.binding)) {
    throw refuse("Project folder access changed while it was reviewed. Review it again.");
  }
  return current;
}

async function currentRecordedPreview(exec, snapshot, projectId) {
  const rows = await one(exec, `SELECT receipt_key AS receiptKey, actor_id AS actorId,
      collection_id AS collectionId, device_id AS deviceId, operation,
      operation_id AS operationId, request_digest AS requestDigest, record
    FROM vivary_registry_receipts
    WHERE actor_id = ? AND collection_id = ? AND device_id = ? AND operation = ?`,
    [snapshot.scope.actorId, snapshot.scope.collectionId, snapshot.scope.deviceId, OPERATION]);
  const matching = [];
  for (const row of rows) {
    let record;
    try { record = JSON.parse(row.record); }
    catch { throw refuse("The saved reconnection receipt is invalid. Review project access."); }
    if (!record || typeof record !== "object" || Array.isArray(record)
      || record.version !== 1 || typeof record.planSha256 !== "string"
      || !record.output || typeof record.output !== "object" || Array.isArray(record.output)) {
      throw refuse("The saved reconnection receipt is invalid. Review project access.");
    }
    if (record.output.projectId === projectId
      && record.output.bindingId === snapshot.binding.bindingId
      && record.output.rootId === snapshot.binding.rootId
      && record.output.bindingRevision === snapshot.binding.bindingRevision) {
      matching.push({ row, record });
    }
  }
  if (matching.length > 1) {
    throw refuse("Multiple current reconnection receipts exist for this project. Review project access.");
  }
  if (matching.length === 0) return null;
  const { row, record } = matching[0];
  if (!identifier.safeParse(row.operationId).success
    || !digest.safeParse(record.planSha256).success) {
    throw refuse("The saved reconnection receipt is invalid. Review project access.");
  }
  await readReceipt(exec, snapshot, { projectId, operationId: row.operationId,
    acceptedPlanSha256: record.planSha256 });
  return { operationId: row.operationId, planSha256: record.planSha256 };
}

async function reconcileReplay(exec, owner, request, replay, dataDir) {
  let observed;
  try {
    const managed = await reconnectFolder(replay.newGrant, dataDir, owner.service.provider);
    observed = await owner.service.provider.captureReplacement(owner.owner, managed.target);
    if (localRootIdentity(observed) !== localRootIdentity(replay.newGrant)) {
      throw refuse("The completed project folder changed again. Review its current identity.");
    }
    await assertStillObserved(managed, observed);
    // Another reconnection may have committed while the handle was opening.
    await exec.transaction(async tx => {
      const current = await loadSnapshot(tx, owner, request.projectId);
      await readReceipt(tx, current, request);
      assertStillFolderSync(current, managed, observed, dataDir);
    });
    await assertCommittedPath(managed, observed);
    const installed = observed;
    await owner.service.provider.installReplacement(owner.owner.orgId, replay.newGrant, installed);
    observed = null;
    await assertCommittedPath(managed, installed);
    getSettingsEmitter().emit("settings", { source: "settings", type: "change",
      key: localRootInventoryKey(owner.owner.userEmail, owner.owner.orgId),
      requestSource: "vivary-managed-project-reconnection" });
    const { newGrant: _grant, ...output } = replay;
    return output;
  } finally {
    if (observed) await observed.handle.close().catch(() => {});
  }
}

export async function previewManagedProjectReconnection(context, input, dependencies = {}) {
  const projectId = identifier.parse(input.projectId);
  const owner = getLocalProjectReconnectionService(context);
  const exec = await (dependencies.createExec ?? localExec)();
  let observed;
  try {
    const snapshot = await loadSnapshot(exec, owner, projectId);
    const managed = await reconnectFolder(snapshot.grant,
      managedProjectDataDirectory(dependencies), owner.service.provider);
    observed = await owner.service.provider.captureReplacement(owner.owner, managed.target);
    await assertStillObserved(managed, observed);
    const current = await requireCurrentPreviewSnapshot(exec, owner, projectId, snapshot);
    if (localRootIdentity(current.grant) === localRootIdentity(observed)) {
      const recorded = await currentRecordedPreview(exec, current, projectId);
      if (!recorded) {
        throw refuse("The recorded folder identity has not changed. Refresh the project list.");
      }
      return { code: "reconnect-preview", projectId,
        displayName: snapshot.binding.displayName, folderName: managed.folderName,
        folderPath: managed.folderPath, folderKind: managed.folderKind,
        recorded: true, identityChanged: false, ...recorded };
    }
    assertReplacement(current, observed);
    const operationId = randomUUID().replaceAll("-", "");
    const reviewed = plan(current, managed, observed, operationId);
    return { code: "reconnect-preview", projectId, displayName: snapshot.binding.displayName,
      folderName: managed.folderName, folderPath: managed.folderPath,
      folderKind: managed.folderKind, recorded: false, identityChanged: true, operationId,
      planSha256: reviewed.planSha256 };
  } finally {
    await observed?.handle.close();
    await exec.close?.();
  }
}

function hasVivaryCodeHostActivity() {
  const host = globalThis[Symbol.for("vivary.workbench.code-host")];
  if (host?.activeRuns instanceof Map && host.activeRuns.size > 0) return true;
  return listCodeAgentRunRecords("vivary-local-code").some(run =>
    run.metadata?.app === "vivary-workbench-local-code" && isActiveCodeAgentRun(run));
}

function requireIdleCodeHost() {
  if (hasVivaryCodeHostActivity()) {
    throw refuse("Stop or deny the active coding request before reconnecting this folder.");
  }
}

export async function confirmManagedProjectReconnection(context, input, dependencies = {}) {
  const projectId = identifier.parse(input.projectId);
  const operationId = identifier.parse(input.operationId);
  const acceptedPlanSha256 = digest.parse(input.acceptedPlanSha256);
  const request = { projectId, operationId, acceptedPlanSha256 };
  const owner = getLocalProjectReconnectionService(context);
  const release = claimProjectReconnection();
  if (!release) throw refuse("Another project reconnection is in progress. Retry after it finishes.");
  let exec;
  let observed;
  try {
    requireIdleCodeHost();
    exec = await (dependencies.createExec ?? localExec)();
    // A completed exact retry is checked before the folder or plan is recalculated.
    const replay = await exec.transaction(async tx => {
      const snapshot = await loadSnapshot(tx, owner, projectId);
      return readReceipt(tx, snapshot, request);
    });
    if (replay) return await reconcileReplay(exec, owner, request, replay,
      managedProjectDataDirectory(dependencies));

    const before = await loadSnapshot(exec, owner, projectId);
    const managed = await reconnectFolder(before.grant,
      managedProjectDataDirectory(dependencies), owner.service.provider);
    observed = await owner.service.provider.captureReplacement(owner.owner, managed.target);
    assertReplacement(before, observed);
    await assertStillObserved(managed, observed);

    const result = await exec.transaction(async tx => {
      const snapshot = await loadSnapshot(tx, owner, projectId);
      const existing = await readReceipt(tx, snapshot, request);
      if (existing) return existing;
      if (hasVivaryCodeHostActivity()) {
        throw refuse("Stop or deny the active coding request before reconnecting this folder.");
      }
      assertReplacement(snapshot, observed);
      assertStillFolderSync(snapshot, managed, observed,
        managedProjectDataDirectory(dependencies));
      const reviewed = plan(snapshot, managed, observed, operationId);
      if (reviewed.planSha256 !== acceptedPlanSha256) {
        throw refuse("The folder, access, or project revision changed. Review the reconnection again.");
      }
      const [collision] = await one(tx, `SELECT binding_id FROM vivary_registry_bindings
        WHERE collection_id = ? AND device_id = ? AND root_id = ? AND binding_id <> ? LIMIT 1`,
        [snapshot.scope.collectionId, snapshot.scope.deviceId, reviewed.rootId,
          snapshot.binding.bindingId]);
      if (collision) throw refuse("The replacement root ID is already bound to another project.");
      const newPolicyRevision = nextRevision(snapshot.scope.policyRevision);
      const newBindingRevision = nextRevision(snapshot.binding.bindingRevision);
      const newRegistryRevision = nextRevision(snapshot.registryRevision);
      const newGrant = nextGrant(snapshot, observed, reviewed.rootId);
      const inventory = parseLocalRootInventory({ ...snapshot.inventory,
        policyRevision: newPolicyRevision,
        grants: snapshot.inventory.grants.map(grant => grant.locationRef === newGrant.locationRef
          ? newGrant : grant) });
      const updatedAt = Math.max(Date.now(), snapshot.settingUpdatedAt + 1);
      const changedSetting = await tx.execute({ sql: `UPDATE settings SET value = ?, updated_at = ?
        WHERE key = ? AND value = ?`, args: [JSON.stringify(inventory), updatedAt,
        snapshot.settingKey, snapshot.settingRaw] });
      if (changedSetting.rowsAffected !== 1) throw refuse("Project folder access changed. Review again.");
      const changedBinding = await tx.execute({ sql: `UPDATE vivary_registry_bindings
        SET root_id = ?, binding_revision = ?, policy_revision = ?
        WHERE binding_id = ? AND project_id = ? AND actor_id = ? AND collection_id = ?
          AND device_id = ? AND location_ref = ? AND root_id = ?
          AND binding_revision = ? AND policy_revision = ? AND verification_kind = ?`,
        args: [reviewed.rootId, newBindingRevision, newPolicyRevision,
          snapshot.binding.bindingId, projectId, snapshot.scope.actorId,
          snapshot.scope.collectionId, snapshot.scope.deviceId,
          snapshot.binding.locationRef, snapshot.binding.rootId,
          snapshot.binding.bindingRevision, snapshot.binding.bindingPolicyRevision, LOCAL] });
      if (changedBinding.rowsAffected !== 1) throw refuse("The project binding changed. Review again.");
      const changedRevision = await tx.execute({ sql: `UPDATE vivary_registry_revisions
        SET revision = ? WHERE scope_key = ? AND collection_id = ? AND device_id = ? AND revision = ?`,
        args: [newRegistryRevision,
          snapshot.scope.collectionId + ":" + snapshot.scope.deviceId,
          snapshot.scope.collectionId, snapshot.scope.deviceId, snapshot.registryRevision] });
      if (changedRevision.rowsAffected !== 1) throw refuse("The project registry changed. Review again.");
      const output = { code: "reconnected", projectId,
        bindingId: snapshot.binding.bindingId, rootId: reviewed.rootId,
        bindingRevision: newBindingRevision, policyRevision: newPolicyRevision,
        registryRevision: newRegistryRevision };
      const record = { version: 1, requestDigest: requestDigest(request),
        planSha256: acceptedPlanSha256, newGrant, output };
      await tx.execute({ sql: `INSERT INTO vivary_registry_receipts
        (receipt_key, actor_id, collection_id, device_id, operation, operation_id,
          request_digest, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [receiptKey(snapshot.scope, operationId), snapshot.scope.actorId,
          snapshot.scope.collectionId, snapshot.scope.deviceId, OPERATION,
          operationId, record.requestDigest, JSON.stringify(record)] });
      return { ...output, newGrant, settingKey: snapshot.settingKey };
    });
    if (result.code === "already-reconnected") return await reconcileReplay(exec, owner, request, result,
      managedProjectDataDirectory(dependencies));
    // The receipt and binding are committed even if the pathname changes now.
    getSettingsEmitter().emit("settings", { source: "settings", type: "change",
      key: result.settingKey, requestSource: "vivary-managed-project-reconnection" });
    await assertCommittedPath(managed, observed);
    const installed = observed;
    await owner.service.provider.installReplacement(owner.owner.orgId, result.newGrant, installed);
    observed = null;
    await assertCommittedPath(managed, installed);
    const { newGrant: _grant, settingKey: _key, ...output } = result;
    return output;
  } finally {
    try {
      if (observed) await observed.handle.close().catch(() => {});
      await exec?.close?.();
    } finally {
      release();
    }
  }
}
