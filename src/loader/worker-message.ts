import vm from "node:vm";

/** Adopt a message already structured-cloned by the thread port. API bridges
 * wrap functions and copy response data; Worker messages instead retain the
 * cloned graph, including cycles, Map keys and shared backing stores.
 * Never pass an un-cloned host API object to this function.
 */
export function createWorkerMessageAdopter(
  context: vm.Context,
): (message: any) => any {
  return vm.runInContext(
    `((__name) => (${messageAdopter.toString()}))((fn) => fn)`,
    context,
  )();
}

function messageAdopter() {
  // Capture before the base library/app hardens or replaces globals.
  const tagOf = Function.call.bind(Object.prototype.toString) as (
    v: unknown,
  ) => string;
  const setPrototype = Object.setPrototypeOf;
  const descriptors = Object.getOwnPropertyDescriptors;
  const values = Object.values;
  const getPrototype = Object.getPrototypeOf;
  const prototypes = new Map<string, object>();
  for (const name of [
    "Object",
    "Array",
    "Date",
    "RegExp",
    "Map",
    "Set",
    "ArrayBuffer",
    "SharedArrayBuffer",
    "DataView",
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
    "Boolean",
    "Number",
    "String",
    "BigInt",
    "Error",
    "EvalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError",
    "AggregateError",
  ]) {
    const Type = (globalThis as any)[name];
    if (Type) prototypes.set(name, Type.prototype);
  }
  const seenType = WeakSet;
  const mapEntries = Function.call.bind(Map.prototype.entries) as (
    v: unknown,
  ) => Iterable<[any, any]>;
  const setValues = Function.call.bind(Set.prototype.values) as (
    v: unknown,
  ) => Iterable<any>;
  const viewBuffer = Function.call.bind(
    Object.getOwnPropertyDescriptor(DataView.prototype, "buffer")!.get!,
  );
  const typedBuffer = Function.call.bind(
    Object.getOwnPropertyDescriptor(
      getPrototype(Uint8Array.prototype),
      "buffer",
    )!.get!,
  );
  return function adopt(message: any) {
    const seen = new seenType<object>();
    function visit(value: any): any {
      if (!value || typeof value !== "object" || seen.has(value)) return value;
      seen.add(value);
      const tag = tagOf(value).slice(8, -1);
      let kind = tag;
      if (tag === "Error") {
        // Error subtypes all use [object Error]; the port clone has a native
        // prototype, not a user-defined constructor/getter.
        const name = getPrototype(value)?.name;
        if (prototypes.has(name)) kind = name;
      }
      const prototype = prototypes.get(kind);
      if (!prototype) throw Error(`WORKER_MESSAGE_TYPE_UNSUPPORTED: ${tag}`);
      if (tag === "Map")
        for (const [key, item] of mapEntries(value)) {
          visit(key);
          visit(item);
        }
      if (tag === "Set") for (const item of setValues(value)) visit(item);
      if (tag === "DataView") visit(viewBuffer(value));
      else if (tag.endsWith("Array") && tag !== "Array")
        visit(typedBuffer(value));
      // Typed array indices are scalar bytes; enumerating millions of property
      // descriptors would multiply memory consumption without finding edges.
      // Structured clone strips custom properties from built-ins other than
      // plain objects/arrays and the Error cause/aggregate fields.
      if (tag === "Object" || tag === "Array" || tag === "Error")
        for (const descriptor of values(descriptors(value)))
          if ("value" in descriptor) visit(descriptor.value);
      setPrototype(value, prototype);
      return value;
    }
    return visit(message);
  };
}
