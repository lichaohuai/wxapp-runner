import zlib from "node:zlib";
import { promisify } from "node:util";

export class PackageError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "PackageError";
  }
}
export function archivePath(name: string) {
  const relative = name.replace(/^\//, "");
  if (
    !relative ||
    relative.startsWith("/") ||
    /[\\\x00-\x1f\x7f:]/.test(relative) ||
    relative
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  )
    throw new PackageError(
      "UNSAFE_PACKAGE_PATH",
      "Unsafe or non-portable archive path",
    );
  return relative;
}
export function moduleRoot(root: string) {
  return archivePath(root.replace(/^\/+|\/+$/g, ""));
}
export async function decodeArchive(
  raw: Buffer,
  maxBytes = 256 * 1024 * 1024,
): Promise<Buffer> {
  if (raw.length > maxBytes)
    throw new PackageError("PACKAGE_TOO_LARGE", "Package exceeds byte limit");
  if (raw.subarray(0, 6).toString() === "V1MMWX")
    throw new PackageError(
      "ENCRYPTED_DISK_CACHE",
      "Disk cache encryption is not supported; provide CDN plaintext packages",
    );
  if (raw.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) {
    const fn = (zlib as any).zstdDecompress;
    if (!fn)
      throw new PackageError(
        "ZSTD_UNAVAILABLE",
        "Zstd requires Node 22.15+ or the bundled Electron runtime",
      );
    try {
      const plain = (await promisify(fn)(raw, {
        maxOutputLength: maxBytes,
      })) as Buffer;
      if (plain.length < 18 || plain[0] !== 0xbe || plain[13] !== 0xed)
        throw Error("No complete wxapkg header");
      return plain;
    } catch {
      throw new PackageError(
        "INVALID_ZSTD",
        "Invalid or oversized zstd package",
      );
    }
  }
  return raw;
}
export function unpackArchive(bytes: Buffer) {
  if (bytes.length < 18 || bytes[0] !== 0xbe || bytes[13] !== 0xed)
    throw new PackageError(
      "INVALID_WXAPKG",
      "Expected plaintext wxapkg header 0xBE...0xED",
    );
  const indexLength = bytes.readUInt32BE(5),
    bodyLength = bytes.readUInt32BE(9),
    declaredCount = bytes.readUInt32BE(14);
  const end = 14 + indexLength;
  if (
    indexLength < 4 ||
    end > bytes.length ||
    end + bodyLength !== bytes.length
  )
    throw new PackageError("INVALID_WXAPKG", "Invalid index/body boundary");
  let at = 18,
    entries = 0,
    identicalDuplicates = 0;
  const files = new Map<string, Buffer>(),
    names = new Set<string>(),
    directories = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // Read to the independently validated index boundary, not an untrusted count.
  while (at < end) {
    if (entries++ >= 100000 || at + 4 > end)
      throw new PackageError("INVALID_WXAPKG", "Truncated or excessive index");
    const length = bytes.readUInt32BE(at);
    at += 4;
    if (length < 1 || length > 1024 || at + length + 8 > end)
      throw new PackageError("INVALID_WXAPKG", "Invalid index entry");
    let name: string;
    try {
      name = archivePath(decoder.decode(bytes.subarray(at, at + length)));
    } catch (e) {
      if (e instanceof PackageError) throw e;
      throw new PackageError("INVALID_WXAPKG", "Invalid filename encoding");
    }
    at += length;
    const offset = bytes.readUInt32BE(at),
      size = bytes.readUInt32BE(at + 4);
    at += 8;
    if (offset < end || offset + size > bytes.length)
      throw new PackageError(
        "INVALID_WXAPKG",
        "File range outside package body",
      );
    const folded = name.normalize("NFC").toLowerCase();
    if (names.has(folded)) {
      if (files.get(name)?.equals(bytes.subarray(offset, offset + size))) {
        identicalDuplicates++;
        continue;
      }
      throw new PackageError(
        "DUPLICATE_PACKAGE_PATH",
        "Conflicting duplicate or case-colliding archive filename",
      );
    }
    const parts = folded.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (names.has(parent))
        throw new PackageError(
          "PACKAGE_PATH_CONFLICT",
          "Archive file is also a directory",
        );
      directories.add(parent);
    }
    if (directories.has(folded))
      throw new PackageError(
        "PACKAGE_PATH_CONFLICT",
        "Archive directory is also a file",
      );
    names.add(folded);
    files.set(name, bytes.subarray(offset, offset + size));
  }
  if (!files.size)
    throw new PackageError("EMPTY_PACKAGE", "Package contains no files");
  return {
    files,
    warnings: [
      ...(declaredCount === entries
        ? []
        : [
            `fileCount ${declaredCount} differs from validated index entries ${entries}`,
          ]),
      ...(identicalDuplicates
        ? [`${identicalDuplicates} identical duplicate entries deduplicated`]
        : []),
    ],
  };
}
