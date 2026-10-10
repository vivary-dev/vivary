// Execute the actual small dependency expressions without starting Nitro.
export const evaluatePluginExpression = (expression, scope) => new Function("scope",
  "const { " + Object.keys(scope).join(", ") + " } = scope; return (" + expression + ");")(scope);
export function pluginObjectAfter(plugin, marker) {
  const offset = plugin.indexOf(marker);
  if (offset < 0) throw new Error("Missing plugin dependency: " + marker);
  const start = plugin.indexOf("{", offset);
  let depth = 0;
  let quoted = null;
  for (let index = start; index < plugin.length; index++) {
    const char = plugin[index];
    if (quoted) {
      if (char === "\\") index++;
      else if (char === quoted) quoted = null;
    } else if (["'", '"', "`"].includes(char)) quoted = char;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return plugin.slice(start, index + 1);
  }
  throw new Error("Incomplete plugin dependency: " + marker);
}
export function backgroundActionsExpression(plugin) {
  const marker = "const getBackgroundActionEntries = ";
  const offset = plugin.indexOf(marker);
  if (offset < 0) throw new Error("Missing background action factory");
  const start = offset + marker.length;
  // Both supported forms terminate at their own top-level semicolon. Bound
  // the scan so an incomplete factory cannot absorb unrelated declarations.
  const limit = Math.min(plugin.length, start + 8192);
  const stack = [];
  let quoted = null;
  let comment = null;
  for (let index = start; index < limit; index++) {
    const char = plugin[index];
    const next = plugin[index + 1];
    if (comment === "line") {
      if (char === "\n") comment = null;
    } else if (comment === "block") {
      if (char === "*" && next === "/") { comment = null; index++; }
    } else if (quoted) {
      if (char === "\\") index++;
      else if (char === quoted) quoted = null;
    } else if (char === "/" && next === "/") { comment = "line"; index++; }
    else if (char === "/" && next === "*") { comment = "block"; index++; }
    else if (["'", '"', "`"].includes(char)) quoted = char;
    else if (["(", "[", "{"].includes(char)) stack.push(char);
    else if ([")", "]", "}"].includes(char)) {
      const expected = { ")": "(", "]": "[", "}": "{" }[char];
      if (stack.pop() !== expected) throw new Error("Unbalanced background action factory");
    } else if (char === ";" && stack.length === 0) return plugin.slice(start, index).trim();
  }
  throw new Error("Background action factory has no bounded terminator");
}
