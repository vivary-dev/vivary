# Isolated build tools

Vivary's x64 build clients and Go compilers can be provisioned without
running a package installation script or using the image's npm/pnpm launchers.
This setup does not change Codex Cloud environment settings, system trust stores,
credentials, or the GitHub runner's action interpreter.

## Prerequisite and scope

Run these scripts with the separately qualified CPython **3.12.15 / OpenSSL
3.5.9** interpreter. They refuse other interpreter/library versions. The current
cloud session has that qualified runtime; **provisioning Python on a fresh image
is still a separate prerequisite**. This is not an end-to-end fresh-image setup.
No pip or virtual environment is created here. New Python environments must
retain pip 26.2.2 with the authenticated certifi 2026.10.23 overlay described below; an unchanged upstream pip wheel still vendors the older bundle.

The tool setup supports native Linux and Windows x64. Hosted CI uses its initial
Python only to provision an authenticated standalone CPython 3.12.15 build with
OpenSSL 3.5.9 into the task directory. The runtime's retained ensurepip seed gets
the verified certifi overlay before its directory is exported. Jobs must then
admit the actual CPython/OpenSSL versions before pip or build-tool use. A version
selection alone does not qualify an executable. Hosted jobs must also
pass the unchanged pre-JavaScript runner interpreter guard; replacing Node on
PATH cannot satisfy that guard. An unqualified hosted Python remains blocked.

## Setup and use

Use an absolute, task-owned directory outside the checkout. Substitute the actual
qualified Python path; do not substitute the image interpreter without admission.

```sh
/path/to/qualified/python -I -B scripts/bootstrap_build_tools.py --root /workspace/vivary-build-tools
/path/to/qualified/python -I -B scripts/build_go_tools.py --root /workspace/vivary-build-tools
```

The first command installs pinned Node 24.22.1, pnpm 10.34.7 and npm 12.2.1 with
the previously qualified undici 6.29.1/ip-address 10.7.4 replacements. The second
builds esbuild 0.28.2 from checksum-bound source with Go 1.26.10. Add
`--typescript` to the second command when TypeScript 7.0.2 is needed. That option
checks the exact source commit and module manifests and copies only the verified
declarations from its platform package; it never runs the package's old compiler.

Use the generated launchers by absolute path. Each package-client launcher binds
the actual Node executable, excludes inherited client/Node overrides, and gives
its child processes the same Node and isolated certificate policy. The bundled
npm/npx entry points remain blocked. The setup retains existing CA roots except
the previously excluded G3 root and the C1/C3 roots removed by certifi 2026.10.23, writes a private bundle, and adds no roots. C1/C3 removal does not establish compromise or exploitation. Existing task directories containing an older bundle fail closed; provision a new task directory or explicitly migrate only a previously verified bundle. Host-global trust is never changed.
No CA contents or machine-specific receipt belongs in source control.

Windows launchers bind the physical Node executable separately from their
command directory, clear inherited injection settings and select the private
OpenSSL CA bundle. The bundle includes only eligible server-authentication ROOT
entries, excludes certificates in Disallowed and the existing policy exclusions,
and does not turn intermediate CA entries into trust anchors. Go on Windows
does not honor the PEM override: its module inputs are fetched by the qualified
Python HTTPS client, verified against the pinned module checksums and compiled
offline. Native Windows execution remains a separate required verification;
cross-platform fixtures do not establish it.

```sh
/path/to/qualified/python -I -B scripts/check_site_dependencies.py
cd site
/workspace/vivary-build-tools/bin/npm ci --ignore-scripts
cd ..
/path/to/qualified/python -I -B scripts/check_site_dependencies.py --installed
cd site
/workspace/vivary-build-tools/bin/npm audit --audit-level=high
/workspace/vivary-build-tools/bin/npm run sync-docs
ASTRO_TELEMETRY_DISABLED=1 \
  ESBUILD_BINARY_PATH=/workspace/vivary-build-tools/esbuild-0.28.2-go1.26.10 \
  /workspace/vivary-build-tools/bin/npm run build
/workspace/vivary-build-tools/bin/npm run test:links
```

Dependency
lifecycles default off, including automatic pre/post hooks for `npm run`; docs
sync is therefore explicit before the guarded build. Explicitly requested scripts
still run. Installation and metadata checks do not by themselves qualify every
native dependency: retain the scoped graph and native-artifact review before a
new or changed dependency is executed.

