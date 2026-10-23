# Isolated build tools

Vivary's Linux x64 build clients and Go compilers can be provisioned without
running a package installation script or using the image's npm/pnpm launchers.
This setup does not change Codex Cloud environment settings, system trust stores,
credentials, or the GitHub runner's action interpreter.

## Prerequisite and scope

Run these scripts with the separately qualified CPython **3.12.15 / OpenSSL
3.5.9** interpreter. They refuse other interpreter/library versions. The current
cloud session has that qualified runtime; **provisioning Python on a fresh image
is still a separate prerequisite**. This is not an end-to-end fresh-image setup.
No pip or virtual environment is created here. New Python environments must
retain the existing verified pip 26.2.2/no-old-ensurepip policy.

The setup is Linux x64 only. Windows and workbench hosted jobs are not migrated
by this change. Hosted jobs must first pass the unchanged pre-JavaScript runner
interpreter guard; replacing Node on PATH cannot satisfy that guard. A hosted
site job with an unqualified Python prerequisite remains blocked.

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
the already identified revoked root, writes a private bundle, and adds no roots.
No CA contents or machine-specific receipt belongs in source control.

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
