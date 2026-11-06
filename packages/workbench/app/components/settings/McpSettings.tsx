// The Vivary app serves no MCP endpoint, so Native's setup guides would end in a 404.
export function McpSettings() {
  return (
    <div className="mx-auto w-full max-w-2xl">
      <h2 className="text-lg font-semibold tracking-tight">MCP</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        The Vivary app serves no MCP endpoint, so MCP clients cannot connect to it. The separate vivary-mcp adapter
        offers read-only MCP access to a local workspace.
      </p>
    </div>
  );
}
