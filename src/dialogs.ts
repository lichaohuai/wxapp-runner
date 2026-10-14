import {
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  type WebContents,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function dialogResult(name: string, args: any, response: any) {
  if (name === "openSetting") {
    if (
      response.confirm !== undefined ||
      response.files !== undefined ||
      response.tapIndex !== undefined ||
      response.content !== undefined
    )
      throw Error("Settings require authSetting or cancel");
    if (response.cancel) {
      if (response.authSetting !== undefined)
        throw Error("Cancel cannot include settings");
      return { cancel: true };
    }
    const setting = response.authSetting;
    if (
      !setting ||
      typeof setting !== "object" ||
      Array.isArray(setting) ||
      Object.keys(setting).some(
        (k) =>
          !Object.hasOwn(args.authSetting, k) ||
          !args.supportedScopes.includes(k) ||
          typeof setting[k] !== "boolean",
      )
    )
      throw Error(
        "Settings may change supported, previously requested scopes only",
      );
    return { authSetting: { ...setting } };
  }
  if (response.authSetting !== undefined)
    throw Error("authSetting is only valid for openSetting");
  if (response.cancel) {
    if (name === "showModal" || name === "authorize")
      return { confirm: false, cancel: true };
    throw Error("cancel");
  }
  if (name === "showModal" || name === "authorize") {
    if (
      typeof response.confirm !== "boolean" ||
      response.files !== undefined ||
      response.tapIndex !== undefined
    )
      throw Error("Modal requires confirm or cancel");
    if (response.content !== undefined && !args.editable)
      throw Error("Modal is not editable");
    return {
      confirm: response.confirm,
      cancel: !response.confirm,
      ...(args.editable ? { content: response.content ?? "" } : {}),
    };
  }
  if (name === "showActionSheet") {
    if (
      !Number.isInteger(response.tapIndex) ||
      response.tapIndex < 0 ||
      response.tapIndex >= args.itemList.length ||
      response.confirm !== undefined ||
      response.files !== undefined ||
      response.content !== undefined
    )
      throw Error("Invalid action sheet response");
    return { tapIndex: response.tapIndex };
  }
  if (
    response.confirm !== undefined ||
    response.tapIndex !== undefined ||
    response.content !== undefined
  )
    throw Error("File chooser requires files");
  const paths = response.files;
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.length > (args.count || 9) ||
    new Set(paths).size !== paths.length
  )
    throw Error("Invalid file count");
  const image = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "heic"],
    video = ["mp4", "mov", "m4v", "webm", "avi"];
  const allowed =
    name === "chooseImage"
      ? image
      : name === "chooseMedia"
        ? (args.mediaType || ["image", "video"]).flatMap((t: string) =>
            t === "image" ? image : t === "video" ? video : [],
          )
        : args.extension?.map((x: string) =>
            x.replace(/^\./, "").toLowerCase(),
          );
  const files = paths.map((file: string) => {
    if (!path.isAbsolute(file)) throw Error("File path must be absolute");
    const extension = path.extname(file).slice(1).toLowerCase();
    if (allowed?.length && !allowed.includes(extension))
      throw Error("File does not match the requested type");
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw Error("Select regular files only");
    fs.accessSync(file, fs.constants.R_OK);
    return {
      path: file,
      tempFilePath: file,
      name: path.basename(file),
      size: stat.size,
      type: path.extname(file),
      fileType: video.includes(extension) ? "video" : "image",
    };
  });
  return { tempFilePaths: files.map((f) => f.path), tempFiles: files };
}
export class DialogController {
  private pending = new Map<string, any>();
  constructor(
    private parent: () => BrowserWindow,
    private event: (e: any) => void,
  ) {
    ipcMain.handle("wx-dialog-config", (e) => this.bySender(e.sender).public);
    ipcMain.handle("wx-dialog-respond", (e, args) =>
      this.respond({ ...args, id: this.bySender(e.sender).public.id }),
    );
    ipcMain.handle("wx-dialog-fit", (e, height) => {
      const item = this.bySender(e.sender);
      if (!Number.isFinite(height) || height < 0 || height > 100000)
        throw Error("Invalid dialog content height");
      const parent = this.parent();
      const workArea = screen.getDisplayMatching(
        parent.getBounds(),
      ).workAreaSize;
      const [width] = item.window.getContentSize();
      item.window.setContentSize(
        width,
        Math.min(Math.max(120, Math.ceil(height)), workArea.height - 100),
      );
      if (!item.window.isVisible()) item.window.show();
      return { fitted: true };
    });
    ipcMain.handle("wx-dialog-pick", async (e) => {
      const item = this.bySender(e.sender);
      const r = await dialog.showOpenDialog(item.window, {
        properties: [
          "openFile",
          ...(item.public.args.count === 1 ? [] : ["multiSelections" as const]),
        ],
      });
      if (!this.pending.has(item.public.id)) return { closed: true };
      if (r.canceled) return { canceled: true };
      return this.respond({ id: item.public.id, files: r.filePaths });
    });
  }
  private bySender(sender: WebContents) {
    const item = [...this.pending.values()].find(
      (v) => v.window?.webContents === sender,
    );
    if (!item) throw Error("Dialog closed");
    return item;
  }
  list() {
    return [...this.pending.values()].map((v) => v.public);
  }
  request(name: string, args: any, viewId?: number) {
    if (
      name === "showActionSheet" &&
      (!Array.isArray(args.itemList) ||
        !args.itemList.length ||
        args.itemList.length > 6)
    )
      return Promise.reject(Error("itemList must contain 1–6 items"));
    if (
      name.startsWith("choose") &&
      args.count !== undefined &&
      (!Number.isInteger(args.count) || args.count < 1 || args.count > 100)
    )
      return Promise.reject(Error("Invalid file count"));
    if (this.pending.size >= 8)
      return Promise.reject(Error("Too many pending dialogs"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const item: any = {
        public: { id, name, args, viewId, createdAt: new Date().toISOString() },
        resolve,
        reject,
      };
      this.pending.set(id, item);
      const window = (item.window = new BrowserWindow({
        width: Math.max(
          320,
          Math.min(480, this.parent().getContentSize()[0] - 32),
        ),
        height: 160,
        useContentSize: true,
        parent: this.parent(),
        modal: true,
        title: "WxappRunner · " + name,
        resizable: false,
        show: false,
        webPreferences: {
          preload: path.join(__dirname, "dialog-preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      }));
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (e) => e.preventDefault());
      window.on("closed", () => {
        if (this.pending.has(id)) this.respond({ id, cancel: true });
      });
      void window
        .loadFile(path.join(__dirname, "dialog.html"))
        .catch((e) => this.finish(item, undefined, e));
      this.event({ type: "dialog-opened", ...item.public });
    });
  }
  respond(response: any) {
    const item = this.pending.get(response.id);
    if (!item) throw Error("Dialog closed or already answered");
    let result;
    try {
      result = dialogResult(item.public.name, item.public.args, response);
    } catch (e: any) {
      if (response.cancel && e.message === "cancel") {
        this.finish(item, undefined, e);
        return { id: response.id, status: "cancelled" };
      }
      throw e;
    }
    this.finish(item, result);
    return {
      id: response.id,
      status: "response-sent",
      businessCompleted: false,
    };
  }
  private finish(item: any, result: any, error?: Error) {
    if (!this.pending.delete(item.public.id)) return;
    if (!item.window?.isDestroyed()) item.window?.destroy();
    this.event({
      type: "dialog-closed",
      id: item.public.id,
      name: item.public.name,
      cancelled: !!error || !!result?.cancel,
    });
    error ? item.reject(error) : item.resolve(result);
  }
  closeView(viewId: number) {
    for (const item of this.pending.values())
      if (item.public.viewId === viewId)
        this.finish(item, undefined, Error("page closed"));
  }
  close() {
    for (const item of this.pending.values())
      this.finish(item, undefined, Error("runtime closed"));
  }
}
