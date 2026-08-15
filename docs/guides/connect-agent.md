# Connect an agent to Vivary

> **Mixed line.** The AGENTS.md route works on published 0.3.1.
> Optional MCP is unpublished. Pin Doctor with
> `uvx --from create-vivary==0.3.1 create-vivary doctor`.

Use this guide after Vivary creates or adopts a workspace.

## Result

The agent can read bounded project context.
The connection does not grant write authority.

## Agent contract

| Field | Value |
|---|---|
| Goal | Give one agent bounded local context. |
| Required input | Healthy workspace and approved runtime. |
| Default authority | Read public workspace context. |
| Optional authority | Start the local MCP adapter. |
| Prohibited action | Do not enable writes, providers, indexing, or network access. |
| Proof | The agent reads the context route and returns a bounded result. |

## 1. Verify the workspace

Run Doctor before the connection.

```bash
uvx --from create-vivary==0.3.1 create-vivary doctor C:/path/to/project
```

Stop if Doctor reports an error.

## 2. Use the standard agent route

Start the agent in the workspace root.
Tell the agent to read these files in order:

1. `AGENTS.md`
2. `.vivary/context.md`
3. `STATE.md`, only when current state affects the task

Use this instruction:

```text
Read AGENTS.md and .vivary/context.md before work.
Read STATE.md only when current state affects the task.
Retrieve only the evidence that the task needs.
State what is known, inferred, and unknown.
Stop at privacy, authority, destructive, credential, publication, and human gates.
```

This route works without MCP.

## 3. Install MCP only when required

MCP is an optional local adapter.
The normal Vivary installation does not include it.

From a source checkout, install the reviewed local packages together.

```bash
python -m pip install ./packages/core ./packages/tropo ./packages/mcp
```

This command changes the selected Python environment.
Get approval before the installation.

## 4. Bind the workspace at startup

Use an operator-selected alias and an absolute path.

```bash
python packages/mcp/vivary_mcp.py --workspace project C:/path/to/project
```

The process uses local standard input and output.
The process does not open a network service.

Use this generic client configuration:

```json
{
  "mcpServers": {
    "vivary": {
      "command": "python",
      "args": ["C:/path/to/vivary/packages/mcp/vivary_mcp.py", "--workspace", "project", "C:/path/to/project"]
    }
  }
}
```

Put the configuration in the client-owned MCP settings file.
Do not add a client-specific file unless the operator selects that client.

## 5. Check discovery

The client must discover exactly four tools.

| Tool | Result |
|---|---|
| `vivary_find` | Bounded task context. |
| `vivary_query` | Filtered typed matches. |
| `vivary_check` | Validation findings without repair. |
| `vivary_capsule` | Public Task Capsule for later evidence binding. |

Every result has `known`, `unknown`, or `refused` status.
The result identifies the workspace by alias only.

## 6. Confirm the authority boundary

Inspect the workspace tree.
Call one read tool.
Inspect the workspace tree again.
The tool call must create no file.
MCP cannot approve or apply a record.
MCP cannot repair, index, publish, deploy, or call a provider.

Use [Get bounded context](get-context.md) for the first retrieval task.
Use the [MCP reference](../MCP.md) for schemas, limits, diagnostics, and conformance status.
