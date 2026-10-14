import { parseExpression } from "@babel/parser";
import traverseImport from "@babel/traverse";
import generateImport from "@babel/generator";
import * as t from "@babel/types";
import { createHash } from "node:crypto";
const traverse: any = (traverseImport as any).default || traverseImport,
  generate: any = (generateImport as any).default || generateImport;
/** Static-only, no eval of package code. Rewrites a proven subset, preserving an audit per pass. */
export function readableModule(
  source: string,
  meta: any = {},
  formatOnly = false,
) {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  // A debugging tool must never hard-crash on hostile input. When static
  // analysis cannot proceed we return the original source untouched plus a
  // structured `diagnostic`, so the caller gets a clear reason (and a pointer
  // to the dynamic tools) instead of a DEBUG_ERROR.
  const fallback = (code: string, reason: string) => ({
    source,
    map: null,
    passes: [] as any[],
    originalSha256: sha(source),
    transformedSha256: sha(source),
    skipped: [] as any[],
    execution: "static-only; business code was not evaluated",
    generalizedDeobfuscation: false,
    diagnostic: { code, reason },
  });
  // Control-flow virtualization (e.g. Tencent 图灵盾/CHAOS VM) compiles the
  // logic into bytecode run by an interpreter loop. It cannot be recovered
  // statically and its deeply-nested expression tree overflows the recursive
  // Babel parser/traverser — short-circuit before we ever touch it.
  if (/__TENCENT_CHAOS_VM|__CHAOS_VM\b|_chaos_vm/i.test(source))
    return fallback(
      "VMP_DETECTED",
      "Factory is protected by a Tencent CHAOS virtual machine (bytecode interpreter); static deobfuscation cannot recover the original logic. Use dynamic tools instead: runner_crypto_watch (observe the crypto it calls), runner_hook, runner_autopsy or runner_oracle.",
    );
  // Guard against pathological size: the recursive descent parse + traverse +
  // generate risk a stack overflow on very large single-expression factories.
  const MAX_CHARS = 400_000;
  if (source.length > MAX_CHARS)
    return fallback(
      "DEOBFUSCATE_TOO_LARGE",
      `Factory is ${source.length} chars (> ${MAX_CHARS}); static deobfuscation is skipped to avoid a stack overflow. Read it in slices with action:"get", or use dynamic tools.`,
    );
  try {
    const expr = parseExpression(source, {
      sourceType: "script",
      startLine: meta.line || 1,
      startColumn: (meta.column || 1) - 1,
    });
    const ast = t.file(t.program([t.expressionStatement(expr)]));
    const changes: any[] = [],
      skipped: any[] = [];
    const note = (p: any, pass: string) =>
      changes.push({
        pass,
        line: p.node.loc?.start.line,
        column: (p.node.loc?.start.column || 0) + 1,
      });
    const literal = (n: any): any =>
      t.isStringLiteral(n) ||
      t.isBooleanLiteral(n) ||
      t.isNullLiteral(n) ||
      (t.isNumericLiteral(n) && Number.isFinite(n.value));
    const val = (n: any): any => (t.isNullLiteral(n) ? null : n.value);
    const fold = (n: any): any => {
      if (t.isUnaryExpression(n) && literal(n.argument)) {
        const x = val(n.argument);
        switch (n.operator) {
          case "!":
            return !x;
          case "+":
            return +x;
          case "-":
            return -x;
          case "~":
            return ~x;
          case "typeof":
            return typeof x;
        }
      }
      if (t.isBinaryExpression(n) && literal(n.left) && literal(n.right)) {
        const x = val(n.left),
          y = val(n.right);
        switch (n.operator) {
          case "+":
            return x + y;
          case "-":
            return x - y;
          case "*":
            return x * y;
          case "/":
            return x / y;
          case "%":
            return x % y;
          case "^":
            return x ^ y;
          case "|":
            return x | y;
          case "&":
            return x & y;
          case "<<":
            return x << y;
          case ">>":
            return x >> y;
          case ">>>":
            return x >>> y;
          case "===":
            return x === y;
          case "!==":
            return x !== y;
          case "<":
            return x < y;
          case ">":
            return x > y;
        }
      }
      return undefined;
    };
    let dynamicScope = false;
    t.traverseFast(ast, (n) => {
      if (
        t.isWithStatement(n) ||
        (t.isCallExpression(n) && t.isIdentifier(n.callee, { name: "eval" }))
      )
        dynamicScope = true;
    });
    if (!formatOnly && !dynamicScope)
      for (let round = 0; round < 3; round++)
        traverse(ast, {
          MemberExpression: {
            exit(p: any) {
              const n = p.node;
              if (
                !t.isIdentifier(n.object) ||
                !n.computed ||
                !t.isNumericLiteral(n.property) ||
                !Number.isInteger(n.property.value)
              )
                return;
              const b = p.scope.getBinding(n.object.name);
              if (
                b &&
                (b.path.getFunctionParent() !== p.getFunctionParent() ||
                  (p.node.start ?? 0) < (b.path.node.end ?? 0))
              )
                return;
              if (
                !b?.constant ||
                !b.path.isVariableDeclarator() ||
                !t.isArrayExpression(b.path.node.init)
              )
                return;
              if (
                b.referencePaths.some(
                  (r: any) =>
                    !r.parentPath.isMemberExpression() ||
                    r.parentPath.node.object !== r.node ||
                    !r.parentPath.node.computed ||
                    !t.isNumericLiteral(r.parentPath.node.property) ||
                    (r.parentPath.parentPath.isAssignmentExpression() &&
                      r.parentPath.parentPath.node.left === r.parentPath.node) ||
                    r.parentPath.parentPath.isUpdateExpression() ||
                    r.parentPath.parentPath.isUnaryExpression({
                      operator: "delete",
                    }),
                )
              )
                return;
              const declaration = b.path.getStatementParent(),
                statement = p.getStatementParent();
              if (
                declaration.parentPath.node !== statement.parentPath.node ||
                declaration.key >= statement.key
              )
                return;
              const elements = b.path.node.init.elements;
              if (!elements.every(literal)) return;
              const value = elements[n.property.value];
              if (!value) return;
              note(p, "literal-table-inline");
              p.replaceWith(t.cloneNode(value));
            },
          },
          "BinaryExpression|UnaryExpression": {
            exit(p: any) {
              const v = fold(p.node);
              if (
                v === undefined ||
                (typeof v === "number" &&
                  (!Number.isFinite(v) || Object.is(v, -0)))
              )
                return;
              const replacement = t.valueToNode(v);
              // t.valueToNode renders a finite negative number as
              // UnaryExpression("-", NumericLiteral(|v|)) — the exact shape we
              // just folded from a "-<num>" node. p.replaceWith requeues the
              // path, so swapping a node for a structurally identical one makes
              // this visitor re-fold it forever and blow the JS stack (verified:
              // even a bare "-1" overflows after ~6200 fires — it is the
              // presence of any negative literal, not tree depth). Skip a
              // structural no-op; every genuine fold (1+2*3->7, ~4->-5, 2-7->-5,
              // -"5"->-5, !0->true) still fires.
              if (t.isNodesEquivalent(replacement, p.node)) return;
              note(p, "constant-fold");
              p.replaceWith(replacement);
            },
          },
          ConditionalExpression: {
            exit(p: any) {
              if (!literal(p.node.test)) return;
              note(p, "constant-branch");
              p.replaceWith(
                val(p.node.test) ? p.node.consequent : p.node.alternate,
              );
            },
          },
          IfStatement: {
            exit(p: any) {
              if (!literal(p.node.test)) return;
              const dead = val(p.node.test)
                ? p.node.alternate
                : p.node.consequent;
              let hoists = false;
              if (dead)
                t.traverseFast(dead, (n) => {
                  if (
                    t.isVariableDeclaration(n, { kind: "var" }) ||
                    t.isFunctionDeclaration(n)
                  )
                    hoists = true;
                });
              if (hoists) return;
              note(p, "dead-branch");
              p.replaceWith(
                (val(p.node.test) ? p.node.consequent : p.node.alternate) ||
                  t.emptyStatement(),
              );
            },
          },
          WhileStatement: {
            exit(p: any) {
              // A closed, literal switch dispatcher with no default, nested loops or lexical declarations.
              const n = p.node;
              if (
                !t.isBooleanLiteral(n.test, { value: true }) ||
                !t.isBlockStatement(n.body) ||
                n.body.body.length !== 2 ||
                !t.isSwitchStatement(n.body.body[0]) ||
                !t.isBreakStatement(n.body.body[1])
              )
                return;
              const sw = n.body.body[0],
                d = sw.discriminant;
              if (
                !t.isMemberExpression(d) ||
                !d.computed ||
                !t.isIdentifier(d.object) ||
                !t.isUpdateExpression(d.property, {
                  operator: "++",
                  prefix: false,
                }) ||
                !t.isIdentifier(d.property.argument)
              )
                return;
              const table = p.scope.getBinding(d.object.name),
                index = p.scope.getBinding(d.property.argument.name);
              if (
                !table?.constant ||
                table.referencePaths.length !== 1 ||
                !table.path.isVariableDeclarator() ||
                !t.isArrayExpression(table.path.node.init) ||
                !index?.path.isVariableDeclarator() ||
                !t.isNumericLiteral(index.path.node.init, { value: 0 }) ||
                index.referencePaths.some(
                  (r: any) => r.node !== (d.property as any).argument,
                ) ||
                index.constantViolations.some((r: any) => r.node !== d.property)
              )
                return;
              const order = table.path.node.init.elements;
              if (
                !order.every(
                  (x) => t.isStringLiteral(x) || t.isNumericLiteral(x),
                )
              )
                return;
              const branches = sw.cases;
              if (branches.some((c) => !c.test || !literal(c.test))) return;
              const body: any[] = [];
              for (const item of order) {
                const found = branches.find((c) => val(c.test) === val(item));
                if (
                  !found ||
                  !t.isContinueStatement(found.consequent.at(-1)) ||
                  (found.consequent.at(-1) as any)?.label
                )
                  return;
                let unsafe = false;
                for (const st of found.consequent.slice(0, -1))
                  t.traverseFast(st, (x) => {
                    if (
                      t.isBreakStatement(x) ||
                      t.isContinueStatement(x) ||
                      t.isReturnStatement(x) ||
                      t.isThrowStatement(x) ||
                      t.isFunction(x) ||
                      (t.isVariableDeclaration(x) && x.kind !== "var")
                    )
                      unsafe = true;
                  });
                if (unsafe) return;
                body.push(
                  ...found.consequent
                    .slice(0, -1)
                    .map((x) => t.cloneNode(x, true)),
                );
              }
              if (branches.some((c) => c.test && val(c.test) === undefined))
                return;
              note(p, "literal-switch-dispatch");
              body.push(
                t.expressionStatement(
                  t.assignmentExpression(
                    "=",
                    t.cloneNode(d.property.argument),
                    t.numericLiteral(order.length + 1),
                  ),
                ),
              );
              p.replaceWith(t.blockStatement(body));
            },
          },
        });
    const out = generate(
      ast,
      {
        sourceMaps: true,
        sourceFileName: meta.file || "module.js",
        comments: true,
      },
      source,
    );
    return {
      source: out.code,
      map: out.map,
      passes: changes,
      originalSha256: sha(source),
      transformedSha256: sha(out.code),
      skipped,
      execution: "static-only; business code was not evaluated",
      generalizedDeobfuscation: false,
    };
  } catch (e: any) {
    const overflow =
      e instanceof RangeError || /call stack/i.test(String(e?.message));
    return fallback(
      overflow ? "DEOBFUSCATE_STACK_OVERFLOW" : "DEOBFUSCATE_FAILED",
      (overflow
        ? "Static deobfuscation exceeded the call stack while rewriting this factory. "
        : "Static deobfuscation failed: ") +
        String(e?.message || e) +
        ". The original factory is returned unchanged; use dynamic tools (runner_crypto_watch / runner_hook / runner_autopsy) to recover behavior.",
    );
  }
}
