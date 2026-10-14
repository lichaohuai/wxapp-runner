export type MiniProgramNetworkIdentity = {
  appid?: string;
  appVersion?: number;
};

/** Native host identity, independent of business account login. See docs/native-network-context.md. */
export function miniProgramReferer(identity: MiniProgramNetworkIdentity = {}) {
  if (!/^wx[0-9a-f]{16}$/i.test(identity.appid || "")) return undefined;
  const version =
    Number.isSafeInteger(identity.appVersion) && identity.appVersion! >= 0
      ? identity.appVersion
      : 0;
  return `https://servicewechat.com/${identity.appid}/${version}/page-frame.html`;
}

export function miniProgramHeaders(
  input: Record<string, unknown> = {},
  identity: MiniProgramNetworkIdentity = {},
) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const name = key.toLowerCase();
    // The official PC network interceptor removes both spellings before XWeb supplies its context.
    if (name !== "referer" && name !== "referrer")
      headers[name] = String(value);
  }
  const referer = miniProgramReferer(identity);
  if (referer) headers.referer = referer;
  return headers;
}

/** Translate only this host page's browser-generated Referer. A component's
 * no-referrer policy, H5 origins, and unrelated headers must remain intact. */
export function viewResourceHeaders(input: Record<string, string>, destination: string,
  documentURL: string | undefined, identity: MiniProgramNetworkIdentity = {}) {
  const native = miniProgramReferer(identity);
  if (!documentURL || !native) return input;
  try {
    const document = new URL(documentURL), target = new URL(destination);
    if (!/^(http|https):$/.test(target.protocol) || target.origin === document.origin) return input;
    for (const [key, value] of Object.entries(input)) {
      if (key.toLowerCase() !== "referer") continue;
      const actual = new URL(value);
      if (actual.origin !== document.origin) continue;
      const replacement = actual.pathname === "/" && !actual.search
        ? new URL(native).origin + "/" : actual.href === document.href ? native : undefined;
      if (replacement) return {...input, [key]:replacement};
    }
  } catch { /* Unknown origins are not rewritten. */ }
  return input;
}
