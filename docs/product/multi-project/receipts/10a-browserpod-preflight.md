# BrowserPod compatibility preflight

Recorded: 2026-09-05. Source inspection and documentation evidence only.

BrowserPod is selected. No pod was booted, no model called, and no BrowserPod
compatibility result is claimed. Existing Habitat checks remain historical.

## Evidence and consequences

| Concern | Evidence | Consequence for implementation |
| --- | --- | --- |
| Execution model | BrowserPod documents Node.js in Wasm and states that native CPU binaries require a Wasm build. [Native dependencies](https://browserpod.io/docs/guides/working-around-native-npm-dependencies) | A Node package name alone is not compatibility proof. Test each selected dependency in the actual pod |
| Existing app | The preserved Workbench manifest directly includes `node-pty` and `@libsql/client`; its lockfile resolves native esbuild packages. Historical Core tests used a native SQLite module | These are compatibility risks, not evidence that the whole app must run inside BrowserPod. Identify each execution location and supported public framework seam before changing a dependency |
| Existing native host | The host imports the public Core Harness API and uses Core's run manager and SQL session owner | Keep those owners. A BrowserPod filesystem/process bridge is not yet implemented; do not invent a second session database or agent loop |
| Python Vivary commands | Vivary's standalone implementation is Python. BrowserPod's inspected pages document Node, not an observed compatible Python installation for this app | Python-in-pod support is unverified. Ticket 10b must probe availability. Do not claim the standalone CLI or Python planning checks already run in BrowserPod |
| Persistent files | The API says default pods are ephemeral and a `storageKey` preserves a filesystem across sessions. [BrowserPod API](https://browserpod.io/docs/reference/BrowserPod) | Persist explicitly and verify reload. A storage key is not an authenticated user grant or native-agent resume proof |
| Credential delivery | BrowserPod keys ultimately reach the browser client. [API keys](https://browserpod.io/docs/understanding-browserpod/api-key) | Use the selected user's scoped connection. Do not put a shared secret into generated source or treat a frontend environment variable as private storage |
| Browser prerequisites | BrowserPod requires cross-origin isolation. [Isolation](https://browserpod.io/docs/understanding-browserpod/cross-origin-isolation) | Verify the probe origin and later the existing sign-in, sidebar, and preview flows. Do not change all workspace headers without that regression check |
| Connection | The inspected app manifest has no BrowserPod SDK integration; no configured BrowserPod session was exercised in this work | The exact connection and SDK version remain prerequisites for a live proof. This is not proof that the user has no external account |

The inference is that application orchestration, native agent state, and project
tool execution need explicit placement. BrowserPod remains the project execution
choice. This receipt does not authorize moving an incompatible tool to Habitat,
WSL, a companion, or a paid host. Raise the particular incompatibility if no
supported BrowserPod path exists, while continuing independent work.

## Next unit

[10b](../packets/10b-browserpod-toolchain-proof.md) owns one real pod and a
synthetic fixture. It must report the version, command, exit code, output, file
effect, persistence result, and exact unsupported capability. A successful Node
fixture does not establish native CLI, Python, full-app, multi-user isolation,
or background execution support.
