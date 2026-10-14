import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const MAX_BYTES = 4 * 1024 * 1024;
const appId = /^wx[0-9a-f]{16}$/i;
const object = (v: any) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const uint = (v: any) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
function failure(code: string, message: string) {
  return Object.assign(Error(`${code}: ${message}`), {
    code,
    runnerCode: code,
  });
}
function invalid(message: string): never {
  throw failure("HOST_CONTACTS_INVALID", message);
}
export function declaredPluginIds(app: any): string[] {
  return [
    ...new Set(
      Object.values(app?.plugins || {})
        .map((p: any) => p?.provider)
        .filter(
          (id: any): id is string => typeof id === "string" && appId.test(id),
        ),
    ),
  ];
}
export type HostContacts = {
  format: 1;
  appid: string;
  appVersion: number;
  capturedAt: string;
  expiresAt?: string;
  appContactInfo?: Record<string, any>;
  contactList?: Array<Record<string, any>>;
};
/** Runner import envelope, NOT a new wxbot protocol. SDK fields are preserved,
 * never inferred from package semver, search cards, URLs or verifyPlugin. */
export function validateHostContacts(
  value: unknown,
  config: any,
  now = Date.now(),
): HostContacts {
  const v = value as any;
  if (
    !object(v) ||
    v.format !== 1 ||
    typeof v.appid !== "string" ||
    !appId.test(v.appid) ||
    !uint(v.appVersion) || v.appVersion === 0
  )
    invalid("format:1, appid and a positive package appVersion are required");
  if (v.appid !== config.appid || v.appVersion !== (config.appVersion ?? 0))
    throw failure(
      "HOST_CONTACTS_IDENTITY_MISMATCH",
      "Contact appid/appVersion differs from the selected package; no runtime was replaced",
    );
  if (
    typeof v.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(v.capturedAt))
  )
    invalid("capturedAt must be a timestamp");
  if (v.expiresAt !== undefined) {
    if (
      typeof v.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(v.expiresAt)) ||
      Date.parse(v.expiresAt) <= Date.parse(v.capturedAt)
    )
      invalid("expiresAt must be later than capturedAt");
    if (Date.parse(v.expiresAt) <= now)
      throw failure(
        "HOST_CONTACTS_EXPIRED",
        "Contact snapshot expired; provide fresh host data",
      );
  }
  if (v.appContactInfo === undefined && v.contactList === undefined)
    invalid("Provide appContactInfo or contactList from the host");
  if (v.appContactInfo !== undefined) {
    if (!object(v.appContactInfo)) invalid("appContactInfo must be an object");
    const plugins = v.appContactInfo.call_plugin_info;
    if (plugins !== undefined) {
      if (!Array.isArray(plugins) || plugins.length > 500)
        invalid("call_plugin_info must be a bounded array");
      const seen = new Set<string>();
      for (const p of plugins) {
        if (
          !object(p) ||
          typeof p.plugin_id !== "string" ||
          !appId.test(p.plugin_id) ||
          !uint(p.inner_version) ||
          seen.has(p.plugin_id)
        )
          invalid(
            "call_plugin_info requires unique plugin_id and integer inner_version",
          );
        seen.add(p.plugin_id);
      }
      if (declaredPluginIds(config.app).some((id) => !seen.has(id)))
        invalid(
          "call_plugin_info omits a declared provider; an empty or partial list would mask package plugins",
        );
    }
  }
  if (v.contactList !== undefined) {
    if (!Array.isArray(v.contactList) || v.contactList.length > 500)
      invalid("contactList must be a bounded array");
    const seen = new Set<string>();
    for (const c of v.contactList) {
      if (
        !object(c) ||
        typeof c.appId !== "string" ||
        !appId.test(c.appId) ||
        seen.has(c.appId)
      )
        invalid("contactList requires unique appId values");
      seen.add(c.appId);
      if (c.plugin_list !== undefined) {
        if (!Array.isArray(c.plugin_list) || c.plugin_list.length > 100)
          invalid("plugin_list must be an array");
        for (const p of c.plugin_list) {
          if (!object(p)) invalid("plugin_list entries must be objects");
          if (p.PluginNetWork !== undefined) {
            if (!object(p.PluginNetWork))
              invalid("PluginNetWork must be an object");
            for (const field of [
              "RequestDomain",
              "UploadDomain",
              "DownloadDomain",
              "WsRequestDomain",
              "TCPDomain",
            ]) {
              const domains = p.PluginNetWork[field];
              if (
                domains !== undefined &&
                (!Array.isArray(domains) ||
                  domains.length > 1000 ||
                  domains.some((d: any) => typeof d !== "string"))
              )
                invalid(`PluginNetWork.${field} must be an array of strings`);
            }
          }
        }
      }
    }
  }
  return structuredClone({
    format: 1,
    appid: v.appid,
    appVersion: v.appVersion,
    capturedAt: v.capturedAt,
    ...(v.expiresAt ? { expiresAt: v.expiresAt } : {}),
    ...(v.appContactInfo !== undefined
      ? { appContactInfo: v.appContactInfo }
      : {}),
    ...(v.contactList !== undefined ? { contactList: v.contactList } : {}),
  });
}

