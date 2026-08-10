# Vivary MCP adapter

`vivary-mcp` is an optional, read-only bridge from local MCP clients to Vivary's
bounded public context producers. It is not part of the baseline install, does not
change the graph, and does not add MCP dependencies to `vivary-core`.

The project has not published this development-source package or enabled it by
default.

## Contract

The adapter pins:

- MCP protocol `2026-07-28`
- official Python SDK `mcp==2.0.0` and `mcp-types==2.0.0`
- local standard input/output transport only
- SDK-owned discovery through `server/discover`
- exactly four tools and no extensions

Tests cover the SDK-owned discovery, metadata, cancellation, schema-validation, and
server-identity paths. Vivary has not passed the pinned external conformance harness.
Doctor therefore reports `conformance_status: unproven`.

## Install boundary

From a checkout, install the optional package explicitly:

```bash
python -m pip install ./packages/core ./packages/tropo ./packages/mcp
```

Supplying all three local distributions in one resolution keeps pip from looking for
the unpublished Core or Tropo development versions on the package index. It also
installs the exact reviewed MCP SDK dependency. The normal `vivary` and `create-vivary`
installs do not include or start the adapter.

## Start the local server

Bind each public alias to one canonical workspace root at process startup:

```bash
vivary-mcp --workspace docs /absolute/path/to/workspace
```

Repeat `--workspace ALIAS PATH` to expose more than one root. An alias may use letters,
numbers, `.`, `_`, or `-`. It must begin with a letter or number and contain at most
64 characters. Startup normalizes each root and requires distinct canonical
directories. Tool calls cannot supply or change them.

The process speaks newline-delimited MCP JSON-RPC on standard input and standard
output. It reserves standard output for protocol messages. Standard error carries
bounded, sanitary diagnostics:

```bash
vivary-mcp \
  --workspace docs /absolute/path/to/workspace \
  --observability errors
```

`--observability` accepts:

- `off`: no diagnostics
- `errors`: refusal, cancellation, and timeout diagnostics
- `json`: all bounded lifecycle diagnostics

Diagnostics exclude workspace aliases and roots, queries, filters, snippets, and
paths. They also exclude identifiers, arguments, environment values, client identity,
claims, evidence, exceptions, and stack traces. The adapter writes no telemetry, log
file, socket, or network request.

## Tools

All schemas are closed JSON Schema Draft 2020-12 objects. Unknown fields and values
outside the published limits are invalid arguments.

| Tool | Required input | Optional input | Result |
|---|---|---|---|
| `vivary_find` | `workspace`, `question` | `limit`, `budget` | Bounded context selected for a task or question. |
| `vivary_query` | `workspace`, `text` | `limit`, `type_filters`, `path_filters`, `edge_filters`, `snippet_chars`, `explain` | Bounded filtered typed-graph matches. |
| `vivary_check` | `workspace` | `paths`, `strict` | Bounded validation findings without repairs. |
| `vivary_capsule` | `workspace`, `question` | `max_claims` | Privacy-projected public Task Capsule without raw evidence or check execution. |

Every call returns a `vivary.mcp-tool-result/v0` envelope with `known`, `unknown`, or
`refused` status. Every envelope names a workspace only by its configured alias. The
adapter returns exact results whole or refuses them. It does not silently truncate an
oversized result.

## Data and authority boundaries

The adapter can:

- inspect only operator-bound local roots
- invoke fixed, bounded internal Git reads used by the public Tropo/Core contracts
- read candidate bytes only after Core's privacy policy admits their paths
- return bounded public projections

It cannot:

- write, repair, promote memory, execute checks, or persist state
- accept a root, executable, shell command, process, endpoint, or transport from a
  tool caller
- fetch, index, publish, deploy, approve a gate, or call a provider
- return ignored or sensitive names, raw evidence, commands, absolute machine paths,
  credentials, or private content

Cancellation and timeouts reach the active producer and its fixed Git process scope.
Only one producer runs at a time. Concurrent calls refuse instead of creating
unbounded work.

## Passive Doctor report

`create-vivary doctor --json` always includes the optional `interop:mcp` capability.
Doctor reads installed distribution metadata and entry-point declarations only. It
does not import the adapter, start a process, connect to a server, or use the network.

The capability is `not-installed` by default. Compatibility requires the active
interpreter to see the `vivary-mcp` entry point and exact declared `mcp==2.0.0`
dependency. Doctor reports a different SDK version as incompatible rather than
accepting it speculatively.

## Verification

Run the source regressions with the reviewed SDK installed:

```bash
python -m pytest packages/mcp/tests/ -q
```

These tests prove the repository adapter behavior against the pinned SDK. They do not
establish external harness conformance or compatibility with a named MCP client.
