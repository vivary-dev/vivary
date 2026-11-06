// A release is major.minor.patch, or a beta of it: major.minor.patch-beta.N.
// Each part fits a Windows version field (0 to 65535) and has no leading zero.
const part = "(0|[1-9]\\d{0,4})";
const releaseVersion = new RegExp(`^${part}\\.${part}\\.${part}(?:-beta\\.${part})?$`);

/**
 * Returns the release channel of a desktop version and the four numeric parts
 * Windows file properties need. A beta's number becomes the fourth part, so
 * 0.1.0-beta.1 reads 0.1.0.1 and 0.1.0 reads 0.1.0.0. Windows therefore orders
 * a beta above the release it precedes. The readable version stays the string.
 */
export function releaseIdentity(version) {
  const match = typeof version === "string" ? releaseVersion.exec(version) : null;
  if (!match || match.slice(1).some(value => value !== undefined && Number(value) > 65535)) {
    throw new Error(`The desktop version must have the form major.minor.patch or major.minor.patch-beta.N: ${version}`);
  }
  const [, major, minor, patch, beta] = match;
  return Object.freeze({
    version, channel: beta === undefined ? "stable" : "beta",
    windowsVersion: [major, minor, patch, beta ?? "0"].join("."),
  });
}
