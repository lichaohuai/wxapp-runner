// The host chooses the actual backend in onAppRoute; package declarations
// remain unchanged. WAServiceMainContext 3.17.3 uses that route field in
// newAdapterPage, independently of the page's declared renderer.
export function rendererSelection(declared: string) {
  if (declared === "skyline")
    return {
      effectiveRenderer: "webview",
      rendererFallback: "host-skyline-unavailable" as const,
    };
  return { effectiveRenderer: declared, rendererFallback: null };
}

// Native contract from WAPCAdapterAppIndex 3.17.3. Preserve the real base
// library's public getSkylineInfo(Sync) normalization and callback handling.
export function nativeSkylineInfo() {
  return {
    userAgent: "unknown",
    isSupportSkyline: false,
    isLibSupportSkyline: false,
    enableSkyline: false,
    switchRenderMode: 1,
  };
}
