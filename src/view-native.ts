import { nativeObservation } from "./contracts/observe";
import { createMapBackend } from "./native-components/map";
import { createCoverBackend } from "./native-components/cover";
import { createCameraBackend } from "./native-components/camera";
import { createVideoBackend } from "./native-components/video.js";

export function createViewNative(w: any, native: any) {
  const inputs = new Map<number, HTMLTextAreaElement | HTMLInputElement>();
  let nextInputId = 1000000;
  const positioning = new Map<number, any>();
  function emit(name: string, data: any) {
    w.WeixinJSBridge.subscribeHandler(name, data, w.__webviewId__);
  }
  const video = createVideoBackend(w, emit);
  const camera = createCameraBackend(w, emit, native);
  const map = createMapBackend(w, emit, native);
  const cover = createCoverBackend(w, emit);
  const backends = [video, camera, map, cover];
  function field(n: string, a: any) {
    if (n.startsWith("insert") && !Number.isFinite(a.inputId))
      a.inputId = ++nextInputId;
    let el = inputs.get(a.inputId);
    if (n.startsWith("remove")) {
      el?.remove();
      inputs.delete(a.inputId);
      return;
    }
    if (!el && !n.startsWith("insert"))
      return { errMsg: n + ":fail input not found" };
    if (!el) {
      el = document.createElement(
        n.includes("TextArea") ? "textarea" : "input",
      );
      el.dataset.nativeInput = String(a.inputId);
      Object.assign(el.style, {
        position: "absolute",
        background: "transparent",
        border: "0",
        outline: "none",
        resize: "none",
        padding: "0",
        boxSizing: "border-box",
        // Native keyboard input sits above the page's fixed navigation bar,
        // but below the runner's modal/loading masks.
        zIndex: "2147483000",
        fontFamily: "inherit",
      });
      document.body.appendChild(el);
      inputs.set(a.inputId, el);
      const e = el;
      const detail = () => ({
        inputId: a.inputId,
        value: e.value,
        cursor: e.selectionStart || 0,
        height: 0,
      });
      e.addEventListener("focus", () => emit("onKeyboardShow", detail()));
      e.addEventListener("input", () =>
        emit("onKeyboardValueChange", detail()),
      );
      e.addEventListener("blur", () => {
        emit("onKeyboardComplete", detail());
        // Legacy showKeyboard creates a temporary native editor. The base
        // library clears its input ID on completion; retaining this overlay
        // intercepts the next tap with an editor no component owns anymore.
        if (a.transientKeyboard) {
          inputs.delete(a.inputId);
          e.remove();
        }
      });
      e.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key === "Enter" && e.tagName === "INPUT")
          emit("onKeyboardConfirm", detail());
      });
    }
    const style = a.style || {};
    for (const key of [
      "width",
      "height",
      "minHeight",
      "fontSize",
      "left",
      "top",
    ])
      if (style[key] != null && Number.isFinite(style[key]) && style[key] >= 0)
        el.style[key as any] =
          style[key] + (key === "top" ? window.scrollY : 0) + "px";
    for (const key of ["color", "fontWeight", "textAlign"])
      if (style[key]) el.style[key as any] = style[key];
    if (a.placeholder !== undefined) el.placeholder = a.placeholder;
    if (a.value !== undefined && el.value !== String(a.value))
      el.value = String(a.value);
    if (el.tagName === "INPUT")
      (el as HTMLInputElement).type = a.password
        ? "password"
        : a.type === "number"
          ? "number"
          : "text";
    if (a.maxLength !== undefined) {
      if (a.maxLength < 0) el.removeAttribute("maxlength");
      else el.maxLength = a.maxLength;
    }
    if (a.disabled !== undefined) el.disabled = a.disabled;
    if (a.hidden !== undefined) el.hidden = a.hidden;
    if (a.focus) queueMicrotask(() => el?.focus());
    return { inputId: a.inputId, lineCount: 1, height: style.height };
  }
  const globalStore = new Map<string, any>();
  let callSequence=0;
  return function invoke(n: string, json: string, id: number) {
    const observation=native.contractObservation ? nativeObservation(n,"view",{pageId:w.__webviewId__},`view:${w.__webviewId__}:${++callSequence}`,native.contractObservation) : undefined;
    const reply=(result:any)=>{const value=w.WeixinJSBridge.invokeCallbackHandler(id,result);observation?.callback();return value;};
    try {const result=dispatch(n,json,id,reply);observation?.returned(result);return result;}
    catch(error) {observation?.threw();throw error;}
  };
  function dispatch(n: string, json: string, id: number, reply:(result:any)=>void) {
    const a = JSON.parse(json || "{}");
    let data: any = {};
    const backend = backends.find((b) => b.handles(n));
    if (backend) {
      backend
        .invoke(n, a)
        .then(
          (data) => ({ errMsg: n + ":ok", ...data }),
          (error) => ({ errMsg: n + ":fail " + error.message }),
        )
        .then((result) => {
          w.__runnerObserveNative?.(n, a, result);
          if (id) reply(result);
        });
      return "";
    }
    if (/^(insert|update|remove)PositioningContainer$/.test(n)) {
      if (n.startsWith("remove")) positioning.delete(a.containerId);
      else
        positioning.set(a.containerId, {
          ...positioning.get(a.containerId),
          ...a,
        });
      const result = { errMsg: n + ":ok", containerId: a.containerId };
      w.__runnerObserveNative?.(n, a, result);
      // The component subscribes after requesting its parent's container.
      // A synchronous acknowledgment loses positioningContainerReady and leaves
      // every child native component waiting forever.
      if (id)
        queueMicrotask(() =>
          reply(result),
        );
      return "";
    }
    if (/^(insert|update|remove)(TextArea|Input)$/.test(n)) {
      data = field(n, a) || {};
      const result = { errMsg: n + ":ok", ...data };
      w.__runnerObserveNative?.(n, a, result);
      if (id) {
        queueMicrotask(() =>
          reply(result),
        );
        return "";
      }
    } else if (n === "showKeyboard") {
      // Legacy exparser inputs are created by showKeyboard itself, whereas
      // newer native inputs first call insertInput and later pass its ID.
      if (!inputs.has(a.inputId) && a.style)
        data =
          field("insertInput", {
            ...a,
            value: a.defaultValue ?? a.value ?? "",
            focus: false,
            transientKeyboard: true,
          }) || {};
      const inputId = data.inputId ?? a.inputId;
      const el = inputs.get(inputId);
      const result = el
        ? { errMsg: n + ":ok", inputId }
        : { errMsg: n + ":fail input not found" };
      w.__runnerObserveNative?.(n, a, result);
      queueMicrotask(() => {
        if (id) reply(result);
        if (el) {
          el.focus();
          const start =
            a.selectionStart >= 0
              ? a.selectionStart
              : a.cursor >= 0
                ? a.cursor
                : el.value.length;
          if (el.type !== "number")
            el.setSelectionRange(
              start,
              a.selectionEnd >= 0 ? a.selectionEnd : start,
            );
        }
      });
      return "";
    } else if (n === "setKeyboardValue") {
      const el = inputs.get(a.inputId);
      if (el && a.value !== undefined) el.value = String(a.value);
      if (id)
        queueMicrotask(() =>
          reply({
            errMsg: n + (el ? ":ok" : ":fail input not found"),
          }),
        );
      return "";
    } else if (n === "hideKeyboard") {
      (document.activeElement as HTMLElement)?.blur();
    } else if (n === "getGlobalStorage")
      data = { data: globalStore.get(a.key) || "" };
    else if (n === "setGlobalStorage") globalStore.set(a.key, a.data);
    else if (n === "removeGlobalStorage") globalStore.delete(a.key);
    else if (n === "getGlobalStorageInfo")
      data = { keys: [...globalStore.keys()] };
    else if (n === "loadWAFile") {
      native.nativeRequest(n, a).then(reply, (error: any) => reply({errMsg: n + ":fail " + error.message}));
      return "";
    }
    else if (n === "loadJsFiles" || n === "loadLibFiles") {
      native.log("VIEW LAZY FILES", JSON.stringify(a.paths));
      // WAPCAdapter LoadJsFilesJsApiImpl awaits page.eval before replying.
      // A synchronous :ok here races the actual script load and lets the
      // base library use component factories that have not registered yet.
      const finish = (error?: unknown) => {
        const result = {
          errMsg: error
            ? n +
              ":fail " +
              (error instanceof Error ? error.message : String(error))
            : n + ":ok",
        };
        if (error) native.log("VIEW LAZY FILES FAILED", result.errMsg, {
          api: n,
          paths: a.paths,
          name: error instanceof Error ? error.name : "Error",
          stack: error instanceof Error ? error.stack : undefined,
          operationRepeated: false,
        });
        if (id) reply(result);
      };
      (async () => {
        if (
          !Array.isArray(a.paths) ||
          a.paths.some((f: unknown) => typeof f !== "string" || !f)
        )
          throw Error("paths must be an array of non-empty strings");
        if (n === "loadLibFiles") {
          if (!native.loadLibraries) throw Error("Foundation library loading is unavailable");
          await native.loadLibraries(a.paths);
        }
        else if (native.loadScripts) await native.loadScripts(a.paths);
        else for (const f of a.paths) await native.loadScript(f);
      })().then(() => finish(), finish);
      return "";
    } else {
      const result = native.invoke(n, json, id);
      w.__runnerObserveNative?.(n, a, result);
      return result;
    }
    return JSON.stringify({ errMsg: n + ":ok", ...data });
  };
}
