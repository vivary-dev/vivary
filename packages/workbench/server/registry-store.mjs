/** Private Workbench registry storage. No public action or root observer. */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "@agent-native/core/db/schema";
import { getDb } from "./db/index.mjs";
import {
  bindings, mutationFenceHighWater, mutationReservationKeys, mutationReservations,
  projects, receipts, revisions,
} from "./db/schema.mjs";

const FACTS = ["actorId", "collectionId", "deviceId", "member", "capabilities",
  "rootAccess", "policyRevision", "root", "overlapSafe"];
const EARLY_REFUSALS = new Set(["invalid-input", "denied", "stale-policy",
  "root-unavailable", "not-directory", "identity-unverified", "attachment-required",
  "ambiguous-ownership"]);
const MUTATION_EARLY_REFUSALS = new Set(["invalid-input", "denied", "stale-policy",
  "root-unavailable", "not-directory", "identity-unverified"]);
const SCOPE_REFUSALS = new Set(["invalid-input", "denied", "stale-policy"]);
const earlyRefusalsFor = (operation) => operation === "admit-mutation"
  ? MUTATION_EARLY_REFUSALS : operation === "quarantine-mutation" ? SCOPE_REFUSALS : EARLY_REFUSALS;
const rejected = (code) => ({ output: { code }, effects: [], recordChanges: {} });
const scopeKey = (facts) => `${facts.collectionId}:${facts.deviceId}`;
const receiptKey = (facts, operation, operationId) =>
  `${facts.actorId}:${facts.collectionId}:${facts.deviceId}:${operation}:${operationId}`;
const reservationId = (value) => "reservation_" + createHash("sha256").update([
  value.ownerActorId, value.ownerCollectionId, value.ownerDeviceId, value.ownerOperationId,
].join("\0")).digest("hex");

class RefusedTransaction extends Error {
  constructor(decision) { super(decision.output.code); this.decision = decision; }
}

function inputFor(operation, request, facts) {
  return {
    operation, request,
    trusted: {
      ...facts, registryRevision: 0, portable: null, binding: null,
      existingRootBindings: [], receipt: null,
      allocatedProjectId: "allocation-pending", allocatedBindingId: "allocation-pending",
      allocatedIdsInUse: false, reservations: [], nextFence: 1, execution: null,
      patchVerified: false,
      privateState: { locator: "unused", credentialRef: "unused", remoteRef: "unused" },
    },
  };
}

function portable(row) {
  if (!row) return null;
  return {
    schemaVersion: row.schemaVersion, projectId: row.projectId, displayName: row.displayName,
    contentIdentity: row.contentAlgorithm === null ? null : {
      algorithm: row.contentAlgorithm, manifestDigest: row.contentManifestDigest,
    },
  };
}

function binding(row) {
  if (!row) return null;
  const { vcsKind, repositoryId, checkoutId, mutationOwner, jjRepositoryId, jjWorkspaceId,
    verificationKind, ...record } = row;
  return { ...record, ...(verificationKind === "local-stat-revalidated-v1" ? { verificationKind } : {}), vcs: {
    kind: vcsKind, repositoryId, checkoutId, mutationOwner,
    ...(vcsKind === "jj-git" ? { jjRepositoryId, jjWorkspaceId } : {}),
  } };
}

function parseRecord(row) {
  try { return JSON.parse(row.record); }
  catch { throw new RefusedTransaction(rejected("invalid-input")); }
}

function parseReservation(row) {
  let keys;
  try { keys = JSON.parse(row.keys); }
  catch { throw new RefusedTransaction(rejected("invalid-input")); }
  return {
    keys, ownerActorId: row.ownerActorId, ownerCollectionId: row.ownerCollectionId,
    ownerDeviceId: row.ownerDeviceId, ownerOperationId: row.ownerOperationId,
    state: row.state, fence: row.fence,
  };
}

const WORKSPACE_KINDS = new Set(["coding", "personal"]);

/**
 * Saves the owner's Coding or Personal choice on one registered project. The
 * caller has already admitted the owner and project scope. This preference is
 * outside the registration decision engine, the portable record and the
 * registry revision. Returns false when no such project exists.
 */
