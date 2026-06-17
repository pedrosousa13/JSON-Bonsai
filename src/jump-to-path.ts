// Resolves a user-typed JSON path to a node id using the model's pathToId map.
// Accepts exactly the format buildTreeModel emits (`.key`, `["key"]`, `[i]`,
// root = "data"). The leading "data" root is optional and prepended if absent.
export function resolvePathToNodeId(
  input: string,
  pathToId: Map<string, number>
): number | null {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "data") {
    return pathToId.get("data") ?? null;
  }

  let normalized: string;
  if (trimmed === "data" || /^data[.[]/.test(trimmed)) {
    // Already rooted at data (e.g. "data.users", "data[0]").
    normalized = trimmed;
  } else if (trimmed.startsWith("[")) {
    // Root is an array or a quoted key: "[0]..." / '["key"]...'.
    normalized = `data${trimmed}`;
  } else {
    // Identifier-style first segment: "users..." → "data.users...".
    normalized = `data.${trimmed}`;
  }

  return pathToId.get(normalized) ?? null;
}
