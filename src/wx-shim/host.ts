import path from "node:path";
import { fileApis } from "./files";
import { storageApi } from "./storage";

/** One owner per logic worker. Main, subpackage and native/plugin calls must
 * not each cache a different snapshot of the same storage file or file grants. */
export function createHostApis(config: any, log: (...args: any[]) => void) {
  const storage = storageApi(config.storageFile);
  const spaces = new Map([[0, storage]]);
  const grants = new Set<string>();
  return {
    storage,
    files: fileApis(config, log, { grants }),
    nativeFiles: fileApis(config, log, { grants, internal: true }),
    storageSpace(id = 0) {
      if (!Number.isSafeInteger(id) || id < 0 || id > 4)
        throw Error("unsupported storage space");
      if (!spaces.has(id))
        spaces.set(
          id,
          storageApi(
            path.join(
              path.dirname(config.storageFile),
              "storage-spaces",
              `${id}.json`,
            ),
          ),
        );
      return spaces.get(id)!;
    },
  };
}
export type HostApis = ReturnType<typeof createHostApis>;
