import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

/** Bounded, host-side verification of captured vectors. Never executes app code,
 * guesses keys/options, or creates a dependency from matching values. */
const MAX_BYTES = 65536;
function bytes(value: any, encoding: string): Buffer | undefined {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > MAX_BYTES) return;
    if (encoding === "utf8-or-bytes") return Buffer.from(value, "utf8");
    if (encoding === "hex" && /^(?:[a-f\d]{2})*$/i.test(value))
      return Buffer.from(value, "hex");
    return;
  }
  if (
    value?.encoding === "hex" &&
    value.truncated === false &&
    typeof value.data === "string" &&
    value.data.length <= MAX_BYTES * 2 &&
    /^(?:[a-f\d]{2})*$/i.test(value.data) &&
    value.bytes === value.data.length / 2
  )
    return Buffer.from(value.data, "hex");
  if (
    Array.isArray(value) &&
    value.length <= MAX_BYTES &&
    value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
  )
    return Buffer.from(value);
}
function presentation(value: any, encoding: string) {
  const b = bytes(value, encoding);
  return {
    representation:
      typeof value === "string"
        ? "string"
        : value?.representation || value?.encoding || "unknown",
    decoding: encoding,
    bytes: b?.length ?? null,
    complete: !!b,
  };
}
function contract(row: any): any {
  if (row.crypto) return row.crypto;
  // Legacy named taps are candidates only. A successful vector check does not
  // turn a name match into library identity or a recovered general algorithm.
  const match = String(row.algo || "").match(
    /(?:^|[^a-z\d])(Hmac)?(md5|sha1|sha224|sha256|sha384|sha512|ripemd160|sm3)(?=[^a-z\d]|$)/i,
  );
  return match
    ? {
        algorithm: (match[1] || "") + match[2],
        operation: match[1] ? "hmac" : "digest",
        basis: "named-tap-candidate",
        inputEncoding: "utf8-or-bytes",
        outputEncoding: "hex",
      }
    : {
        algorithm: "unknown",
        operation: "unknown",
        basis: "unidentified",
        inputEncoding: "unknown",
        outputEncoding: "unknown",
      };
}
function verify(row: any, metadata: any, input: any, output: any) {
  const unavailable = (reason: string) => ({ status: "unavailable", reason });
  if (row.phase !== "return")
    return unavailable(
      row.phase === "call" || row.phase === "promise-pending"
        ? "CALL_NOT_FINISHED"
        : "CALL_FAILED",
    );
  if (row.streamTruncated) return unavailable("STREAM_TRUNCATED");
  // A forge update string defaults to binary, not UTF-8. Older stream captures
  // did not retain each update encoding. Do not silently guess for non-ASCII.
  if (row.streamId && /^forge\./.test(row.algo || ""))
    return unavailable("STREAM_ENCODING_NOT_RECORDED");
  const source = bytes(input, metadata.inputEncoding),
    expected = bytes(output, metadata.outputEncoding);
  if (!source || !expected)
    return unavailable("VECTOR_BYTES_INCOMPLETE_OR_ENCODING_UNKNOWN");
  try {
    let actual: Buffer;
    const algo = String(metadata.algorithm || "")
      .replace(/^Hmac/i, "")
      .replace(/-/g, "")
      .toLowerCase();
    if (
      ["digest", "hmac"].includes(metadata.operation) &&
      [
        "md5",
        "sha1",
        "sha224",
        "sha256",
        "sha384",
        "sha512",
        "ripemd160",
        "sm3",
      ].includes(algo)
    ) {
      if (metadata.operation === "hmac") {
        const key = bytes(row.key, "utf8-or-bytes");
        if (!key) return unavailable("KEY_BYTES_UNAVAILABLE");
        actual = createHmac(algo, key).update(source).digest();
      } else actual = createHash(algo).update(source).digest();
    } else if (
      algo === "aes" &&
      ["encrypt", "decrypt"].includes(metadata.operation)
    ) {
      if (metadata.keyEncoding !== "bytes")
        return unavailable("RAW_KEY_UNAVAILABLE");
      if (
        !["ECB", "CBC"].includes(metadata.mode) ||
        !["Pkcs7", "NoPadding"].includes(metadata.padding)
      )
        return unavailable("MODE_OR_PADDING_UNSUPPORTED_OR_UNKNOWN");
      const key = bytes(row.key, "bytes"),
        iv = metadata.mode === "ECB" ? null : bytes(row.iv, "bytes");
      if (
        !key ||
        ![16, 24, 32].includes(key.length) ||
        (metadata.mode === "CBC" && iv?.length !== 16)
      )
        return unavailable("KEY_OR_IV_BYTES_UNAVAILABLE");
      const name = `aes-${key.length * 8}-${metadata.mode.toLowerCase()}`;
      const cipher =
        metadata.operation === "encrypt"
          ? createCipheriv(name, key, iv!)
          : createDecipheriv(name, key, iv!);
      cipher.setAutoPadding(metadata.padding === "Pkcs7");
      actual = Buffer.concat([cipher.update(source), cipher.final()]);
    } else
      return unavailable(
        metadata.keyEncoding === "opaque-handle"
          ? "OPAQUE_KEY_NOT_EXPORTED"
          : "ALGORITHM_NOT_SUPPORTED_FOR_VERIFICATION",
      );
    return {
      status: actual.equals(expected) ? "verified" : "mismatch",
      implementation: "node:crypto",
      scope: "captured-vector-only",
      meaning:
        "numeric comparison, not a causal edge or proof for other inputs",
    };
  } catch {
    return unavailable("VECTOR_REJECTED_OR_HOST_ALGORITHM_UNAVAILABLE");
  }
}
export function summarizeCrypto(rows: any[], fields: any[] = []) {
  const calls = new Map<string, any>();
  for (const row of rows) {
    if (!row.callId || row.kind !== "crypto") continue;
    const id = `${row.executionRunId || row.runId || ""}:${row.callId}`;
    const previous = calls.get(id);
    if (!previous || ["return", "throw", "reject"].includes(row.phase))
      calls.set(id, row);
  }
  const steps = [...calls.values()].map((row) => {
    const metadata = contract(row),
      input = row.verificationVector?.input ?? row.input,
      output = row.verificationVector?.output ?? row.output;
    const fieldLinks = fields
      .filter(
        (f) =>
          row.executionEventId &&
          row.executionRunId &&
          f.events?.some(
            (e: any) =>
              e.id === row.executionEventId && e.runId === row.executionRunId,
          ),
      )
      .map((f) => ({
        field: f.field,
        association: "execution-event-in-field-slice",
      }));
    const outputBytes = bytes(output, metadata.outputEncoding);
    const variants: [string, string][] = [
      ...(typeof output === "string"
        ? [["exact-string", output] as [string, string]]
        : []),
      ...(outputBytes
        ? ([
            ["hex", outputBytes.toString("hex")],
            ["hex-uppercase", outputBytes.toString("hex").toUpperCase()],
            ["base64", outputBytes.toString("base64")],
          ] as [string, string][])
        : []),
    ];
    const fieldComparisons = fields.map((f) => {
      const known =
        typeof f.sink?.value === "string" &&
        f.selection?.precision === "exact-option-property" &&
        row.phase === "return" &&
        variants.length > 0;
      const match =
        known && variants.find(([, value]) => value === f.sink.value);
      return {
        field: f.field,
        matched: known ? !!match : null,
        encoding: match ? match[0] : null,
        association: "value-comparison-only",
        ...(!known
          ? { reason: "FIELD_OR_OUTPUT_REPRESENTATION_UNAVAILABLE" }
          : {}),
      };
    });
    return {
      callId: row.callId,
      parentCallId: row.parentCallId,
      recordId: row.id,
      executionRunId: row.executionRunId,
      executionEventId: row.executionEventId,
      source: row.executionLocation,
      label: row.algo,
      phase: row.phase,
      streamId: row.streamId,
      metadata,
      inputFormat: presentation(input, metadata.inputEncoding),
      outputFormat: presentation(output, metadata.outputEncoding),
      keyFormat:
        row.key === undefined
          ? undefined
          : presentation(row.key, metadata.keyEncoding || "utf8-or-bytes"),
      ivFormat:
        row.iv === undefined ? undefined : presentation(row.iv, "bytes"),
      verification: verify(row, metadata, input, output),
      fieldLinks,
      fieldComparisons,
      association: row.executionEventId
        ? "recorded-execution-context"
        : "unassociated",
    };
  });
  return {
    steps,
    counts: {
      calls: steps.length,
      verified: steps.filter((s) => s.verification.status === "verified")
        .length,
      mismatch: steps.filter((s) => s.verification.status === "mismatch")
        .length,
      unavailable: steps.filter((s) => s.verification.status === "unavailable")
        .length,
    },
    meaning:
      "Observed calls in capture order. Only explicit call/execution identities link records; matching bytes do not imply data flow.",
  };
}
