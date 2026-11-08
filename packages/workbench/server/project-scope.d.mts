export type ProjectScopeIdentity = Readonly<{
  actorId: string;
  collectionId: string;
  deviceId: string;
}>;

export function catalogScopeKey(scope: ProjectScopeIdentity): string;
