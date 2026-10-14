import { parse } from "@babel/parser";
import traverseImport from "@babel/traverse";
import generateImport from "@babel/generator";
import * as t from "@babel/types";
import { createHash } from "node:crypto";
const traverse: any = (traverseImport as any).default || traverseImport,
  generate: any = (generateImport as any).default || generateImport;
export function instrumentExecution(
  source: string,
  file: string,
  options: any = {},
) {
  if (Buffer.byteLength(source) > 32 * 1024 * 1024)
    throw Error("Execution instrumentation file exceeds 32 MiB");
  const ast = parse(source, {
    sourceType: "script",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  });
  const hash = createHash("sha256").update(source).digest("hex"),
    fileId = createHash("sha256")
      .update(file + "\0" + hash)
      .digest("hex")
      .slice(0, 12);
  const nodes = new WeakMap<any, string>(),
    frames = new WeakMap<any, any>(),
    generated = new WeakSet<any>();
  const sites: any = {},
    gaps: any[] = [],
    modules = new Set<string>();
  let next = 0,
    root: any,
    api: any,
    scriptFrame: any;
  const skip = (p: any) => {
    for (let q = p; q?.parentPath; q = q.parentPath) {
      if (
        q.parentPath.isFunction() &&
        q.key !== "body" &&
        q.listKey !== undefined &&
        q.listKey === "params"
      )
        return true;
      if (q.parentPath.isFunction() && ["key", "id"].includes(q.key))
        return true;
    }
    if (!options.modules?.length) return false;
    for (let x = p; x; x = x.parentPath)
      if (
        x.isFunction() &&
        x.parentPath?.isCallExpression() &&
        x.parentPath.node.callee?.name === "define" &&
        options.modules.includes(x.parentPath.node.arguments[0]?.value)
      )
        return false;
    return true;
  };
  const site = (n: any, kind: string, extra: any = {}) => {
    let id = nodes.get(n);
    if (!id) {
      id = fileId + ":" + ++next;
      nodes.set(n, id);
      sites[id] = {
        kind,
        file,
        start: n.start,
        end: n.end,
        line: n.loc?.start.line,
        column: (n.loc?.start.column ?? 0) + 1,
        expression: source.slice(n.start, n.end).slice(0, 240),
        ...extra,
      };
    }
    return id;
  };
  const s = (v: any) => t.stringLiteral(v),
    a = (values: any[]) =>
      t.arrayExpression(
        values.map((v) => (v === null ? t.nullLiteral() : s(v))),
      );
  const frame = (p: any) => {
    for (let q = p; q; q = q.parentPath)
      if (q.isFunction() && frames.has(q.node))
        return t.cloneNode(frames.get(q.node));
    return t.cloneNode(scriptFrame);
  };
  const helper = (method: string, args: any[]) => {
    const n = t.callExpression(
      t.memberExpression(t.cloneNode(api), t.identifier(method)),
      args,
    );
    generated.add(n);
    return n;
  };
  const deps = (children: any[]) =>
    a(children.map((n) => (n && nodes.get(n)) || null));
  const ownerFrame = (p: any, name: string) => {
    const b = p.scope.getBinding(name);
    if (!b) return t.cloneNode(scriptFrame);
    return frame(b.scope.path);
  };
  const binding = (p: any, name: string) => {
    const b = p.scope.getBinding(name);
    return b ? fileId + ":binding:" + b.identifier.start : "global:" + name;
  };
  const patternOwner = (p: any) => {
    let q = p;
    while (q.parentPath) {
      const parent = q.parentPath;
      if (
        (parent.isAssignmentExpression() ||
          parent.isForInStatement() ||
          parent.isForOfStatement()) &&
        parent.node.left === q.node
      )
        return parent;
      if (
        (parent.isAssignmentPattern() && parent.node.left === q.node) ||
        parent.isRestElement() ||
        parent.isObjectPattern() ||
        parent.isArrayPattern() ||
        (parent.isObjectProperty() &&
          parent.parentPath.isObjectPattern() &&
          parent.node.value === q.node)
      )
        q = parent;
      else return null;
    }
    return null;
  };
  const wrap = (p: any, n: any, id: string) => {
    nodes.set(n, id);
    p.replaceWith(n);
    p.skip();
  };
  const gap = (p: any, reason: string) => {
    if (gaps.length < 200)
      gaps.push({
        file,
        line: p.node.loc?.start.line,
        column: (p.node.loc?.start.column ?? 0) + 1,
        reason,
      });
  };
  traverse(ast, {
    Program(p: any) {
      root = p;
      api = p.scope.generateUidIdentifier("wxExecution_" + fileId);
      scriptFrame = p.scope.generateUidIdentifier("wxScriptFrame_" + fileId);
    },
    Function(p: any) {
      if (
        p.parentPath?.isCallExpression() &&
        p.parentPath.node.callee?.name === "define" &&
        t.isStringLiteral(p.parentPath.node.arguments[0])
      )
        modules.add(p.parentPath.node.arguments[0].value);
      if (!skip(p))
        frames.set(p.node, p.scope.generateUidIdentifier("wxFrame"));
    },
  });
  traverse(ast, {
    Function: {
      enter(p: any) {
        if (skip(p)) {
          return;
        }
        if (!t.isBlockStatement(p.node.body))
          p.node.body = t.blockStatement([t.returnStatement(p.node.body)]);
      },
      exit(p: any) {
        if (!frames.has(p.node)) return;
        let hasFinally=false;
        p.traverse({Function(q:any){q.skip();},TryStatement(q:any){if(q.node.finalizer) hasFinally=true;}});
        const n = p.node,
          id = site(n, "function", {async:!!n.async,generator:!!n.generator,hasFinally}),
          f = frames.get(n),
          body = n.body.body,
          prologue: any[] = [
            t.variableDeclaration("const", [
              t.variableDeclarator(t.cloneNode(f), helper("enter", [s(id)])),
            ]),
          ];
        n.params.forEach((param: any, index: number) => {
          if (t.isIdentifier(param))
            prologue.push(
              t.expressionStatement(
                helper("parameter", [
                  s(binding(p, param.name)),
                  t.cloneNode(param),
                  t.numericLiteral(index),
                  t.cloneNode(f),
                ]),
              ),
            );
          else
            gap(
              p,
              "destructured/default/rest parameter provenance is incomplete",
            );
        });
        n.body.body = [...prologue, ...body, t.expressionStatement(helper("leave",[t.cloneNode(f)]))];
        if (p.isFunctionExpression() || p.isArrowFunctionExpression()) {
          const parent = p.parentPath;
          const inferred =
            parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)
              ? parent.node.id.name
              : parent.isObjectProperty() && !parent.node.computed
                ? parent.node.key.name || parent.node.key.value
                : parent.isAssignmentExpression() &&
                    t.isIdentifier(parent.node.left)
                  ? parent.node.left.name
                  : "";
          wrap(p, helper("mark", [s(id), n, s(String(inferred || "")), frame(p.parentPath)]), id);
        }
      },
    },
    BlockStatement: {
      exit(p: any) {
        const declarations = p.node.body.filter(
          (n: any) => t.isFunctionDeclaration(n) && n.id && frames.has(n),
        );
        p.node.body.unshift(
          ...declarations.map((n: any) =>
            t.expressionStatement(
              helper("mark", [
                s(site(n, "function", {async:!!n.async,generator:!!n.generator})),
                t.cloneNode(n.id),
                s(""), frame(p),
              ]),
            ),
          ),
        );
      },
    },
    ReferencedIdentifier: {
      exit(p: any) {
        if (
          skip(p) ||
          generated.has(p.node) ||
          p.node.name === api.name ||
          p.node.name === scriptFrame.name
        )
          return;
        const parent = p.parentPath;
        if (
          parent.isUnaryExpression({ operator: "typeof" }) &&
          !p.scope.getBinding(p.node.name)
        )
          return;
        if (
          parent.isCallExpression() &&
          parent.node.callee === p.node &&
          p.node.name === "eval"
        )
          return;
        if (parent.isUpdateExpression() || patternOwner(p)) return;
        const n = p.node,
          id = site(n, "read", { name: n.name });
        wrap(
          p,
          helper("read", [
            s(id),
            t.cloneNode(n),
            s(binding(p, n.name)),
            ownerFrame(p, n.name),
            frame(p),
          ]),
          id,
        );
      },
    },
    MemberExpression: {
      exit(p: any) {
        if (skip(p) || generated.has(p.node)) return;
        const n = p.node,
          parent = p.parentPath;
        const pattern = patternOwner(p);
        if (
          pattern &&
          !(pattern.isAssignmentExpression() && pattern.node.left === n)
        ) {
          const id = site(pattern.node, "pattern-write");
          n.object = helper("base", [s(id), n.object, frame(p)]);
          n.property = helper("key", [
            s(id),
            n.computed ? n.property : s(n.property.name),
            frame(p),
          ]);
          n.computed = true;
          return;
        }
        if (t.isSuper(n.object) || t.isPrivateName(n.property)) {
          gap(
            p,
            "super/private member uses native semantics without member provenance",
          );
          return;
        }
        if (
          ((parent.isForInStatement() || parent.isForOfStatement()) &&
            parent.node.left === n) ||
          (parent.isAssignmentExpression() && parent.node.left === n) ||
          parent.isUpdateExpression() ||
          parent.isUnaryExpression({ operator: "delete" }) ||
          (parent.isCallExpression() && parent.node.callee === n) ||
          (parent.isNewExpression() && parent.node.callee === n)
        )
          return;
        const id = site(n, "get"),
          key = n.computed ? n.property : s(n.property.name);
        wrap(
          p,
          helper("get", [
            s(id),
            n.object,
            key,
            deps([n.object, n.property]),
            frame(p),
          ]),
          id,
        );
      },
    },
    AssignmentExpression: {
      exit(p: any) {
        if (skip(p)) return;
        const n = p.node,
          id = site(n, "write", { operator: n.operator });
        if (t.isIdentifier(n.left)) {
          const name = n.left.name;
          wrap(
            p,
            helper("writeVar", [
              s(id),
              n.operator === "="
                ? n
                : t.sequenceExpression([
                    helper("beforeVar", [
                      s(id),
                      s(binding(p, name)),
                      ownerFrame(p, name),
                      frame(p),
                    ]),
                    n,
                  ]),
              s(binding(p, name)),
              ownerFrame(p, name),
              deps([n.right]),
              frame(p),
            ]),
            id,
          );
          return;
        }
        if (
          t.isMemberExpression(n.left) &&
          !t.isSuper(n.left.object) &&
          !t.isPrivateName(n.left.property)
        ) {
          const l = n.left,
            key = l.computed ? l.property : s(l.property.name),
            body = t.assignmentExpression(
              n.operator,
              t.memberExpression(
                helper("base", [s(id), l.object, frame(p)]),
                helper("key", [s(id), key, frame(p)]),
                true,
              ),
              n.right,
            );
          wrap(
            p,
            helper("put", [
              s(id),
              body,
              deps([n.right]),
              frame(p),
              t.booleanLiteral(n.operator !== "="),
            ]),
            id,
          );
        } else if (t.isObjectPattern(n.left) || t.isArrayPattern(n.left)) {
          wrap(p, helper("pattern", [s(id), n, deps([n.right]), frame(p)]), id);
        } else gap(p, "assignment write provenance unavailable");
      },
    },
    VariableDeclarator: {
      exit(p: any) {
        if (skip(p) || !t.isIdentifier(p.node.id) || !p.node.init) return;
        const n = p.node,
          id = site(n, "declare", { name: n.id.name });
        n.init = helper("writeVar", [
          s(id),
          n.init,
          s(binding(p, n.id.name)),
          ownerFrame(p, n.id.name),
          deps([n.init]),
          frame(p),
        ]);
        nodes.set(n.init, id);
      },
    },
    UpdateExpression: {
      exit(p: any) {
        if (skip(p)) return;
        const n = p.node,
          id = site(n, "update", { operator: n.operator, prefix: n.prefix });
        if (t.isIdentifier(n.argument)) {
          const name = n.argument.name;
          wrap(
            p,
            helper("updateVar", [
              s(id),
              n,
              s(binding(p, name)),
              ownerFrame(p, name),
              frame(p),
            ]),
            id,
          );
        } else if (
          t.isMemberExpression(n.argument) &&
          !t.isSuper(n.argument.object) &&
          !t.isPrivateName(n.argument.property)
        ) {
          const l = n.argument,
            key = l.computed ? l.property : s(l.property.name);
          const body = t.updateExpression(
            n.operator,
            t.memberExpression(
              helper("base", [s(id), l.object, frame(p)]),
              helper("key", [s(id), key, frame(p)]),
              true,
            ),
            n.prefix,
          );
          wrap(
            p,
            helper("put", [
              s(id),
              body,
              a([]),
              frame(p),
              t.booleanLiteral(true),
            ]),
            id,
          );
        } else gap(p, "private/super update not observed");
      },
    },
    "ForInStatement|ForOfStatement": {
      exit(p: any) {
        if (skip(p)) return;
        const id = site(p.node, "pattern-write");
        const record = t.expressionStatement(
          helper("pattern", [
            s(id),
            t.unaryExpression("void", t.numericLiteral(0)),
            a([]),
            frame(p),
          ]),
        );
        if (!t.isBlockStatement(p.node.body))
          p.node.body = t.blockStatement([p.node.body]);
        p.node.body.body.unshift(record);
      },
    },
    UnaryExpression: {
      exit(p: any) {
        if (skip(p)) return;
        const n = p.node,
          id = site(n, "unary", { operator: n.operator });
        if (
          n.operator === "delete" &&
          t.isMemberExpression(n.argument) &&
          !t.isSuper(n.argument.object) &&
          !t.isPrivateName(n.argument.property)
        ) {
          const l = n.argument;
          const body = t.unaryExpression(
            "delete",
            t.memberExpression(
              helper("base", [s(id), l.object, frame(p)]),
              helper("key", [
                s(id),
                l.computed ? l.property : s(l.property.name),
                frame(p),
              ]),
              true,
            ),
          );
          wrap(p, helper("deleted", [s(id), body, frame(p)]), id);
        } else
          wrap(
            p,
            helper("value", [s(id), n, deps([n.argument]), frame(p)]),
            id,
          );
      },
    },
    BinaryExpression: {
      exit(p: any) {
        if (skip(p)) return;
        const n = p.node,
          id = site(n, "binary", { operator: n.operator });
        wrap(
          p,
          helper("value", [s(id), n, deps([n.left, n.right]), frame(p)]),
          id,
        );
      },
    },
    IfStatement: {
      exit(p: any) {
        if (skip(p)) return;
        // Annex-B block function hoisting cannot safely be moved under try/finally.
        let hoisted = false;
        p.traverse({ FunctionDeclaration(q: any) { hoisted = true; q.skip(); } });
        if (hoisted) { gap(p, "if control provenance omitted to preserve block function hoisting"); return; }
        const n = p.node, test = n.test, id = site(n, "branch");
        n.test = helper("branch", [s(id), test, deps([test]), frame(p)]);
        const scoped = (body: any) => t.blockStatement([
          t.expressionStatement(helper("controlEnter", [s(id), frame(p)])),
          t.tryStatement(t.isBlockStatement(body) ? body : t.blockStatement([body]), null,
            t.blockStatement([t.expressionStatement(helper("controlLeave", [s(id), frame(p)]))]))
        ]);
        n.consequent = scoped(n.consequent);
        if (n.alternate) n.alternate = scoped(n.alternate);
      },
    },
    LogicalExpression: {
      exit(p: any) {
        if (skip(p)) return;
        const n = p.node,
          id = site(n, "logical", { operator: n.operator }),
          left = n.left;
        n.left = helper("test", [s(id), left, frame(p)]);
        wrap(
          p,
          helper("logical", [
            s(id),
            n,
            s(n.operator),
            deps([left, n.right]),
            frame(p),
          ]),
          id,
        );
      },
    },
    ConditionalExpression: {
      exit(p: any) {
        if (skip(p)) return;
        const n = p.node,
          id = site(n, "conditional"),
          condition = n.test;
        n.test = helper("test", [s(id), condition, frame(p)]);
        wrap(
          p,
          helper("selected", [
            s(id),
            n,
            deps([condition, n.consequent, n.alternate]),
            frame(p),
          ]),
          id,
        );
      },
    },
    SequenceExpression: {
      exit(p: any) {
        if (skip(p)) return;
        const n = p.node,
          id = site(n, "sequence");
        // A comma expression evaluates every operand, but its value comes
        // only from the last operand. Preserve the native evaluation order.
        wrap(
          p,
          helper("value", [
            s(id),
            n,
            deps([n.expressions[n.expressions.length - 1]]),
            frame(p),
          ]),
          id,
        );
      },
    },
    CallExpression: {
      exit(p: any) {
        if (skip(p) || generated.has(p.node)) return;
        const n = p.node,
          id = site(n, "call");
        if (
          t.isSuper(n.callee) ||
          t.isImport(n.callee) ||
          (t.isIdentifier(n.callee) && n.callee.name === "eval")
        ) {
          gap(p, "direct eval/import/super call internals not instrumented");
          wrap(p, helper("value", [s(id), n, deps(n.arguments), frame(p)]), id);
          return;
        }
        const spreadAt = n.arguments.findIndex((arg: any) =>
          t.isSpreadElement(arg),
        );
        if (spreadAt >= 0)
          gap(
            p,
            "spread iterator kept native; argument provenance after first spread is unknown",
          );
        const args = t.arrayExpression(n.arguments),
          isMethod = t.isMemberExpression(n.callee);
        if (
          isMethod &&
          (t.isSuper(n.callee.object) || t.isPrivateName(n.callee.property))
        ) {
          gap(p, "private/super method kept native");
          return;
        }
        const callee = isMethod
          ? helper("method", [
              n.callee.object,
              n.callee.computed ? n.callee.property : s(n.callee.property.name),
              deps([n.callee.object]),
              frame(p),
            ])
          : helper("fn", [n.callee]);
        wrap(
          p,
          helper("invoke", [
            s(id),
            callee,
            args,
            deps(spreadAt < 0 ? n.arguments : n.arguments.slice(0, spreadAt)),
            frame(p),
            t.booleanLiteral(false),
            t.booleanLiteral(spreadAt >= 0),
          ]),
          id,
        );
      },
    },
    NewExpression: {
      exit(p: any) {
        if (skip(p)) return;
        const n = p.node,
          id = site(n, "construct");
        const spreadAt = n.arguments.findIndex((arg: any) =>
          t.isSpreadElement(arg),
        );
        if (spreadAt >= 0)
          gap(
            p,
            "constructor spread iterator kept native; expanded argument provenance unknown",
          );
        wrap(
          p,
          helper("invoke", [
            s(id),
            helper("fn", [n.callee]),
            t.arrayExpression(n.arguments),
            deps(spreadAt < 0 ? n.arguments : n.arguments.slice(0, spreadAt)),
            frame(p),
            t.booleanLiteral(true),
            t.booleanLiteral(spreadAt >= 0),
          ]),
          id,
        );
      },
    },
    ReturnStatement: {
      exit(p: any) {
        if (skip(p)) return;
        const n = p.node,
          id = site(n, "return");
        n.argument = helper("returned", [
          s(id),
          n.argument || t.unaryExpression("void", t.numericLiteral(0)),
          deps([n.argument]),
          frame(p),
        ]);
      },
    },
    ThrowStatement: {
      exit(p: any) {
        if (skip(p)) return;
        const n = p.node,
          id = site(n, "throw");
        n.argument = helper("value", [
          s(id),
          n.argument,
          deps([n.argument]),
          frame(p),
        ]);
      },
    },
    ObjectExpression: {
      exit(p: any) {
        if (skip(p)) return;
        const n = p.node,
          id = site(n, "object");
        const props = n.properties
          .filter((x: any) => t.isObjectProperty(x) && !x.computed)
          .map((x: any) =>
            t.arrayExpression([
              s(x.key.name ?? String(x.key.value)),
              nodes.get(x.value) ? s(nodes.get(x.value)!) : t.nullLiteral(),
            ]),
          );
        wrap(
          p,
          helper("object", [s(id), n, t.arrayExpression(props), frame(p)]),
          id,
        );
      },
    },
    ArrayExpression: {
      exit(p: any) {
        if (skip(p)) return;
        const n = p.node,
          id = site(n, "array");
        const spreadAt = n.elements.findIndex((item: any) =>
          t.isSpreadElement(item),
        );
        if (spreadAt >= 0)
          gap(
            p,
            "array spread iterator kept native; expanded element provenance unknown",
          );
        wrap(
          p,
          helper("array", [
            s(id),
            n,
            deps(spreadAt < 0 ? n.elements : n.elements.slice(0, spreadAt)),
            frame(p),
            t.booleanLiteral(spreadAt >= 0),
          ]),
          id,
        );
      },
    },
    TemplateLiteral: {
      exit(p: any) {
        if (skip(p) || p.parentPath.isTaggedTemplateExpression()) return;
        const n = p.node,
          id = site(n, "template");
        wrap(p, helper("value", [s(id), n, deps(n.expressions), frame(p)]), id);
      },
    },
    WithStatement(p: any) {
      if (!skip(p)) {
        gap(p, "dynamic with scope kept native");
        p.skip();
      }
    },
    OptionalMemberExpression(p: any) {
      if (!skip(p)) {
        gap(p, "optional chaining subtree kept native");
        p.skip();
      }
    },
    OptionalCallExpression(p: any) {
      if (!skip(p)) {
        gap(p, "optional call subtree kept native");
        p.skip();
      }
    },
  });
  const scriptId = fileId + ":script";
  sites[scriptId] = { kind: "script", file, line: 1, column: 1 };
  const declarations = ast.program.body.filter(
    (n: any) => t.isFunctionDeclaration(n) && n.id && frames.has(n),
  );
  ast.program.body.unshift(
    ...declarations.map((n: any) =>
      t.expressionStatement(
        helper("mark", [s(site(n, "function", {async:!!n.async,generator:!!n.generator})), t.cloneNode(n.id), s("")]),
      ),
    ),
  );
  ast.program.body.unshift(
    t.variableDeclaration("var", [
      t.variableDeclarator(
        api,
        t.memberExpression(
          t.identifier("globalThis"),
          t.identifier("__wxappExecutionV1"),
        ),
      ),
    ]),
    t.expressionStatement(
      helper("register", [t.valueToNode({ fileId, file, hash, sites, gaps })]),
    ),
    t.variableDeclaration("var", [
      t.variableDeclarator(scriptFrame, helper("enter", [s(scriptId)])),
    ]),
  );
  const result = generate(
    ast,
    { sourceMaps: true, sourceFileName: file, comments: true, compact: false },
    source,
  );
  return {
    code:
      result.code +
      "\n//# sourceMappingURL=data:application/json;base64," +
      Buffer.from(JSON.stringify(result.map)).toString("base64"),
    fileId,
    hash,
    sites,
    gaps,
    modules: [...modules],
    instrumentedSites: Object.keys(sites).length,
  };
}
