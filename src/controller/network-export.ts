import fs from "node:fs";
import path from "node:path";
import { ArtifactStore } from "./artifacts";
import { redact } from "../mcp/redact";
/** An explicitly requested portable directory, including the available body copies. */
export async function exportNetworkSession(
  store: ArtifactStore,
  records: any[],
  identity: { runtimeId: string; sessionId: string },
  destination: string,
  revealSensitive = false,
) {
  if (!path.isAbsolute(destination))
    throw Error("Session destination must be an absolute new directory");
  await fs.promises.mkdir(destination, { mode: 0o700 });
  const ids = new Set<string>();
  const collect = (value: any) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (/artifactId$/i.test(key) && typeof item === "string") ids.add(item);
      else collect(item);
    }
  };
  records.forEach(collect);
  const bodies: any[] = [];
  for (const id of ids) {
    let info: any;
    try {
      info = store.info(id);
    } catch {
      bodies.push({ id, unavailable: "metadata-evicted" });
      continue;
    }
    if (
      info.runtimeId !== identity.runtimeId ||
      info.sessionId !== identity.sessionId
    )
      throw Error("Body belongs to another diagnostic session");
    if (info.evicted) {
      bodies.push({ ...info, unavailable: "evicted" });
      continue;
    }
    const file = id + ".body";
    try {
      if (revealSensitive)
        await fs.promises.copyFile(
          store.get(id).file,
          path.join(destination, file),
          fs.constants.COPYFILE_EXCL,
        );
      else {
        const result: any = store.read(id, 0, Number.MAX_SAFE_INTEGER, false);
        if (result.requiresExplicitRawAccess) {
          bodies.push({ ...info, unavailable: "requires-explicit-raw-access" });
          continue;
        }
        await fs.promises.writeFile(
          path.join(destination, file),
          Buffer.from(result.data, "base64"),
          { mode: 0o600, flag: "wx" },
        );
      }
      bodies.push({
        ...info,
        file,
        redacted: !revealSensitive,
        exportComplete: info.complete && !info.truncated && !info.error,
      });
    } catch (e: any) {
      bodies.push({ ...info, unavailable: e.message });
    }
  }
  const manifest = {
    format: "wxapp-network-session",
    version: 1,
    ...identity,
    exportedAt: new Date().toISOString(),
    redacted: !revealSensitive,
    requests: records,
    bodies,
  };
  await fs.promises.writeFile(
    path.join(destination, "session.json"),
    JSON.stringify(revealSensitive ? manifest : redact(manifest), null, 2),
    { mode: 0o600, flag: "wx" },
  );
  return {
    destination,
    manifest: path.join(destination, "session.json"),
    requestCount: records.length,
    bodyCount: bodies.filter((b) => b.file).length,
    incompleteBodies: bodies.filter((b) => !b.exportComplete).length,
    redacted: !revealSensitive,
    ...identity,
  };
}