/** Called during preflight, before replacing an instance. Runtime children use
 * this frozen-in-time snapshot, not a second read of a potentially changed file. */
export function prepareHostContacts<T extends Record<string, any>>(
  config: T,
): T & {
  hostContacts?: HostContacts;
  hostContactsProvenance?: { source: "file"; sha256: string };
} {
  if (!config.contactsFile)
    return {
      ...config,
      hostContacts: undefined,
      hostContactsProvenance: undefined,
    };
  const file = path.resolve(config.contactsFile);
  let bytes: Buffer;
  try {
    const fd = fs.openSync(file, "r");
    try {
      if (!fs.fstatSync(fd).isFile())
        invalid("contactsFile must be a regular file");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = fs.readSync(
          fd,
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!read) break;
        length += read;
      }
      if (length > MAX_BYTES) invalid("contactsFile exceeds 4 MiB");
      bytes = buffer.subarray(0, length);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e: any) {
    if (e.runnerCode) throw e;
    throw failure(
      "HOST_CONTACTS_UNREADABLE",
      "Cannot read the configured contactsFile",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid("contactsFile is not JSON");
  }
  return {
    ...config,
    contactsFile: file,
    hostContacts: validateHostContacts(parsed, config),
    hostContactsProvenance: {
      source: "file",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

export class HostContactStore {
  private data?: HostContacts;
  private calls = 0;
  private lastError?: { runnerCode: string; missingAppIds?: string[] };
  constructor(
    private config: any,
    private now = Date.now,
  ) {
    this.data =
      config.hostContacts &&
      validateHostContacts(config.hostContacts, config, now());
  }
  snapshot() {
    const pluginIds = declaredPluginIds(this.config.app);
    const bootInfo =
      this.data?.appContactInfo ?? this.config.app?.appContactInfo;
    const records = Array.isArray(bootInfo?.call_plugin_info)
      ? bootInfo.call_plugin_info
      : [];
    const contacts = this.data?.contactList || [];
    return {
      state: !this.data
        ? "not-configured"
        : this.data.expiresAt && Date.parse(this.data.expiresAt) <= this.now()
          ? "expired"
          : "loaded",
      provenance: this.config.hostContactsProvenance,
      capturedAt: this.data?.capturedAt,
      expiresAt: this.data?.expiresAt,
      expiryKnown: !!this.data?.expiresAt,
      hasAppContactInfo: !!bootInfo,
      bootSource: this.data?.appContactInfo
        ? "host-snapshot"
        : bootInfo
          ? "package-config"
          : "missing",
      providers: records.map((p: any) => ({
        provider: p.plugin_id,
        inner_version: p.inner_version,
      })),
      contactCount: contacts.length,
      missingBootProviders: pluginIds.filter(
        (id) => !records.some((p: any) => p.plugin_id === id),
      ),
      missingContacts: pluginIds.filter(
        (id) => !contacts.some((c) => c.appId === id),
      ),
      batchCalls: this.calls,
      lastError: this.lastError,
      verification: "separate-native-call",
    };
  }
  batch(args: any) {
    const ids = args?.appIds;
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 500 ||
      new Set(ids).size !== ids.length ||
      ids.some((id: any) => typeof id !== "string" || !appId.test(id))
    )
      throw failure(
        "HOST_CONTACTS_INVALID_ARGUMENT",
        "batchGetContact requires 1–500 unique appIds",
      );
    this.calls++;
    if (this.data?.expiresAt && Date.parse(this.data.expiresAt) <= this.now()) {
      this.lastError = { runnerCode: "HOST_CONTACTS_EXPIRED" };
      throw failure(
        this.lastError.runnerCode,
        "Contact snapshot expired; no stale contacts were returned",
      );
    }
    const contacts = this.data?.contactList || [];
    const missingAppIds = ids.filter(
      (id: string) => !contacts.some((c) => c.appId === id),
    );
    if (missingAppIds.length) {
      this.lastError = { runnerCode: "HOST_CONTACTS_MISSING", missingAppIds };
      throw Object.assign(
        failure(
          this.lastError.runnerCode,
          "No host contact metadata for the requested appIds; no contacts or domains were synthesized",
        ),
        { missingAppIds },
      );
    }
    this.lastError = undefined;
    return {
      contactList: structuredClone(
        ids.map((id: string) => contacts.find((c) => c.appId === id)),
      ),
    };
  }
}
