/** View-side native surfaces only. Never executes app business methods. */
export function installNativeInspection(w: any, native: any) {
  const ids = new WeakMap<Element, string>(),
    elements = new Map<string, Element>();
  const nativeCalls: any[] = [];
  const kinds = [
    "video",
    "audio",
    "canvas",
    "camera",
    "live-player",
    "live-pusher",
    "voip-room",
    "map",
    "cover-view",
    "cover-image",
    "web-view",
    "ad",
    "input",
    "textarea",
  ];
  const backend = (e: Element) =>
    e.matches("video,audio,canvas,input,textarea")
      ? e
      : e.querySelector("video,audio,canvas,input,textarea,iframe,webview");
  function scan() {
    for (const e of document.querySelectorAll(
      kinds.map((k) => "wx-" + k).join(","),
    )) {
      if (!ids.has(e)) {
        const id = crypto.randomUUID();
        ids.set(e, id);
        elements.set(id, e);
      }
    }
    for (const [id, e] of elements) if (!e.isConnected) elements.delete(id);
  }
  function describe(e: Element) {
    const surface = backend(e),
      media = surface instanceof HTMLMediaElement ? surface : undefined;
    return {
      id: ids.get(e),
      kind: e.tagName.toLowerCase().replace(/^wx-/, ""),
      elementId: e.id || null,
      backend:
        w.__runnerCover?.inspect(e)?.backend ||
        w.__runnerMap?.inspect(e)?.backend ||
        surface?.tagName.toLowerCase() ||
        null,
      backendAvailable:
        !!surface ||
        !!w.__runnerMap?.inspect(e) ||
        !!w.__runnerCover?.inspect(e),
      cover: w.__runnerCover?.inspect(e) || undefined,
      camera: w.__runnerCamera?.inspect(e) || undefined,
      map: w.__runnerMap?.inspect(e) || undefined,
      renderingStatus: "not-verified-by-inspection",
      rect: e.getBoundingClientRect().toJSON(),
      ...(media
        ? {
            media: {
              src: media.currentSrc || media.src,
              readyState: media.readyState,
              networkState: media.networkState,
              currentTime: media.currentTime,
              duration: Number.isFinite(media.duration) ? media.duration : null,
              paused: media.paused,
              ended: media.ended,
              muted: media.muted,
              error: media.error
                ? { code: media.error.code, message: media.error.message }
                : null,
            },
          }
        : {}),
      ...(surface instanceof HTMLCanvasElement
        ? { canvas: { width: surface.width, height: surface.height } }
        : {}),
    };
  }
  w.__runnerObserveNative = (api: string, args: any, result: any) => {
    if (
      !/Canvas|Video|Camera|Map|VoIP|LivePlayer|LivePusher|HTMLWebView|Positioning|TextView|ImageView|ScrollView/.test(
        api,
      )
    )
      return;
    const row = { api, args, result, time: Date.now() };
    nativeCalls.push(row);
    if (nativeCalls.length > 300) nativeCalls.shift();
    native.debug({ type: "native-component-call", ...row });
  };
  w.__runnerNative = async (args: any) => {
    scan();
    if (args.action === "list" || args.action === "capabilities")
      return {
        instances: [...elements.values()].map(describe),
        recentCalls: nativeCalls,
        support:
          "Only actual DOM-backed surfaces can be controlled. Missing backends are explicit; presence of a wx tag does not prove rendering.",
      };
    const e = elements.get(args.id);
    if (!e || !e.isConnected)
      throw Error("Native element is stale; read the current page native list");
    if (args.action === "get") return describe(e);
    if (["camera-input", "scan", "stop"].includes(args.action)) {
      const result = await w.__runnerCamera.debug(e, args);
      native.debug({
        type: "native-component-operation",
        id: args.id,
        action: args.action,
        mode: args.mode,
      });
      return { ...result, ...describe(e) };
    }
    const surface = backend(e);
    if (!(surface instanceof HTMLMediaElement))
      throw Error("Native surface has no controllable media backend");
    if (args.action === "play") await surface.play();
    else if (args.action === "pause") surface.pause();
    else if (args.action === "seek") {
      if (!Number.isFinite(args.position) || args.position < 0)
        throw Error("Invalid seek position");
      surface.currentTime = args.position;
    } else throw Error("Unsupported native operation");
    native.debug({
      type: "native-component-operation",
      id: args.id,
      action: args.action,
    });
    return {
      status: "media-operation-sent",
      businessCompleted: false,
      ...describe(e),
    };
  };
}