export async function updateProjectWorkspaceKind(projectId, kind) {
  if (typeof projectId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) {
    throw new TypeError("workspace kind requires a registered project identifier");
  }
  if (!WORKSPACE_KINDS.has(kind)) throw new TypeError("workspace kind must be coding or personal");
  const updated = await getDb().update(projects).set({ workspaceKind: kind })
    .where(eq(projects.projectId, projectId)).returning({ projectId: projects.projectId });
  return updated.length === 1;
}

/**
 * Trusted application code installs the resolver, allocator, and the existing
 * versioned decision engine. The resolver receives a store-selected binding
 * only after its actor, collection, and device scope matches current facts.
 */
export function createRegistryStore({ resolveFacts, allocateIds, evaluate, deriveMutationKeys }) {
  if ([resolveFacts, allocateIds, evaluate].some((value) => typeof value !== "function")) {
    throw new TypeError("registry store requires trusted resolver, allocator and decision engine");
  }

  async function resolve(operation, request, selectedBinding = null) {
    const supplied = await resolveFacts(operation, structuredClone(request),
      selectedBinding === null ? null : structuredClone(selectedBinding));
    if (supplied === null || typeof supplied !== "object" || Array.isArray(supplied)
      || Object.keys(supplied).length !== FACTS.length
      || FACTS.some((key) => !Object.hasOwn(supplied, key))) {
      throw new RefusedTransaction(rejected("invalid-input"));
    }
    return Object.fromEntries(FACTS.map((key) => [key, structuredClone(supplied[key])]));
  }

  async function reauthorize(operation, request, previous, selectedBinding = null) {
    const current = await resolve(operation, request, selectedBinding);
    const check = inputFor(operation, request, current);
    check.trusted.binding = selectedBinding;
    const preliminary = evaluate(check);
    const earlyRefusals = earlyRefusalsFor(operation);
    if (earlyRefusals.has(preliminary.output.code)) throw new RefusedTransaction(preliminary);
    if (JSON.stringify(current) !== JSON.stringify(previous)) {
      throw new RefusedTransaction(rejected("retry-state"));
    }
  }

  async function loadRegistration(tx, input) {
    const facts = input.trusted;
    const [revision] = await tx.select().from(revisions).where(eq(revisions.scopeKey, scopeKey(facts)));
    facts.registryRevision = revision?.revision ?? 0;
    const matches = await tx.select().from(bindings).where(and(
      eq(bindings.collectionId, facts.collectionId), eq(bindings.deviceId, facts.deviceId),
      eq(bindings.rootId, facts.root.rootId),
    ));
    facts.existingRootBindings = matches.map(binding);
    const [receipt] = await tx.select().from(receipts).where(
      eq(receipts.receiptKey, receiptKey(facts, "register", input.request.operationId)),
    );
    if (receipt) {
      facts.receipt = parseRecord(receipt);
      const [bound] = await tx.select().from(bindings).where(
        eq(bindings.bindingId, facts.receipt.output.bindingId),
      );
      facts.binding = binding(bound);
      const [project] = await tx.select().from(projects).where(
        eq(projects.projectId, facts.receipt.output.projectId),
      );
      facts.portable = portable(project);
    }
  }

  async function applyRegistration(tx, input, decision) {
    const changes = decision.recordChanges;
    if (changes.insertPortable) {
      const row = changes.insertPortable;
      await tx.insert(projects).values({
        projectId: row.projectId, schemaVersion: row.schemaVersion, displayName: row.displayName,
        contentAlgorithm: row.contentIdentity?.algorithm ?? null,
        contentManifestDigest: row.contentIdentity?.manifestDigest ?? null,
      });
      const { vcs, ...bound } = changes.insertBinding;
      await tx.insert(bindings).values({ ...bound, vcsKind: vcs.kind,
        repositoryId: vcs.repositoryId, checkoutId: vcs.checkoutId, mutationOwner: vcs.mutationOwner,
        jjRepositoryId: vcs.jjRepositoryId ?? null, jjWorkspaceId: vcs.jjWorkspaceId ?? null,
      });
    }
    if (changes.insertReceipt) {
      const receipt = changes.insertReceipt;
      await tx.insert(receipts).values({
        receiptKey: receiptKey(receipt, receipt.operation, receipt.operationId),
        actorId: receipt.actorId, collectionId: receipt.collectionId, deviceId: receipt.deviceId,
        operation: receipt.operation, operationId: receipt.operationId,
        record: JSON.stringify(receipt),
      });
      const facts = input.trusted;
      if (facts.registryRevision === 0) {
        await tx.insert(revisions).values({ scopeKey: scopeKey(facts), collectionId: facts.collectionId,
          deviceId: facts.deviceId, revision: changes.registryRevision });
      } else {
        const updated = await tx.update(revisions).set({ revision: changes.registryRevision }).where(and(
          eq(revisions.scopeKey, scopeKey(facts)), eq(revisions.revision, facts.registryRevision),
        )).returning({ scopeKey: revisions.scopeKey });
        if (updated.length !== 1) throw new RefusedTransaction(rejected("retry-state"));
      }
    }
  }

  async function loadMutation(tx, input) {
    const facts = input.trusted;
    const [receipt] = await tx.select().from(receipts).where(eq(receipts.receiptKey,
      receiptKey(facts, "admit-mutation", input.request.operationId)));
    if (receipt) facts.receipt = parseRecord(receipt);
    const [row] = await tx.select().from(bindings).where(and(
      eq(bindings.bindingId, input.request.bindingId), eq(bindings.actorId, facts.actorId),
      eq(bindings.collectionId, facts.collectionId), eq(bindings.deviceId, facts.deviceId),
    ));
    if (!row) {
      throw new RefusedTransaction(rejected("binding-unavailable"));
    }
    facts.binding = binding(row);
    const [revision] = await tx.select().from(revisions).where(eq(revisions.scopeKey, scopeKey(facts)));
    if (!revision) throw new RefusedTransaction(rejected("retry-state"));
    facts.registryRevision = revision.revision;
  }

  async function loadMutationConflicts(tx, input, keys) {
    const facts = input.trusted;
    const selectedClaims = await tx.select().from(mutationReservationKeys)
      .where(inArray(mutationReservationKeys.resourceKey, keys));
    const ids = [...new Set(selectedClaims.map((row) => row.reservationId))];
    if (ids.length > 0) {
      const parents = await tx.select().from(mutationReservations)
        .where(inArray(mutationReservations.reservationId, ids));
      const allClaims = await tx.select().from(mutationReservationKeys)
        .where(inArray(mutationReservationKeys.reservationId, ids));
      if (parents.length !== ids.length) throw new RefusedTransaction(rejected("invalid-input"));
      facts.reservations = parents.map((row) => {
        const value = parseReservation(row);
        const claimed = allClaims.filter((claim) => claim.reservationId === row.reservationId)
          .map((claim) => claim.resourceKey).sort();
        if (JSON.stringify(claimed) !== JSON.stringify(value.keys)) {
          throw new RefusedTransaction(rejected("invalid-input"));
        }
        return value;
      });
    }
    const fences = await tx.select().from(mutationFenceHighWater)
      .where(inArray(mutationFenceHighWater.resourceKey, keys));
    const highest = fences.reduce((value, row) => Math.max(value, row.fence), 0);
    facts.nextFence = highest === Number.MAX_SAFE_INTEGER ? highest : highest + 1;
    return { prior: new Map(fences.map((row) => [row.resourceKey, row.fence])),
      exhausted: highest === Number.MAX_SAFE_INTEGER };
  }

  async function loadQuarantine(tx, input) {
    const facts = input.trusted;
    const key = receiptKey(facts, "admit-mutation", input.request.operationId);
    const [row] = await tx.select().from(receipts).where(eq(receipts.receiptKey, key));
    const [revision] = await tx.select().from(revisions).where(eq(revisions.scopeKey, scopeKey(facts)));
    if (!row) {
      facts.registryRevision = revision?.revision ?? 0;
      return null;
    }
    const record = parseRecord(row);
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new RefusedTransaction(rejected("invalid-input"));
    }
    if (
      row.receiptKey !== key ||
      row.actorId !== facts.actorId || row.actorId !== record.actorId ||
      row.collectionId !== facts.collectionId || row.collectionId !== record.collectionId ||
      row.deviceId !== facts.deviceId || row.deviceId !== record.deviceId ||
      row.operation !== "admit-mutation" || row.operation !== record.operation ||
      row.operationId !== input.request.operationId || row.operationId !== record.operationId ||
      row.requestDigest === null || row.requestDigest !== record.requestDigest ||
      row.creationNamespaceKey !== null || row.creationChildKey !== null || row.creationPhase !== null ||
      !revision || revision.scopeKey !== scopeKey(facts) ||
      revision.collectionId !== facts.collectionId || revision.deviceId !== facts.deviceId
    ) throw new RefusedTransaction(rejected("invalid-input"));
    facts.receipt = record;
    facts.registryRevision = revision.revision;

    const expectedReservationId = reservationId({
      ownerActorId: record.actorId,
      ownerCollectionId: record.collectionId,
      ownerDeviceId: record.deviceId,
      ownerOperationId: record.operationId,
    });
    const [parentRow] = await tx.select().from(mutationReservations).where(
      eq(mutationReservations.reservationId, expectedReservationId),
    );
    if (!parentRow) throw new RefusedTransaction(rejected("invalid-input"));
    const parent = parseReservation(parentRow);
    if (!Array.isArray(parent.keys) || parent.keys.length === 0
      || parent.keys.some((resourceKey) => typeof resourceKey !== "string")) {
      throw new RefusedTransaction(rejected("invalid-input"));
    }
    const claims = await tx.select().from(mutationReservationKeys).where(
      eq(mutationReservationKeys.reservationId, expectedReservationId),
    );
    const claimed = claims.map((claim) => claim.resourceKey).sort();
    if (claims.some((claim) => claim.reservationId !== expectedReservationId)
      || JSON.stringify(claimed) !== JSON.stringify(parent.keys)) {
      throw new RefusedTransaction(rejected("invalid-input"));
    }
    const highWaters = await tx.select().from(mutationFenceHighWater).where(
      inArray(mutationFenceHighWater.resourceKey, parent.keys),
    );
    const selected = new Map(highWaters.map((highWater) => [highWater.resourceKey, highWater.fence]));
    if (highWaters.length !== parent.keys.length || selected.size !== parent.keys.length
      || parent.keys.some((resourceKey) => selected.get(resourceKey) !== parent.fence)) {
      throw new RefusedTransaction(rejected("invalid-input"));
    }
    facts.reservations = [parent];
    return { receiptRow: row, reservationRow: parentRow,
      reservationId: expectedReservationId };
  }

  async function insertOnce(query, returning) {
    const rows = await query.onConflictDoNothing().returning(returning);
    if (rows.length !== 1) throw new RefusedTransaction(rejected("retry-state"));
  }

  async function applyMutation(tx, input, decision, priorFences) {
    const facts = input.trusted;
    const changes = decision.recordChanges;
    const updated = await tx.update(revisions).set({ revision: changes.registryRevision }).where(and(
      eq(revisions.scopeKey, scopeKey(facts)), eq(revisions.revision, facts.registryRevision),
    )).returning({ scopeKey: revisions.scopeKey });
    if (updated.length !== 1) throw new RefusedTransaction(rejected("retry-state"));

    const reservation = changes.insertReservation;
    const id = reservationId(reservation);
    await insertOnce(tx.insert(mutationReservations).values({
      reservationId: id, ownerActorId: reservation.ownerActorId,
      ownerCollectionId: reservation.ownerCollectionId, ownerDeviceId: reservation.ownerDeviceId,
      ownerOperationId: reservation.ownerOperationId, state: reservation.state,
      fence: reservation.fence, keys: JSON.stringify(reservation.keys),
    }), { reservationId: mutationReservations.reservationId });
    for (const key of reservation.keys) {
      await insertOnce(tx.insert(mutationReservationKeys).values({ resourceKey: key, reservationId: id }),
        { resourceKey: mutationReservationKeys.resourceKey });
      const previous = priorFences.get(key);
      if (previous === undefined) {
        await insertOnce(tx.insert(mutationFenceHighWater).values({ resourceKey: key,
          fence: reservation.fence }), { resourceKey: mutationFenceHighWater.resourceKey });
      } else {
        const advanced = await tx.update(mutationFenceHighWater).set({ fence: reservation.fence }).where(and(
          eq(mutationFenceHighWater.resourceKey, key), eq(mutationFenceHighWater.fence, previous),
        )).returning({ resourceKey: mutationFenceHighWater.resourceKey });
        if (advanced.length !== 1) throw new RefusedTransaction(rejected("retry-state"));
      }
    }
    const receipt = changes.insertReceipt;
    await insertOnce(tx.insert(receipts).values({
      receiptKey: receiptKey(receipt, receipt.operation, receipt.operationId),
      actorId: receipt.actorId, collectionId: receipt.collectionId, deviceId: receipt.deviceId,
      operation: receipt.operation, operationId: receipt.operationId,
      requestDigest: receipt.requestDigest, record: JSON.stringify(receipt),
    }), { receiptKey: receipts.receiptKey });
  }

  async function applyQuarantine(tx, input, decision, loaded) {
    if (loaded === null) throw new RefusedTransaction(rejected("retry-state"));
    const facts = input.trusted;
    const changes = decision.recordChanges;
    const revisionRows = await tx.update(revisions).set({ revision: changes.registryRevision }).where(and(
      eq(revisions.scopeKey, scopeKey(facts)),
      eq(revisions.collectionId, facts.collectionId),
      eq(revisions.deviceId, facts.deviceId),
      eq(revisions.revision, facts.registryRevision),
    )).returning({ scopeKey: revisions.scopeKey });
    if (revisionRows.length !== 1) throw new RefusedTransaction(rejected("retry-state"));

    const priorReservation = loaded.reservationRow;
    const reservationRows = await tx.update(mutationReservations).set({ state: "uncertain" }).where(and(
      eq(mutationReservations.reservationId, loaded.reservationId),
      eq(mutationReservations.ownerActorId, priorReservation.ownerActorId),
      eq(mutationReservations.ownerCollectionId, priorReservation.ownerCollectionId),
      eq(mutationReservations.ownerDeviceId, priorReservation.ownerDeviceId),
      eq(mutationReservations.ownerOperationId, priorReservation.ownerOperationId),
      eq(mutationReservations.state, priorReservation.state),
      eq(mutationReservations.fence, priorReservation.fence),
      eq(mutationReservations.keys, priorReservation.keys),
    )).returning({ reservationId: mutationReservations.reservationId });
    if (reservationRows.length !== 1) throw new RefusedTransaction(rejected("retry-state"));

    const priorReceipt = loaded.receiptRow;
    const receiptRows = await tx.update(receipts).set({
      record: JSON.stringify(changes.replaceReceipt),
    }).where(and(
      eq(receipts.receiptKey, priorReceipt.receiptKey),
      eq(receipts.actorId, priorReceipt.actorId),
      eq(receipts.collectionId, priorReceipt.collectionId),
      eq(receipts.deviceId, priorReceipt.deviceId),
      eq(receipts.operation, priorReceipt.operation),
      eq(receipts.operationId, priorReceipt.operationId),
      priorReceipt.requestDigest === null
        ? isNull(receipts.requestDigest) : eq(receipts.requestDigest, priorReceipt.requestDigest),
      priorReceipt.creationNamespaceKey === null
        ? isNull(receipts.creationNamespaceKey) : eq(receipts.creationNamespaceKey, priorReceipt.creationNamespaceKey),
      priorReceipt.creationChildKey === null
        ? isNull(receipts.creationChildKey) : eq(receipts.creationChildKey, priorReceipt.creationChildKey),
      priorReceipt.creationPhase === null
        ? isNull(receipts.creationPhase) : eq(receipts.creationPhase, priorReceipt.creationPhase),
      eq(receipts.record, priorReceipt.record),
    )).returning({ receiptKey: receipts.receiptKey });
    if (receiptRows.length !== 1) throw new RefusedTransaction(rejected("retry-state"));
  }

  async function selectMutationBinding(request, facts) {
    const [row] = await getDb().select().from(bindings).where(and(
      eq(bindings.bindingId, request.bindingId), eq(bindings.actorId, facts.actorId),
      eq(bindings.collectionId, facts.collectionId), eq(bindings.deviceId, facts.deviceId),
    ));
    if (!row) return null;
    return binding(row);
  }

  async function run(operation, originalRequest) {
    const request = structuredClone(originalRequest);
    try {
      let facts = await resolve(operation, request);
      let selectedBinding = null;
      if (operation === "admit-mutation" || operation === "quarantine-mutation") {
        const scopeCheck = evaluate(inputFor(operation, request, facts));
        if (SCOPE_REFUSALS.has(scopeCheck.output.code)) return scopeCheck;
        if (operation === "admit-mutation") {
          selectedBinding = await selectMutationBinding(request, facts);
          if (selectedBinding === null) return rejected("binding-unavailable");
          facts = await resolve(operation, request, selectedBinding);
        }
      }
      const preliminaryInput = inputFor(operation, request, facts);
      preliminaryInput.trusted.binding = selectedBinding;
      const preliminary = evaluate(preliminaryInput);
      const earlyRefusals = earlyRefusalsFor(operation);
      if (earlyRefusals.has(preliminary.output.code)) return preliminary;
      return await getDb().transaction(async (tx) => {
        const input = inputFor(operation, request, facts);
        if (operation === "quarantine-mutation") {
          await reauthorize(operation, request, facts);
        }
        let quarantineState = null;
        if (operation === "register") {
          await loadRegistration(tx, input);
        } else if (operation === "export") {
          const [project] = await tx.select().from(projects).where(eq(projects.projectId, request.projectId));
          const [bound] = await tx.select().from(bindings).where(and(
            eq(bindings.projectId, request.projectId), eq(bindings.actorId, facts.actorId),
            eq(bindings.collectionId, facts.collectionId), eq(bindings.deviceId, facts.deviceId),
          ));
          input.trusted.portable = portable(project);
          input.trusted.binding = binding(bound);
        } else if (operation === "quarantine-mutation") {
          quarantineState = await loadQuarantine(tx, input);
        } else {
          await loadMutation(tx, input);
          selectedBinding = input.trusted.binding;
        }
        await reauthorize(operation, request, facts, selectedBinding);
        let decision;
        let fenceState = { prior: new Map(), exhausted: false };
        if (operation === "admit-mutation" && input.trusted.receipt === null) {
          if (typeof deriveMutationKeys !== "function") {
            throw new TypeError("mutation admission requires the registry key derivation owner");
          }
          const keys = deriveMutationKeys(input.trusted, request.requestedVcsOwner);
          if (keys !== null) fenceState = await loadMutationConflicts(tx, input, keys);
          decision = evaluate(input);
          if (decision.output.code === "admitted" && fenceState.exhausted) {
            decision = rejected("invalid-input");
          }
        } else decision = evaluate(input);
        if (operation === "register" && decision.output.code === "registered"
          && decision.output.replayed === false) {
          const allocated = await allocateIds();
          input.trusted.allocatedProjectId = allocated.projectId;
          input.trusted.allocatedBindingId = allocated.bindingId;
          const validAllocation = evaluate(input);
          if (validAllocation.output.code === "invalid-input") return validAllocation;
          const [project] = await tx.select().from(projects).where(eq(projects.projectId, allocated.projectId));
          const [bound] = await tx.select().from(bindings).where(eq(bindings.bindingId, allocated.bindingId));
          input.trusted.allocatedIdsInUse = Boolean(project || bound);
          decision = evaluate(input);
        }
        if (operation === "register") await applyRegistration(tx, input, decision);
        if (operation === "admit-mutation" && decision.output.code === "admitted") {
          await applyMutation(tx, input, decision, fenceState.prior);
        }
        if (operation === "quarantine-mutation" && decision.output.code === "quarantined"
          && decision.output.replayed === false) {
          await applyQuarantine(tx, input, decision, quarantineState);
        }
        await reauthorize(operation, request, facts, selectedBinding);
        return decision;
      });
    } catch (error) {
      if (error instanceof RefusedTransaction) return error.decision;
      throw error;
    }
  }

  return Object.freeze({
    register: (request) => run("register", request),
    exportProject: (request) => run("export", request),
    admitMutation: (request) => run("admit-mutation", request),
    quarantineMutation: (request) => run("quarantine-mutation", request),
  });
}