Run TypeScript using the rebuilt binary directly:

```sh
/workspace/vivary-build-tools/typescript-7.0.2-go1.26.10/tsc --noEmit --project packages/workbench/tsconfig.json
```

Repeated setup rechecks archive hashes and all installed package-owned files,
links and executable bits, refusing unexpected changes. It does not repair a
modified tool tree silently. Compiler builds use isolated Go caches, fixed module
checksums, the local Go toolchain, and no automatic toolchain upgrades. Unverified
platform/compiler variants and changed dependency graphs require new review.

The site workflow removes `setup-node`'s npm cache feature because that feature
can invoke npm before provisioning. Its client paths and compiler override are
explicit. None of these local setup or build results substitutes for hosted CI,
browser acceptance, native Windows acceptance, or release authorization.

## Hosted action interpreter

The first native workflow step can repair the owning GitHub Worker's known
Node 24.21.0 binary before any JavaScript action. It derives the selected path
from the actual Worker ancestry, authenticates official Node 24.22.1 bytes that
match the published runner 2.338.1 binaries, and replaces only that file. It uses
the current user's permissions, an exclusive staged file and an atomic rename;
it adds no runner registration, privilege escalation, credentials or trust root.
The complete existing runner admission then checks the actual selected binary.

The repair is limited to authenticated old binary hashes. Already qualified
binaries need no download; other binaries must pass the existing admission
unchanged and are never blindly downgraded. On Linux, a non-truncating write
descriptor refuses an executing old inode and prevents new execution of that
inode throughout replacement. Windows checks native x64 identity and potential
Node processes; a file lock or denied replacement stops the job. Changed ancestry,
unexpected paths, incomplete downloads and permission failures also stop it.
After a replacement, a failed final check leaves the patched bytes in place and
blocks actions rather than restoring an affected interpreter.

Runner `externals` is a guarded internal layout, not a stable vendor update API.
Native shell steps and per-job hosted machines allow this bounded setup, but
actual hosted write access and Windows locks still require job evidence. Source
and fixture tests do not establish a hosted pass. This changes the actual action
interpreter; selecting another Node on `PATH` cannot provide the same result.

## Python certificate bundles

[`certifi_bundle.py`](../scripts/certifi_bundle.py) pins the official certifi
2026.10.23 wheel by URL, size and SHA256. The published pip 26.2.2 wheel still
vendors certifi 2026.10.19. Before executing pip, CI and desktop packaging derive
a narrowly changed wheel from both authenticated upstream artifacts. Only
vendored certifi's version module and CA bundle, the vendor pin and wheel RECORD
change. Pip's import rewrites, distlib and all other package bytes remain intact.
This is a Vivary-derived wheel, not a new upstream pip release. Its original and
derived digests are separate; pip retains version 26.2.2 for ensurepip compatibility.

CI runs `bootstrap_ci_pip.py` with the selected qualified Python, then
`check_pip_runtime.py` with the same interpreter and `-I`. The guard checks the
loaded pip/distribution paths plus the actual vendored certifi path, version and
CA digest. CI pip commands explicitly select pip's supported `--use-deprecated=legacy-certs` mode so its verified certifi store is not unioned with an unqualified host store, including Windows CryptoAPI. The workflow also passes `PIP_USE_DEPRECATED=legacy-certs` to build-isolation pip children, which do not inherit parent command flags. This retains certificate and hostname verification; it does not use `--trusted-host` or disable TLS. Unknown future bundles require qualification rather than a version-only
pass. Desktop packaging uses the same overlay before its first build-pip execution
and replaces the authenticated retained Linux/Windows ensurepip seed, preventing
fresh default venvs from restoring the older bundle. The seven shipped Vivary
packages do not gain a standalone certifi dependency. See the
[desktop runtime contract](../packages/desktop/README.md).

The task-local CA policy also removes the same C1/C3 fingerprints from generated
system-derived bundles, retaining all other roots and the existing G3 exclusion.
Python/pip/uv and generated Node package-client descendants must use those task
bundles. Updating standalone certifi alone does not update pip's vendor, ensurepip,
or operating-system trust. No host-global CA store is changed. These source/build
changes do not modify already published ZIPs or installed user environments.
