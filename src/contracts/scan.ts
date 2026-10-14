import { digest } from "./fingerprint";
import { parse } from "@babel/parser";
import traverseImport from "@babel/traverse";
import { contractId, type Layer, type Location } from "./model";
const traverse: any = (traverseImport as any).default || traverseImport;
export function layerFor(file: string): Layer {
  if (/Worker/i.test(file)) return "worker";
  if (/Webview|WebView|RenderContext/i.test(file)) return "view";
  if (/Service|SubContext|MainContext|WACloud/.test(file)) return "logic";
  if (/WAPCAdapterAppIndex/.test(file)) return "host";
  return "shared";
}
const key = (n: any): string | undefined => n?.type === "StringLiteral" ? n.value : n?.type === "Identifier" ? n.name : undefined;
type ResolveImport = (source: string, name: string) => string | string[] | undefined;
const literal = (p: any, seen = new Set<any>(), imports?: ResolveImport): any => {
  if (!p?.node || seen.has(p.node)) return;
  seen.add(p.node);
  const n = p.node;
  if (n.type === "StringLiteral") return n.value;
  if (n.type === "ArrayExpression") {
    const values: string[] = [];
    for (const element of p.get("elements")) {
      const spread=element.node?.type === "SpreadElement";
      const value=literal(spread ? element.get("argument") : element, new Set(seen), imports);
      if(spread ? !Array.isArray(value) : typeof value !== "string") return;
      values.push(...(spread ? value : [value]));
    }
    return values;
  }
  if (n.type === "NewExpression" && n.callee.name === "Set" && !p.scope.getBinding("Set")) return literal(p.get("arguments.0"), seen, imports);
  if (n.type !== "Identifier") return;
  const binding = p.scope.getBinding(n.name);
  if(binding?.constant && binding.path.isImportSpecifier?.())
    return imports?.(binding.path.parentPath.node.source.value,key(binding.path.node.imported)!);
  if (!binding?.constant || binding.path.type !== "VariableDeclarator") return;
  const value=literal(binding.path.get("init"), seen, imports);
  if(Array.isArray(value) && binding.referencePaths.some((ref:any)=>{
    const parent=ref.parentPath;
    if(parent.isSpreadElement() && parent.parentPath.isArrayExpression()) return false;
    if(parent.isObjectProperty() && parent.node.value===ref.node && key(parent.node.key)==="APIList") return false;
    if(parent.isMemberExpression() && parent.node.object===ref.node && !parent.node.computed) {
      const member=parent.node.property.name, use=parent.parentPath;
      if(["includes","has","concat","indexOf","slice"].includes(member) && use.isCallExpression() && use.node.callee===parent.node) return false;
    }
    return true; // Mutation, alias escape or unproven consumer.
  })) return;
  return value;
};
function bridgeName(p: any, seen = new Set<any>()): string | undefined {
  if (!p?.node || seen.has(p.node)) return;
  seen.add(p.node);
  const n = p.node;
  if (n.type === "Identifier") {
    const b = p.scope.getBinding(n.name);
    if (!b && ["WeixinJSBridge","WeixinJSCore"].includes(n.name)) return n.name;
    if (b?.constant && b.path.type === "VariableDeclarator") return bridgeName(b.path.get("init"),seen);
  }
  if (n.type === "MemberExpression") {
    const name = n.computed ? literal(p.get("property")) : key(n.property);
    const object = n.object;
    if (object.type === "Identifier" && ["globalThis","window","self"].includes(object.name) &&
        !p.scope.getBinding(object.name) && ["WeixinJSBridge","WeixinJSCore"].includes(name)) return name;
  }
}
export function scanSource(source: string, file: string, layer: Layer, owner: "official" | "runner", imports?: ResolveImport) {
  const readLiteral = (p:any) => literal(p,new Set(),imports);
  const sha256 = digest(source);
  const at = (n: any): Location => ({file,sha256,offset:n.start,line:n.loc.start.line,column:n.loc.start.column});
  const records: any[] = [], unresolved: any[] = [];
  const ast = parse(source, {sourceType:"unambiguous", allowReturnOutsideFunction:true,
    plugins: file.endsWith(".ts") ? ["typescript"] : []});
  const unknown = (p: any, reason: string, candidateApi?: string) => unresolved.push({
    id: `${file}:${p.node.start}`, reason, location:at(p.node), ...(candidateApi ? {candidateApi} : {}),
  });
  const addGuard = (api: string, p: any) => {
    if (!/^[A-Za-z_$][\w.$:-]{0,159}$/.test(api)) return;
    records.push({id:contractId(layer,"invoke",api),api,layer,channel:"invoke",kind:"runner-name-guard",location:at(p.node)});
  };
  const isDispatchName = (p: any) => {
    if (p.node?.type !== "Identifier") return false;
    const b=p.scope.getBinding(p.node.name);
    return ["n","name","api","method"].includes(p.node.name) && b?.kind === "param";
  };
  // A rest-only forwarding function is resolvable without executing any code.
  const forwardedBridge = (p: any) => {
    if (p?.node?.type !== "Identifier") return;
    const b=p.scope.getBinding(p.node.name);
    if(!b?.constant) return;
    const fn=b?.path.isFunctionDeclaration?.() ? b.path : b?.constant && b.path.type === "VariableDeclarator" ? b.path.get("init") : undefined;
    if (!fn?.isFunction?.() || fn.node.params.length!==1 || fn.node.params[0].type!=="RestElement") return;
    let statement=fn.get("body");
    if(statement.node.type==="BlockStatement") {
      if(statement.node.body.length!==1) return;
      statement=statement.get("body.0");
      statement=statement.get(statement.node.type==="ReturnStatement" ? "argument" : "expression");
    }
    if(statement?.node?.type!=="CallExpression" || statement.node.arguments.length!==1) return;
    const arg=statement.get("arguments.0");
    if(arg.node.type!=="SpreadElement" || arg.node.argument.name!==fn.node.params[0].argument.name) return;
    const member=statement.get("callee");
    if(member.node.type!=="MemberExpression" || !bridgeName(member.get("object"))) return;
    return key(member.node.property);
  };
  traverse(ast, {
    ObjectProperty(p: any) {
      if(owner!=="official" || layer!=="worker" || p.node.computed || key(p.node.key)!=="APIList") return;
      const names=readLiteral(p.get("value"));
      if(!Array.isArray(names)) {unknown(p,"Dynamic Worker APIList extension");return;}
      for(const api of names) records.push({id:contractId("worker","invoke",api),api,layer:"worker",channel:"invoke",kind:"worker-APIList-declaration",location:at(p.node),mode:"allowlisted; call/return semantics unresolved"});
    },
    BinaryExpression(p: any) {
      if (owner !== "runner" || !["===","!=="].includes(p.node.operator)) return;
      for (const [a,b] of [["left","right"],["right","left"]]) {
        const value=readLiteral(p.get(a));
        if (typeof value === "string" && isDispatchName(p.get(b))) addGuard(value,p);
      }
    },
    SwitchCase(p: any) {
      if (owner !== "runner" || !isDispatchName(p.parentPath.get("discriminant"))) return;
      const value=readLiteral(p.get("test")); if (typeof value === "string") addGuard(value,p);
    },
    CallExpression(p: any) {
      const callee = p.get("callee");
      const forwarded=owner==="official" && forwardedBridge(callee);
      if (!forwarded && callee.node.type !== "MemberExpression" && callee.node.type !== "OptionalMemberExpression") return;
      const method = forwarded || (callee.node.computed ? readLiteral(callee.get("property")) : key(callee.node.property));
      if (owner === "runner") {
        if (!["includes","has"].includes(method) || !isDispatchName(p.get("arguments.0"))) return;
        const names = readLiteral(callee.get("object"));
        if (Array.isArray(names)) names.forEach(name=>addGuard(name,p));
        else unknown(p,"Dynamic/imported dispatch set; not counted as absent support");
        return;
      }
      if (!["invoke","invokeSync","invokeHandler","subscribe","subscribeHandler","publish","publishHandler"].includes(method)) return;
      const bridge=forwarded || bridgeName(callee.get("object"));
      const api=readLiteral(p.get("arguments.0"));
      if (!bridge) { unknown(p,"Unresolved bridge receiver; candidate is not a confirmed native call", typeof api === "string" ? api : undefined); return; }
      if (typeof api !== "string") {
        const name=p.get("arguments.0");
        if(name?.node?.type==="ConditionalExpression") {
          const names=[readLiteral(name.get("consequent")),readLiteral(name.get("alternate"))];
          if(names.every(v=>typeof v==="string")) {
            for(const api of new Set(names)) {const channel=/invoke/.test(method)?"invoke":"event";
              records.push({id:contractId(layer,channel,api),api,layer,channel,kind:"conditional-confirmed-bridge-call",location:at(p.node),mode:method+"; branch condition unresolved"});}
            unknown(name,"Conditional native call; both literal alternatives indexed, condition not evaluated");return;
          }
        }
        unknown(p,"Dynamic native/event name at confirmed bridge"); return;
      }
      const channel = /invoke/.test(method) ? "invoke" : "event";
      let argument=p.get("arguments.1");
      if(argument?.node?.type === "CallExpression" && argument.node.callee?.object?.name === "JSON" && argument.node.callee?.property?.name === "stringify" && !argument.scope.getBinding("JSON")) argument=argument.get("arguments.0");
      const requestFields = argument?.node?.type === "ObjectExpression" ? argument.node.properties.filter((n:any)=>n.type === "ObjectProperty" && !n.computed).map((n:any)=>key(n.key)).filter(Boolean) : [];
      const callbackFields = new Set<string>();
      for (const cb of p.get("arguments").slice(2)) {
        if (!cb.isFunction?.() || cb.node.params[0]?.type !== "Identifier") continue;
        const binding=cb.scope.getBinding(cb.node.params[0].name);
        for(const reference of binding?.referencePaths || []) {
          const member=reference.parentPath;
          if(member.node.type === "MemberExpression" && member.node.object === reference.node && !member.node.computed) callbackFields.add(member.node.property.name);
        }
      }
      records.push({id:contractId(layer,channel,api),api,layer,channel,kind:"confirmed-bridge-call",location:at(p.node),
        mode:method,requestFields:[...new Set(requestFields)],callbackFields:[...callbackFields]});
    },
  });
  return {records,unresolved};
}
