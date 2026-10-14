import fs from "node:fs";
import path from "node:path";
/** Token registration only. It does not fabricate pre-fetched business data or
 * claim that an OS/background-fetch scheduler ran. The file belongs to the
 * appid/profile's private native state, outside the business file sandbox. */
export class BackgroundFetchToken {
  constructor(private file: string) {}
  set(value: unknown) {
    if (typeof value !== "string" || value.length > 1024)
      throw Error("token must be a string of at most 1024 characters");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify({ token: value }), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    return {};
  }
  get() {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e: any) {
      if (e.code === "ENOENT")
        throw Error("no background fetch token configured");
      throw e;
    }
    if (typeof value.token !== "string")
      throw Error("invalid stored background fetch token");
    return { token: value.token };
  }
}
