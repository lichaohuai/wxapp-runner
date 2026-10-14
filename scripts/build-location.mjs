import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export function buildLocation() {
  if (process.platform !== "darwin") return;
  const source = "native/location/main.swift",
    plist = "native/location/Info.plist";
  const bundle = "dist/native/WxappRunner Location.app";
  const contents = path.join(bundle, "Contents");
  const binary = path.join(contents, "MacOS/wxapp-location");
  const hash = createHash("sha256")
    .update(process.arch)
    .update(fs.readFileSync(source))
    .update(fs.readFileSync(plist))
    .digest("hex");
  const stamp = "dist/native/location-build.txt";
  if (
    fs.existsSync(binary) &&
    fs.existsSync(stamp) &&
    fs.readFileSync(stamp, "utf8") === hash
  )
    return;
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.copyFileSync(plist, path.join(contents, "Info.plist"));
  try {
    execFileSync(
      "xcrun",
      [
        "swiftc",
        "-swift-version",
        "5",
        "-O",
        source,
        "-o",
        binary,
        "-framework",
        "AppKit",
        "-framework",
        "CoreLocation",
      ],
      { stdio: "inherit" },
    );
    execFileSync(
      "codesign",
      [
        "--force",
        "--sign",
        "-",
        "--identifier",
        "cc.wxapprunner.location",
        bundle,
      ],
      { stdio: "inherit" },
    );
  } catch (e) {
    throw new Error(
      "macOS location helper build failed. Install Xcode Command Line Tools (xcode-select --install).",
      { cause: e },
    );
  }
  fs.writeFileSync(stamp, hash);
}
