import path from "node:path";
import { parse } from "@babel/parser";
import traverseImport from "@babel/traverse";
const traverse:any=(traverseImport as any).default || traverseImport;
const property=(n:any)=>n?.type==='Identifier'?n.name:n?.type==='StringLiteral'?n.value:undefined;
/** Resolve only local named exports of literal strings/arrays/Sets. Every local
 * reference and every importing reference in the scanned source tree must be
 * non-mutating. Namespace exports, re-exports, escaped aliases and dynamic
 * initializers remain unknown. This supplies guard candidates, never support.
 */
export class RunnerImportIndex {
  private files=new Map<string,{program:any;exports:Map<string,any>}>();
  constructor(sources:Map<string,string>) {
    for(const [file,source] of sources) {
      try {
        const ast=parse(source,{sourceType:'unambiguous',plugins:file.endsWith('.ts')?['typescript']:[]});
        let program:any;traverse(ast,{Program(p:any){program=p;p.stop()}});
        const exports=new Map<string,any>();
        for(const statement of program.get('body')) {
          if(!statement.isExportNamedDeclaration() || statement.node.source)continue;
          const declaration=statement.get('declaration');
          if(declaration?.isVariableDeclaration())for(const d of declaration.get('declarations'))
            if(d.node.id.type==='Identifier')exports.set(d.node.id.name,program.scope.getBinding(d.node.id.name));
          for(const s of statement.get('specifiers'))if(s.node.type==='ExportSpecifier')
            exports.set(property(s.node.exported),program.scope.getBinding(property(s.node.local)));
        }
        this.files.set(file,{program,exports});
      }catch{ /* The main file scanner records the actual parse failure. */ }
    }
  }
  private resolve(file:string,from:string) {
    if(!from.startsWith('.'))return;
    const base=path.posix.normalize(path.posix.join(path.posix.dirname(file),from));
    for(const f of [base,base+'.ts',base+'.js',base.replace(/\.js$/,'.ts'),base+'/index.ts',base+'/index.js'])
      if(this.files.has(f))return f;
  }
  private safeReferences(binding:any) {
    if(!binding?.constant)return false;
    return binding.referencePaths.every((p:any)=>{
      if(p.isExportNamedDeclaration())return true;
      const parent=p.parentPath;
      if(parent.isExportSpecifier() || parent.isExportNamedDeclaration())return true;
      if(parent.isSpreadElement() && parent.parentPath.isArrayExpression())return true; // fresh copy
      if(parent.isMemberExpression() && parent.node.object===p.node && !parent.node.computed &&
          ['has','includes','indexOf','slice','concat'].includes(property(parent.node.property))) {
        const use=parent.parentPath;
        return use.isCallExpression() && use.node.callee===parent.node;
      }
      return false;
    });
  }
  read(file:string,from:string,name:string):string|string[]|undefined {
    const target=this.resolve(file,from);if(!target)return;
    const entry=this.files.get(target)!, binding=entry.exports.get(name);
    if(!binding?.constant || !binding.path.isVariableDeclarator())return;
    let init=binding.path.get('init');
    while(init?.node && ['TSAsExpression','TSSatisfiesExpression'].includes(init.node.type))init=init.get('expression');
    if(init?.isStringLiteral())return init.node.value;
    if(!this.safeReferences(binding))return;
    if(init?.isNewExpression() && init.node.callee.name==='Set' && !init.scope.getBinding('Set'))init=init.get('arguments.0');
    if(!init?.isArrayExpression() || !init.node.elements.every((n:any)=>n?.type==='StringLiteral'))return;
    const aliases=new Set([...entry.exports].filter(([,b])=>b===binding).map(([name])=>name));
    for(const [otherFile,other] of this.files)for(const s of other.program.get('body')) {
      if(typeof s.node.source?.value!=='string' || this.resolve(otherFile,s.node.source.value)!==target)continue;
      if(s.isExportAllDeclaration() || s.isExportNamedDeclaration())return; // no proven downstream graph
      if(!s.isImportDeclaration())continue;
      for(const spec of s.get('specifiers')) {
        if(spec.isImportNamespaceSpecifier())return;
        if(spec.isImportSpecifier() && aliases.has(property(spec.node.imported)) &&
            !this.safeReferences(other.program.scope.getBinding(spec.node.local.name)))return;
      }
    }
    return init.node.elements.map((n:any)=>n.value);
  }
}
