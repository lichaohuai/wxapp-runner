import { failure, type Options } from "./common";
/** Keep optional capability discovery and event registration safe without reporting success. */
export function unsupported(name: string, log: Function) {
  return (o: Options = {}) => {
    log("UNIMPLEMENTED: wx." + name);
    if (o && typeof o === "object")
      queueMicrotask(() => failure(name, o, Error("not implemented")));
    if (name.startsWith("create")) {
      let object: any;
      object = new Proxy(
        {},
        {
          get(_t, method: any) {
            if (method === Symbol.toStringTag) return "WxappUnsupportedAPI";
            if (method === "then") return undefined;
            return (...args: any[]) => {
              log("UNIMPLEMENTED: wx." + name + "." + String(method));
              if (["show", "load", "play"].includes(method))
                return Promise.reject({
                  errMsg: name + "." + method + ":fail not implemented",
                });
              return object;
            };
          },
        },
      );
      return object;
    }
  };
}
