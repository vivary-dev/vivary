// Compare an installed "major.minor.patch" release with a required one. Returns a negative number when the
// installed release is older, zero when equal, and a positive number when newer. Any other shape, such as a
// prerelease suffix or a missing version, returns undefined so the caller can treat it as unverified.
export function compareReleaseVersions(installed: string | undefined, required: string): number | undefined {
  const parts = installed?.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  if (!parts) return undefined;
  const floor = required.split(".").map(Number);
  return parts.map((part, index) => part - floor[index]).find(part => part !== 0) ?? 0;
}
