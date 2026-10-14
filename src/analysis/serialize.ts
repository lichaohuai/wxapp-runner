/** tsx may add a local naming helper; keep it lexical instead of adding app globals. */
export const vmFunction = (fn: Function) =>
  `((__name)=>(${fn.toString()}))((fn)=>fn)`;
