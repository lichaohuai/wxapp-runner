import { devtoolsContract as frontend } from "./devtools-contract";
import { decodeJsonPreview } from "./json-preview";

// Electron 40's native PreviewFactory has image/font/text previews, but no
// audio/video view. Extend only that gap within the original Network Preview
// tab. Also decode JSON-in-JSON envelopes for display, keeping Response intact.
// The content provider reads the same captured bytes as MCP; no URL fetch.
void (async () => {
  const [UI, Network, Text, SourceFrame] = await Promise.all([
    import(frontend.ui),
    import(frontend.network),
    import(frontend.textUtils),
    import(frontend.sourceFrame),
  ]);
  const prototype = Network.RequestPreviewView.RequestPreviewView.prototype;
  const installed = Symbol.for("wxapp.media-preview.installed");
  if (prototype[installed]) return;
  const original = prototype.createPreview;
  if (typeof original !== "function")
    throw Error("Native Network preview contract is unavailable");

  class MediaPreview extends UI.Widget.VBox {
    private media: HTMLMediaElement;
    constructor(mime: string, dataURL: string, partial: boolean) {
      super();
      this.element.classList.add("request-view");
      this.media = document.createElement(
        mime.startsWith("video/") ? "video" : "audio",
      );
      this.media.controls = true;
      this.media.preload = "auto";
      this.media.muted = true;
      this.media.setAttribute("aria-label", "Captured media preview");
      this.media.style.cssText =
        "max-width:100%;max-height:70vh;margin:16px auto;display:block";
      const note = document.createElement("p");
      note.style.margin = "16px";
      note.textContent = `${mime} · 已捕获的响应内容${partial ? "（206 分段响应，可能不是完整文件）" : ""}`;
      this.media.addEventListener("error", () => {
        note.textContent = `${mime} · 媒体解码失败：响应可能不完整，或当前 Chromium 不支持此编码。可通过正文产物检查原字节。`;
      });
      this.element.append(this.media, note);
      this.media.src = dataURL;
    }
    willHide() {
      this.media.pause();
      super.willHide();
    }
  }
  class JsonPreview extends UI.Widget.VBox {
    constructor(
      decoded: ReturnType<typeof decodeJsonPreview>,
      expanded: any,
      raw: any,
    ) {
      super();
      this.element.classList.add("request-view");
      const bar = document.createElement("div");
      bar.style.cssText =
        "padding:8px;flex-shrink:0;border-bottom:1px solid var(--sys-color-divider)";
      const note = document.createElement("span");
      note.setAttribute("role", "status");
      note.textContent = `已展开 ${decoded.decoding.paths.length} 处 JSON 字符串；Response 保留原始格式（凭证仍脱敏）。${decoded.decoding.complete ? "" : "解析达到预算限制，部分字段保留原文：" + decoded.decoding.limits.join(", ")}`;
      bar.append(note);
      const paths = document.createElement("details");
      const label = document.createElement("summary");
      label.textContent = "查看解析路径";
      const list = document.createElement("pre");
      list.style.cssText =
        "max-height:100px;overflow:auto;white-space:pre-wrap";
      list.textContent = decoded.decoding.paths
        .map((p) => `${p.path || "/ (root)"} · ${p.layers} 层`)
        .join("\n");
      paths.append(label, list);
      bar.append(paths);
      this.element.append(bar);
      const body = document.createElement("div");
      body.style.cssText =
        "display:flex;flex-direction:column;flex:1;min-height:0;position:relative";
      this.element.append(body);
      let showingExpanded = true;
      expanded.show(body);
      if (raw && decoded.decoding.changed) {
        const toggle = document.createElement("button");
        toggle.textContent = "查看原始结构";
        toggle.addEventListener("click", () => {
          (showingExpanded ? expanded : raw).detach();
          showingExpanded = !showingExpanded;
          (showingExpanded ? expanded : raw).show(body);
          toggle.textContent = showingExpanded
            ? "查看原始结构"
            : "查看解析结构";
        });
        bar.append(toggle);
      }
    }
  }
  prototype.createPreview = async function () {
    const mime = String(this.request.mimeType || "").toLowerCase();
    if (/json|^text\/(plain|html)/.test(mime)) {
      const content = await this.request.requestContentData();
      if (!Text.ContentData.ContentData.isError(content)) {
        const decoded = decodeJsonPreview(content.text);
        if (decoded.decoding.changed || !decoded.decoding.complete) {
          const raw = await original.call(this);
          const expanded = decoded.isJson
            ? SourceFrame.JSONView.JSONView.createViewSync(decoded.value)
            : raw;
          return new JsonPreview(decoded, expanded, raw);
        }
      }
      return original.call(this);
    }
    if (!/^(audio|video)\//.test(mime)) return original.call(this);
    const content = await this.request.requestContentData();
    if (Text.ContentData.ContentData.isError(content))
      return new UI.EmptyWidget.EmptyWidget("媒体正文不可用", content.error);
    const dataURL = content.asDataUrl();
    if (!dataURL)
      return new UI.EmptyWidget.EmptyWidget(
        "媒体预览不可用",
        "响应无法转换为预览内容，请通过正文产物读取。",
      );
    return new MediaPreview(mime, dataURL, this.request.statusCode === 206);
  };
  prototype[installed] = true;
})().catch((error) =>
  console.error("Wxapp Network preview adapter failed", error),
);
