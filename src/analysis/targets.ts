import { parseExpressionAt } from "acorn";
export function targetPlan(target: any) {
  if (typeof target !== "string")
    return {
      root: "module",
      module: target.module,
      keys: target.export ? target.export.split(".") : [],
    };
  const ast: any = parseExpressionAt(target, 0, { ecmaVersion: "latest" });
  if (target.slice(ast.end).trim())
    throw Error("Target must be a property path, not arbitrary code");
  const keys: string[] = [];
  let n = ast;
  while (n.type === "MemberExpression" && !n.optional) {
    const k = n.computed ? n.property.value : n.property.name;
    if (!["string", "number"].includes(typeof k))
      throw Error("Only literal member keys are supported");
    keys.unshift(String(k));
    n = n.object;
  }
  let root: string;
  if (
    n.type === "CallExpression" &&
    n.callee.type === "Identifier" &&
    n.callee.name === "getApp" &&
    !n.arguments.length
  )
    root = "app";
  else if (n.type === "Identifier") {
    root = "global";
    keys.unshift(n.name);
  } else
    throw Error(
      "Use getApp().property, a global property path, or a module export",
    );
  if (keys[0] === "globalThis") keys.shift();
  if (!keys.length || keys.some((k) => ["__proto__"].includes(k)))
    throw Error("A concrete function property is required");
  return { root, keys };
}
/** A read-only condition language: no calls, assignments, constructors or getters. */
export function conditionPlan(value?: string) {
  if (!value) return null;
  const ast: any = parseExpressionAt(value, 0, { ecmaVersion: "latest" });
  if (value.slice(ast.end).trim()) throw Error("Invalid condition");
  const visit = (n: any): any => {
    if (
      n.type === "Literal" &&
      ["string", "number", "boolean", "object"].includes(typeof n.value) &&
      !n.regex
    )
      return { type: "literal", value: n.value };
    if (n.type === "Identifier" && ["args", "thisArg", "result"].includes(n.name))
      return { type: "root", name: n.name };
    if (n.type === "MemberExpression" && !n.optional) {
      const key = n.computed ? n.property.value : n.property.name;
      if (!["string", "number"].includes(typeof key))
        throw Error("Condition keys must be literals");
      return { type: "member", object: visit(n.object), key: String(key) };
    }
    if (
      n.type === "UnaryExpression" &&
      ["!", "typeof", "-", "+"].includes(n.operator)
    )
      return { type: "unary", op: n.operator, arg: visit(n.argument) };
    if (
      ["BinaryExpression", "LogicalExpression"].includes(n.type) &&
      [
        "===",
        "!==",
        "==",
        "!=",
        ">",
        ">=",
        "<",
        "<=",
        "&&",
        "||",
        "+",
        "-",
        "*",
        "/",
        "%",
      ].includes(n.operator)
    )
      return {
        type: "binary",
        op: n.operator,
        left: visit(n.left),
        right: visit(n.right),
      };
    throw Error(
      "Condition supports literal comparisons and boolean operators only; function calls and writes are rejected",
    );
  };
  return visit(ast);
}
