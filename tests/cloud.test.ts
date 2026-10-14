import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudRuntime } from "../src/cloud/runtime";
import { parseTool } from "../src/mcp/tools";
import { setTimeout as delay } from "node:timers/promises";
test("cloud jobs execute original SDK once, reject implicit writes, redact results and do not pretend SDK errors passed", async () => {
  let calls = 0;
  const cloud = new CloudRuntime(
    {
      callFunction: async () => {
        calls++;
        return {
          result: { openid: "private-fixture", phoneNumber: "private-fixture" },
        };
      },
      database: () => ({
        collection: () => ({
          where: () => ({
            limit: () => ({
              get: async () => {
                throw Error("permission denied");
              },
            }),
          }),
        }),
      }),
    },
    true,
  );
  assert.throws(() =>
    parseTool("runner_cloud", {
      action: "start",
      operation: "function",
      name: "test",
    }),
  );
  assert.equal(calls, 0);
  const j = cloud.query({
    action: "start",
    operation: "function",
    name: "test",
    confirm: true,
  });
  assert.equal(j.businessCompleted, false);
  let result: any;
  for (let n = 0; n < 100; n++) {
    result = cloud.query({ action: "get", jobId: j.jobId });
    if (result.state !== "pending") break;
    await delay(1);
  }
  assert.equal(calls, 1);
  assert.equal(result.sdkCompleted, true);
  assert.ok(!JSON.stringify(result).includes("private-fixture"));
  assert.equal(result.status, undefined);
  const failed = cloud.query({
    action: "start",
    operation: "databaseQuery",
    collection: "fixture",
  });
  for (let n = 0; n < 100; n++) {
    result = cloud.query({ action: "get", jobId: failed.jobId });
    if (result.state !== "pending") break;
    await delay(1);
  }
  assert.equal(result.state, "failed");
  assert.match(result.error.message, /permission denied/);
});
