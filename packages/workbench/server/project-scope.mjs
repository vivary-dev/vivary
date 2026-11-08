import { createHash } from "node:crypto";

/** The scope identity a saved project selection is pinned to. */
export const catalogScopeKey = scope => createHash("sha256")
  .update(JSON.stringify({
    actorId: scope.actorId,
    collectionId: scope.collectionId,
    deviceId: scope.deviceId,
  }))
  .digest("hex");
