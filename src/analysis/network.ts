import { redact } from "../mcp/redact";
import { decodeJsonPreview } from "../json-preview";
export type DebugCall = (name: string, args: any) => Promise<any>;
const pick = (r: any, fields: string[]) =>
  Object.fromEntries(
    fields
      .map((key) => [key, key.split(".").reduce((v, k) => v?.[k], r)])
      .filter(([, v]) => v !== undefined),
  );
const summaryFields = [
  "id",
  "cursor",
  "url",
  "method",
  "status",
  "state",
  "resourceType",
  "error",
  "errorName",
  "captureError",
  "responseBodyUnavailable",
  "endedAt",
  "blockedReason",
  "ruleIds",
  "source",
  "targetId",
  "bytes",
  "durationMs",
  "handler",
  "operationId",
  "requestArtifactId",
  "responseArtifactId",
  "mocked",
  "replayOf",
  "requestBodyTruncated",
  "responseBodyTruncated",
];
export function networkProjection(r: any, a: any, detail = false) {
  const row = {
    ...r,
    bytes: { encoded: r.encodedBytes ?? null, decoded: r.decodedBytes ?? null },
    handler: r.context?.handler ?? r.handler ?? null,
    operationId: r.context?.operationId ?? r.operationId ?? null,
  };
  if (!detail && !a.fields && a.summary !== false)
    return pick(row, summaryFields);
  for (const prefix of ["request", "response"])
    if (row[prefix + "Body"] !== undefined) {
      const text = String(row[prefix + "Body"]),
        bytes = Buffer.from(text),
        bodyTruncated =
          !!row[prefix + "BodyTruncated"] || bytes.length > a.previewBytes;
      row[prefix + "Body"] = new TextDecoder().decode(
        bytes.subarray(0, a.previewBytes),
        { stream: bytes.length > a.previewBytes },
      );
      row[prefix + "BodyTruncated"] = bodyTruncated;
      let parsed: any;
      try {
        if (!bodyTruncated && row[prefix + "BodyEncoding"] !== "base64")
          parsed = JSON.parse(text);
      } catch {
        if (
          !bodyTruncated &&
          /x-www-form-urlencoded/i.test(
            JSON.stringify(
              row[
                prefix === "request" ? "requestHeaders" : "responseHeaders"
              ] || {},
            ),
          )
        )
          parsed = Object.fromEntries(new URLSearchParams(text));
      }
      row[prefix + "BodyPreview"] = {
        text: row[prefix + "Body"],
        parsed,
        encoding: row[prefix + "BodyEncoding"],
        truncated: bodyTruncated,
        artifactId: row[prefix + "ArtifactId"],
        bodyUnavailable: row[prefix + "BodyUnavailable"],
      };
      if (!bodyTruncated && row[prefix + "BodyEncoding"] !== "base64") {
        const preview = decodeJsonPreview(text);
        if (preview.decoding.changed || !preview.decoding.complete) {
          Object.assign(row[prefix + "BodyPreview"], {
            decoded: preview.value,
            decoding: preview.decoding,
          });
        }
      }
    }
  return a.fields ? pick(row, a.fields) : row;
}
export function diffRecords(a: any, b: any) {
  const query = (url: string) => {
    try {
      const p = new URL(url).searchParams;
      return Object.fromEntries(
        [...new Set(p.keys())].map((k) => [k, p.getAll(k)]),
      );
    } catch {
      return {};
    }
  };
  const headers = (h: any) =>
    Object.fromEntries(
      Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
  const body = (r: any) => {
    try {
      return JSON.parse(r.requestBody);
    } catch {
      return /x-www-form-urlencoded/i.test(
        JSON.stringify(r.requestHeaders || {}),
      )
        ? query("http://body/?" + (r.requestBody || ""))
        : r.requestBody;
    }
  };
  const left = {
      method: a.method,
      url: a.url?.split("?")[0],
      query: query(a.url),
      headers: headers(a.requestHeaders),
      body: body(a),
    },
    right = {
      method: b.method,
      url: b.url?.split("?")[0],
      query: query(b.url),
      headers: headers(b.requestHeaders),
      body: body(b),
    };
  const changes: any[] = [];
  let truncated = false;
  const walk = (x: any, y: any, p: string, depth = 0) => {
    if (changes.length >= 200) {
      truncated = true;
      return;
    }
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (
      depth < 12 &&
      x &&
      y &&
      typeof x === "object" &&
      typeof y === "object" &&
      Array.isArray(x) === Array.isArray(y)
    ) {
      for (const key of new Set([...Object.keys(x), ...Object.keys(y)]))
        walk(
          x[key],
          y[key],
          p + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1"),
          depth + 1,
        );
    } else
      changes.push({
        path: p,
        before: x,
        after: y,
        change:
          x === undefined ? "added" : y === undefined ? "removed" : "changed",
      });
  };
  walk(left, right, "");
  return {
    idA: a.id,
    idB: b.id,
    changes,
    truncated,
    incomplete: !!(
      a.requestBodyTruncated ||
      b.requestBodyTruncated ||
      a.requestBodyUnavailable ||
      b.requestBodyUnavailable
    ),
    basis: "captured request query, headers and body; no replay",
  };
}
export async function queryNetwork(call: DebugCall, a: any) {
  const safe = (v: any) => (a.revealSensitive ? v : redact(v));
  if (a.action === "diff") {
    const [x, y] = await Promise.all([
      call("runner_network", {
        id: a.idA,
        revealSensitive: a.revealSensitive,
        previewBytes: 262144,
        summary: false,
      }),
      call("runner_network", {
        id: a.idB,
        revealSensitive: a.revealSensitive,
        previewBytes: 262144,
        summary: false,
      }),
    ]);
    const diff = diffRecords(safe(x), safe(y));
    const changes = diff.changes
      .slice(a.offset, a.offset + a.limit)
      .map((change) => {
        const result = { ...change };
        for (const key of ["before", "after"]) {
          const bytes = Buffer.from(JSON.stringify(change[key]) ?? "null");
          if (bytes.length > 1024) {
            result[key] = {
              preview: new TextDecoder().decode(bytes.subarray(0, 1024), {
                stream: true,
              }),
              truncated: true,
              bytes: bytes.length,
            };
          }
        }
        return result;
      });
    return safe({
      ...diff,
      changes,
      nextOffset: a.offset + changes.length,
      hasMore: a.offset + changes.length < diff.changes.length,
      artifacts: { idA: x.requestArtifactId, idB: y.requestArtifactId },
    });
  }
  if (a.id)
    return safe(
      networkProjection(
        await call("runner_network", {
          id: a.id,
          revealSensitive: a.revealSensitive,
          previewBytes: 262144,
          summary: false,
        }),
        a,
        true,
      ),
    );
  if (a.after === undefined && !a.filter) {
    const rows = await call("runner_network", {
      limit: a.limit,
      summary: false,
      revealSensitive: a.revealSensitive,
    });
    const entries: any[] = [];
    for (const r of Array.isArray(rows) ? rows : rows.entries) {
      const detail = a.fields?.some((k: string) =>
        /^(request|response)Body/.test(k),
      );
      entries.push(
        networkProjection(
          detail
            ? await call("runner_network", {
                id: r.id,
                summary: false,
                revealSensitive: a.revealSensitive,
              })
            : r,
          a,
        ),
      );
    }
    return safe(entries);
  }
  const f = a.filter || {};
  let after = a.after ?? 0,
    scanned = 0,
    hasMore = false,
    meta: any = {},
    uncertain = 0,
    gap = false;
  const matches: any[] = [];
  do {
    const page = await call("runner_network", {
      after,
      limit: Math.min(100, a.maxScan - scanned),
      summary: false,
      revealSensitive: a.revealSensitive,
    });
    const rows = Array.isArray(page) ? page : page.entries;
    meta = { ...page, entries: undefined };
    gap ||= !!page.gap;
    hasMore = !!page.hasMore;
    for (const row of rows) {
      scanned++;
      after = row.cursor ?? after;
      if (f.urlIncludes && !row.url?.includes(f.urlIncludes)) continue;
      if (f.source && row.source !== f.source) continue;
      if (f.resourceType && row.resourceType !== f.resourceType) continue;
      if (f.state && row.state !== f.state) continue;
      if (f.blockedReason && row.blockedReason !== f.blockedReason) continue;
      if (
        f.status !== undefined &&
        !(Array.isArray(f.status) ? f.status : [f.status]).includes(row.status)
      )
        continue;
      const hasBody = !!(
        row.requestArtifactId ||
        row.responseArtifactId ||
        row.requestBody ||
        row.responseBody
      );
      if (f.hasBody !== undefined && hasBody !== f.hasBody) continue;
      let value = row;
      if (
        f.bodyIncludes !== undefined ||
        a.fields?.some((k: string) => /^(request|response)Body/.test(k))
      ) {
        value = await call("runner_network", {
          id: row.id,
          revealSensitive: a.revealSensitive,
          previewBytes: 262144,
          summary: false,
        });
        if (
          f.bodyIncludes !== undefined &&
          !["requestBody", "responseBody"].some(
            (k) =>
              value[k + "Encoding"] !== "base64" &&
              String(value[k] || "").includes(f.bodyIncludes),
          )
        ) {
          if (
            value.requestBodyTruncated ||
            value.responseBodyTruncated ||
            value.requestBodyUnavailable ||
            value.responseBodyUnavailable
          )
            uncertain++;
          continue;
        }
      }
      matches.push(networkProjection(value, a));
      if (a.after !== undefined || a.filter) {
        if (matches.length >= a.limit) {
          hasMore = hasMore || row !== rows.at(-1);
          break;
        }
      } else if (matches.length > a.limit) matches.shift();
    }
    if ((a.after !== undefined || a.filter) && matches.length >= a.limit) break;
    if (!rows.length || meta.cursorResetRequired) break;
  } while (hasMore && scanned < a.maxScan);
  const entries = safe(matches);
  if (a.after === undefined && !a.filter) return entries;
  return {
    ...meta,
    entries,
    nextCursor: after,
    hasMore,
    gap,
    scanned,
    filterIncomplete: uncertain > 0,
    unsearchedBodies: uncertain,
    bodySearchScope:
      "captured decoded preview, up to 256 KiB per body; truncated/evicted non-matches are reported unknown",
    outputProjection: a.fields || (a.summary !== false ? "summary" : "full"),
  };
}
