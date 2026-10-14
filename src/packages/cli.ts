import { callPackages } from "./broker";
(async () => {
  const args = process.argv.slice(2),
    action = args.shift() || "list",
    input: any = { action };
  let configFile: string | undefined;
  try {
    while (args.length) {
      const key = args.shift()!,
        value = args.shift();
      if (!key.startsWith("--") || value === undefined)
        throw Error(
          "Use --keyword NAME, --appid APPID --version N, --job-id ID, or --config FILE",
        );
      if (key === "--config") {
        configFile = value;
        continue;
      }
      const names: Record<string, string> = {
        "--keyword": "keyword",
        "--appid": "appid",
        "--version": "version",
        "--expected-appid": "expectedAppid",
        "--offset": "offset",
        "--job-id": "jobId",
        "--concurrency": "concurrency",
        "--baselib": "baselibDir",
      };
      if (!names[key]) throw Error("Unknown option " + key);
      input[names[key]] = ["--version", "--concurrency"].includes(key)
        ? Number(value)
        : value;
    }
    console.log(
      JSON.stringify(await callPackages(input, { configFile }), null, 2),
    );
  } catch (e: any) {
    console.error(
      JSON.stringify({
        status: "error",
        code: e.code || "PACKAGE_INVALID_REQUEST",
        message: e.message,
      }),
    );
    process.exitCode = 1;
  }
})();
