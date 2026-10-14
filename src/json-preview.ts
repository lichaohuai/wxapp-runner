/** A display-only JSON decoder. Never use this to transform business responses. */
export function decodeJsonPreview(
  text: string,
  options: Partial<{
    inputBytes: number;
    parseBytes: number;
    nodes: number;
    depth: number;
    stringLayers: number;
  }> = {},
) {
  const budget = {
    inputBytes: 256 * 1024,
    parseBytes: 1024 * 1024,
    nodes: 10000,
    depth: 24,
    stringLayers: 8,
    ...options,
  };
  const limits = new Set<string>();
  const paths: { path: string; layers: number }[] = [];
  const encoder = new TextEncoder();
  let nodes = 0,
    parsedBytes = 0;
  const size = encoder.encode(text).byteLength;
  const result = (isJson: boolean, value?: unknown) => ({
    isJson,
    value,
    decoding: {
      changed: paths.length > 0,
      paths,
      complete: limits.size === 0,
      limits: [...limits],
      inputBytes: size,
      parsedBytes,
      visitedNodes: nodes,
      budget,
      basis: "JSON strings containing objects or arrays; display only",
    },
  });
  if (size > budget.inputBytes) {
    limits.add("inputBytes");
    return result(false);
  }
  function parse(value: string) {
    const bytes = encoder.encode(value).byteLength;
    if (parsedBytes + bytes > budget.parseBytes) {
      limits.add("parseBytes");
      throw Error("JSON preview parse budget reached");
    }
    parsedBytes += bytes;
    return JSON.parse(value);
  }
  let original: unknown;
  try {
    original = parse(text);
  } catch {
    return result(false);
  }
  function walk(value: any, path: string, depth: number): any {
    if (nodes >= budget.nodes) {
      limits.add("nodes");
      return value;
    }
    if (depth > budget.depth) {
      limits.add("depth");
      return value;
    }
    nodes++;
    if (typeof value === "string") {
      let candidate: any = value,
        layers = 0;
      // Decode quoted strings only if the entire chain ends in an object or
      // array. IDs, numbers, booleans and ordinary quoted text stay strings.
      while (typeof candidate === "string" && /^[\s]*[\[{\"]/.test(candidate)) {
        if (layers >= budget.stringLayers) {
          limits.add("stringLayers");
          break;
        }
        try {
          candidate = parse(candidate);
          layers++;
        } catch {
          break;
        }
      }
      if (candidate !== null && typeof candidate === "object") {
        paths.push({ path, layers });
        return walk(candidate, path, depth + 1);
      }
      return value;
    }
    if (Array.isArray(value))
      return value.map((item, i) => walk(item, `${path}/${i}`, depth + 1));
    if (value !== null && typeof value === "object")
      // fromEntries defines own data properties, including __proto__, without
      // invoking setters on Object.prototype. Input comes only from JSON.parse.
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          walk(
            item,
            path + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1"),
            depth + 1,
          ),
        ]),
      );
    return value;
  }
  return result(true, walk(original, "", 0));
}
