import fs from "node:fs";
import { AnalysisTools } from "../analysis/tools";
import { requiredAnalysisProtocol } from "../analysis/protocol";
import { projectRows } from "../analysis/projection";
import { callPackages } from "../packages/broker";
import { callLaunch } from "../launch";
import { randomUUID } from "node:crypto";
import { identitySchema } from "./extended-tools";
const clientId = randomUUID();
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { toolDefinitions, parseTool } from "./tools";
const fileIndex = process.argv.indexOf("--connection");
const connectionFile = process.argv[fileIndex + 1];
if (fileIndex < 0 || !connectionFile)
  throw Error(
    "Usage: node dist/mcp.cjs --connection /absolute/path/to/connection.json",
  );
const server = new Server(
  { name: "wxapp-runner", version: "0.2.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(toolDefinitions).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: z.toJSONSchema(z.intersection(tool.schema, identitySchema), {
      io: "input",
    }) as any,
    annotations: {
      readOnlyHint: tool.readOnly,
      destructiveHint: !tool.readOnly,
      openWorldHint: !tool.readOnly,
    },
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    const args = parseTool(request.params.name, request.params.arguments);
    const configIndex = process.argv.indexOf("--package-config");
    const packageConfig =
      configIndex < 0 ? undefined : process.argv[configIndex + 1];
    if (request.params.name === "runner_packages") {
      const result = await callPackages(
        args,
        { configFile: packageConfig },
        extra.signal,
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    // Starting an instance cannot go through the connection: there is no
    // instance to talk to until this call has created one.
    if (request.params.name === "runner_launch") {
      const result = await callLaunch(
        args,
        { connectionFile, configFile: packageConfig },
        extra.signal,
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    const remote = async (
      name: string,
      args: any,
      signal: AbortSignal = extra.signal,
    ) => {
      let connection: any;
      try {
        connection = JSON.parse(fs.readFileSync(connectionFile, "utf8"));
      } catch (e: any) {
        // A missing/half-written connection file means the app instance has
        // exited (or was never launched). Surface an actionable message instead
        // of a raw ENOENT, and point at the recovery path.
        throw Object.assign(
          Error(
            e?.code === "ENOENT"
              ? `No running WxappRunner instance: connection file ${connectionFile} is missing — the mini-program app has exited or was never launched. Start one with runner_launch {"action":"launch","appid":"wx…","version":N}.`
              : `Cannot read connection file ${connectionFile}: ${e?.message}`,
          ),
          { code: "NO_INSTANCE" },
        );
      }
      const url = new URL(connection.endpoint);
      if (
        url.hostname !== "127.0.0.1" ||
        url.protocol !== "http:" ||
        url.username ||
        url.password
      )
        throw Error("Connection must be a local WxappRunner instance");
      const response = await fetch(new URL("/call", url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: name,
          arguments: args,
          clientId,
        }),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(name === "runner_wait" ? 65000 : 35000),
        ]),
        redirect: "error",
      });
      const data = await response.json();
      if (!response.ok || data.error)
        throw Object.assign(
          Error(data.error || `Runtime HTTP ${response.status}`),
          { code: data.code || "DEBUG_ERROR" },
        );

      return {
        data,
        analysis: Number(response.headers.get("X-Wxapp-Analysis") || 0),
      };
    };
    const requiredProtocol = requiredAnalysisProtocol(
      request.params.name,
      args,
    );
    if (requiredProtocol) {
      const probe = await remote("runner_status", {
        runtimeId: (args as any).runtimeId,
      });
      if (probe.analysis < requiredProtocol)
        throw Object.assign(
          Error(
            `This analysis option requires controller analysis protocol ${requiredProtocol}. Start a separate updated controller; existing instances were not changed.`,
          ),
          { code: "CONTROLLER_UPGRADE_REQUIRED" },
        );
    }
    if (
      ["runner_execution", "runner_autopsy"].includes(request.params.name) ||
      (args as any).analysis?.execution?.enabled
    ) {
      const probe = await remote("runner_status", {
        runtimeId: (args as any).runtimeId,
      });
      if (probe.analysis < 3)
        throw Object.assign(
          Error(
            "Execution analysis requires an updated controller; no runtime was changed",
          ),
          { code: "CONTROLLER_UPGRADE_REQUIRED" },
        );
    }
    let data: any;
    if (
      [
        "runner_hook",
        "runner_source",
        "runner_network",
        "runner_crypto_watch",
        "runner_slice",
        "runner_oracle",
      ].includes(request.params.name)
    ) {
      const identity = {
        runtimeId: (args as any).runtimeId,
        sessionId: (args as any).sessionId,
      };
      const probe = await remote("runner_status", {
        runtimeId: identity.runtimeId,
      });
      if (
        probe.analysis >=
        (["runner_crypto_watch", "runner_slice", "runner_oracle"].includes(
          request.params.name,
        )
          ? 2
          : 1)
      )
        data = (await remote(request.params.name, args)).data;
      else {
        const analysis = new AnalysisTools(
          async (name, a) =>
            (await remote(name, { ...identity, ...a })).data.result,
        );
        data = { result: await analysis.dispatch(request.params.name, args) };
      }
    } else {
      if (
        request.params.name === "runner_runtime" &&
        ["start", "restart", "switch"].includes((args as any).action) &&
        ((args as any).analysis ||
          (args as any).bootScript !== undefined ||
          (args as any).defeatAntiHook !== undefined)
      ) {
        const probe = await remote("runner_status", {
          runtimeId: (args as any).runtimeId,
        });
        if (probe.analysis < 2)
          throw Object.assign(
            Error(
              "This controller predates boot analysis. Start a separate updated controller; current runtime was not changed.",
            ),
            { code: "CONTROLLER_UPGRADE_REQUIRED" },
          );
      }
      data = (await remote(request.params.name, args)).data;
    }
    data.result = projectRows(request.params.name, args, data.result);
    if (data.result?.image)
      return {
        content: [
          {
            type: "image",
            mimeType: data.result.mimeType,
            data: data.result.image,
          },
          {
            type: "text",
            text: JSON.stringify(
              Object.fromEntries(
                Object.entries(data.result).filter(([key]) => key !== "image"),
              ),
            ),
          },
        ],
      };
    return {
      content: [{ type: "text", text: JSON.stringify(data.result ?? {}) }],
    };
  } catch (e: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: e.code || "DEBUG_ERROR",
            message: e.message,
            status: "error",
            operationRepeated: false,
          }),
        },
      ],
    };
  }
});
server.connect(new StdioServerTransport()).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

async function heartbeat(action = "touch") {
  try {
    const c = JSON.parse(fs.readFileSync(connectionFile, "utf8"));
    const url = new URL(c.endpoint);
    if (
      url.hostname !== "127.0.0.1" ||
      url.protocol !== "http:" ||
      url.username ||
      url.password
    )
      return;
    if (c.version < 2 || !c.version) return;
    await fetch(new URL("/client", url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${c.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action, clientId }),
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
  } catch {
    /* Re-read the connection file next time; never replay a business call. */
  }
}
const heartbeatTimer = setInterval(() => void heartbeat(), 5000);
heartbeatTimer.unref();
void heartbeat();
server.onclose = () => {
  clearInterval(heartbeatTimer);
  void heartbeat("disconnect");
};
process.stdin.once("end", () => {
  clearInterval(heartbeatTimer);
  void heartbeat("disconnect");
});
