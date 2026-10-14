/** Resolve only supplied foundation-library files, never package code or URLs. */
export function viewLibraryURL(file: string, available: readonly string[], origin: string) {
  const relative = file.replace(/^\//, "");
  if (!relative || relative.split("/").some(s => !s || s === "." || s === "..") ||
      /[\\?#:%\u0000-\u001f]/.test(relative) || !relative.endsWith(".js") || !available.includes(relative))
    throw Error("Requested foundation library is absent or invalid: " + file);
  return new URL("/baselib/" + relative.split("/").map(encodeURIComponent).join("/"), origin).href;
}
