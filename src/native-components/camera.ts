import { BrowserMultiFormatReader } from "@zxing/browser";
/** Real camera component, with explicit system / image / simulated input. */
export function createCameraBackend(
  w: any,
  emit: (name: string, args: any) => void,
  native: any,
) {
  const cameras = new Map<number, any>();
  const raw = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    let s = "";
    for (let i = 0; i < bytes.length; i += 8192)
      s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(s);
  };
  const send = (c: any, name: string, args: any = {}) => {
    if (cameras.has(c.id) && c.host.isConnected)
      emit(name, { cameraId: c.id, ...args });
  };
  const valid = (c: any) => {
    if (!c || !c.host.isConnected || !cameras.has(c.id))
      throw Error("Camera component is stale");
  };
  function stop(c: any) {
    c.generation = (c.generation || 0) + 1;
    clearInterval(c.timer);
    c.timer = undefined;
    c.stream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    c.stream = undefined;
    c.video.srcObject = null;
    c.state = "stopped";
  }
  function frame(c: any) {
    valid(c);
    if (c.state !== "ready") throw Error("Camera input is not ready");
    const ctx = c.canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(c.source, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height);
  }
  function scan(c: any, result: string, type = "qrcode", rawData?: string) {
    valid(c);
    if (c.options.mode !== "scanCode")
      throw Error("Camera is not in scanCode mode");
    if (!result || result.length > 65536)
      throw Error("Scan result must contain 1–65536 characters");
    if (c.state !== "ready")
      throw Error("Provide a camera image or enable a camera input first");
    // Publish the image frame before the original scancode event; plugins may read it.
    if (c.listening) native.cameraFrame(c.id, frame(c).data.buffer);
    if (c.resolveScan) {
      const done = c.resolveScan;
      c.resolveScan = undefined;
      done({
        result,
        scanType: type === "qrcode" ? "QR_CODE" : "CODE_128",
        charSet: "UTF-8",
        rawData: rawData || raw(result),
      });
      return;
    }
    send(c, "onCameraScanCode", {
      type,
      result,
      rawData: rawData || raw(result),
      charSet: "UTF-8",
      scanArea: c.options.scanArea || [0, 0, c.width, c.height],
    });
    native.debug({
      type: "camera-scan",
      cameraId: c.id,
      inputMode: c.inputMode,
      simulated: c.inputMode !== "system",
      resultLength: result.length,
    });
  }
  async function ready(c: any, source: any, inputMode: string) {
    valid(c);
    c.source = source;
    c.inputMode = inputMode;
    c.state = "ready";
    c.status.textContent =
      inputMode === "system"
        ? "电脑摄像头"
        : "调试相机 · " + (inputMode === "image" ? "图片输入" : "模拟输入");
    c.timer = setInterval(() => {
      if (!c.host.isConnected) {
        stop(c);
        return;
      }
      try {
        const image = frame(c);
        if (c.listening) native.cameraFrame(c.id, image.data.buffer);
        if (c.options.mode === "scanCode" && inputMode !== "simulated") {
          try {
            const result = (c.reader ||=
              new BrowserMultiFormatReader()).decodeFromCanvas(c.canvas);
            const text = result.getText();
            if (text !== c.lastScan) {
              c.lastScan = text;
              scan(
                c,
                text,
                result.getBarcodeFormat() === 11 ? "qrcode" : "barcode",
              );
            }
          } catch {
            /* No code in this frame. */
          }
        }
      } catch (e: any) {
        c.status.textContent = e.message;
      }
    }, 250);
    // Both service camera-frame initialization and view initdone are native events.
    native
      .nativeRequest("__cameraInitialized", { cameraId: c.id })
      .catch(() => {});
    send(c, "onCameraInitDone", { maxZoom: 1 });
  }
  async function input(c: any, mode: string, dataUrl?: string) {
    valid(c);
    if (!["system", "image", "simulated"].includes(mode))
      throw Error("Unsupported camera input mode");
    await native.nativeRequest("authorize", { scope: "scope.camera" });
    valid(c);
    stop(c);
    const generation = c.generation;
    const check = () => {
      valid(c);
      if (c.generation !== generation)
        throw Error("Camera input was superseded or stopped");
    };
    c.lastScan = "";
    if (mode === "system") {
      await native.nativeRequest("__cameraAccess", {});
      check();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode:
            c.options.devicePosition === "front" ? "user" : "environment",
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      });
      if (
        c.generation !== generation ||
        !cameras.has(c.id) ||
        !c.host.isConnected
      ) {
        stream.getTracks().forEach((t) => t.stop());
        throw Error("Camera component is stale");
      }
      c.stream = stream;
      c.video.srcObject = stream;
      c.video.hidden = false;
      c.canvas.hidden = true;
      await c.video.play();
      check();
      await ready(c, c.video, "system");
    } else if (mode === "image") {
      if (!dataUrl) {
        const r = await native.nativeRequest("__cameraPick", {});
        dataUrl = r.dataUrl;
      }
      if (!/^data:image\/(png|jpeg|webp|gif|bmp);base64,/.test(dataUrl || ""))
        throw Error("Supported image input required");
      const img = new Image();
      img.src = dataUrl!;
      await img.decode();
      check();
      c.video.hidden = true;
      c.canvas.hidden = false;
      await ready(c, img, "image");
      frame(c);
    } else if (mode === "simulated") {
      c.video.hidden = true;
      c.canvas.hidden = false;
      const source = document.createElement("canvas");
      source.width = c.width;
      source.height = c.height;
      const ctx = source.getContext("2d")!;
      ctx.fillStyle = "#192838";
      ctx.fillRect(0, 0, source.width, source.height);
      ctx.fillStyle = "#fff";
      ctx.font = "24px sans-serif";
      ctx.fillText("模拟相机输入", 30, 60);
      await ready(c, source, "simulated");
      frame(c);
    } else throw Error("Unsupported camera input mode");
  }
  function create(a: any, suppliedHost?: HTMLElement) {
    const id = a.cameraId ?? a.viewId;
    if (!Number.isFinite(id)) throw Error("cameraId required");
    const host =
      suppliedHost ||
      [...document.querySelectorAll<HTMLElement>("wx-camera")].find(
        (e: any) =>
          e.__wxElement?.viewId === id ||
          e.__wxElement?.getContextId?.() === id,
      );
    if (!host) throw Error("Camera component identity unavailable");
    const layer = document.createElement("div");
    layer.dataset.runnerCamera = String(id);
    Object.assign(layer.style, {
      position: "absolute",
      inset: "0",
      background: "#192838",
      color: "white",
      overflow: "hidden",
    });
    const video = document.createElement("video"),
      canvas = document.createElement("canvas"),
      status = document.createElement("div"),
      actions = document.createElement("div");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.hidden = true;
    canvas.width = 480;
    canvas.height = 640;
    canvas.hidden = true;
    for (const e of [video, canvas])
      Object.assign(e.style, {
        width: "100%",
        height: "100%",
        objectFit: "cover",
      });
    Object.assign(actions.style, {
      position: "absolute",
      bottom: "8px",
      left: "8px",
      right: "8px",
      display: "flex",
      gap: "4px",
      flexWrap: "wrap",
      zIndex: "2",
    });
    Object.assign(status.style, {
      position: "absolute",
      left: "8px",
      top: "8px",
      font: "13px sans-serif",
      background: "#192838cc",
    });
    status.textContent = "选择相机输入";
    layer.append(video, canvas, status, actions);
    if (getComputedStyle(host).position === "static")
      host.style.position = "relative";
    const container = host.querySelector<HTMLElement>("#container") || host;
    container.append(layer);
    const c: any = {
      id,
      host,
      layer,
      video,
      canvas,
      status,
      width: 480,
      height: 640,
      state: "waiting-input",
      inputMode: null,
      options: { ...a },
      listening: false,
    };
    cameras.set(id, c);
    for (const [label, mode] of [
      ["摄像头", "system"],
      ["选择图片", "image"],
      ["模拟相机", "simulated"],
    ]) {
      if (mode === "image" && a.onlyFromCamera) continue;
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = (e) => {
        e.stopPropagation();
        void input(c, mode).catch((err) => {
          status.textContent = err.message;
          send(c, "onCameraNeedAuthCancel");
        });
      };
      actions.append(b);
    }
    if (a.mode === "scanCode") {
      const field = document.createElement("input");
      field.placeholder = "模拟扫码内容";
      field.style.width = "130px";
      const b = document.createElement("button");
      b.textContent = "发送扫码";
      b.onclick = (e) => {
        e.stopPropagation();
        try {
          scan(c, field.value);
        } catch (err: any) {
          status.textContent = err.message;
        }
      };
      actions.append(field, b);
    }
    return c;
  }
  async function invoke(name: string, a: any) {
    const id = a.cameraId ?? a.viewId;
    let c = cameras.get(id);
    if (/^remove(XWeb)?Camera$/.test(name)) {
      if (c) {
        stop(c);
        c.layer.remove();
        cameras.delete(id);
      }
      return { cameraId: id };
    }
    if (/^insert(XWeb)?Camera$/.test(name) && !c) c = create(a);
    valid(c);
    if (/^(insert|update)(XWeb)?Camera$/.test(name)) {
      Object.assign(c.options, a);
      c.layer.hidden = !!c.options.hide;
      if (c.options.hide) {
        stop(c);
        send(c, "onCameraStop");
      }
      return { cameraId: id };
    }
    if (name !== "operateCamera") throw Error("Unsupported camera operation");
    if (a.type === "setZoom") {
      if (a.zoom !== 1) throw Error("Camera backend supports zoom=1 only");
      return { zoom: 1 };
    }
    if (a.type === "listenFrameChange") {
      if (c.state !== "ready") throw Error("Camera input is not ready");
      c.listening = true;
      return { width: c.width, height: c.height };
    }
    if (a.type === "closeFrameChange") {
      c.listening = false;
      return {};
    }
    if (a.type === "takePhoto") {
      if (c.options.mode === "scanCode")
        throw Error("takePhoto unavailable in scanCode mode");
      frame(c);
      return native.nativeRequest("__cameraSave", {
        dataUrl: c.canvas.toDataURL(
          "image/jpeg",
          a.quality === "high" ? 1 : 0.8,
        ),
      });
    }
    throw Error("UNIMPLEMENTED: CameraContext." + a.type);
  }
  w.__runnerScan = (args: any) =>
    new Promise((resolve, reject) => {
      if (document.querySelector("[data-runner-scanner]"))
        throw Error("Scanner already open");
      const overlay = document.createElement("section");
      overlay.dataset.runnerScanner = "true";
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483000;background:#192838;display:flex;flex-direction:column";
      const close = document.createElement("button");
      close.textContent = "取消扫码";
      const host = document.createElement("wx-camera");
      host.style.cssText =
        "position:relative;display:block;flex:1;min-height:300px";
      overlay.append(close, host);
      document.body.append(overlay);
      const id = -Date.now(),
        c = create(
          {
            cameraId: id,
            mode: "scanCode",
            onlyFromCamera: !!args.onlyFromCamera,
          },
          host,
        );
      const finish = (result?: any) => {
        stop(c);
        cameras.delete(id);
        overlay.remove();
        result ? resolve(result) : reject(Error("cancel"));
      };
      c.resolveScan = finish;
      close.onclick = () => finish();
    });
  w.__runnerCamera = {
    revoke: () => {
      for (const c of cameras.values()) {
        stop(c);
        send(c, "onCameraStop");
        c.status.textContent = "相机权限已关闭";
      }
    },
    has: (id: number) => cameras.has(id),
    operate: (a: any) => invoke("operateCamera", a),
    inspect: (host: Element) => {
      const c = [...cameras.values()].find((c) => c.host === host);
      return c
        ? {
            cameraId: c.id,
            inputMode: c.inputMode,
            state: c.state,
            frames: c.listening,
            simulated: c.inputMode !== "system",
          }
        : null;
    },
    debug: async (host: Element, a: any) => {
      const c = [...cameras.values()].find((c) => c.host === host);
      valid(c);
      if (a.action === "camera-input") await input(c, a.mode, a.dataUrl);
      else if (a.action === "scan") scan(c, a.result, a.codeType);
      else if (a.action === "stop") {
        stop(c);
        send(c, "onCameraStop");
      } else throw Error("Unsupported camera action");
      return { status: "input-sent", businessCompleted: false };
    },
  };
  window.addEventListener("pagehide", () => {
    for (const c of cameras.values()) stop(c);
    cameras.clear();
  });
  return {
    handles: (n: string) =>
      /^(insert|update|remove)(XWeb)?Camera$/.test(n) || n === "operateCamera",
    invoke,
  };
}
