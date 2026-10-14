import {
  Menu,
  MenuItem,
  webContents,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { emitController, managed } from "./controller/child";

export function toggleDevTools(target: WebContents | undefined) {
  if (!target || target.isDestroyed()) return;
  if (managed) {
    emitController({
      type: "open-devtools",
      targetId: (target as any).__runnerTargetId,
    });
    return;
  }
  if (target.isDevToolsOpened()) target.closeDevTools();
  else target.openDevTools({ mode: "detach" });
}

export function bindDevToolsShortcut(
  source: WebContents,
  getTarget: () => WebContents | undefined,
  toggleLogic: () => void,
) {
  source.on("before-input-event", (event, input) => {
    const editModifier =
      process.platform === "darwin"
        ? input.meta && !input.control
        : input.control && !input.meta;
    const editKey = input.key.toLowerCase();
    if (
      source === getTarget() &&
      editModifier &&
      !input.alt &&
      ["a", "c", "v", "x", "z", "y"].includes(editKey)
    ) {
      // Native edit accelerators otherwise target the BrowserWindow shell on macOS.
      event.preventDefault();
      if (input.type === "keyDown") {
        const action = (
          {
            a: "selectAll",
            c: "copy",
            v: "paste",
            x: "cut",
            z: input.shift ? "redo" : "undo",
            y: "redo",
          } as const
        )[editKey as "a"];
        source[action]();
      }
      return;
    }
    const f12 = input.key === "F12";
    const inspector =
      input.key.toLowerCase() === "i" &&
      (process.platform === "darwin"
        ? input.meta && input.alt && !input.control && !input.shift
        : input.control && input.shift && !input.meta && !input.alt);
    if (!f12 && !inspector) return;
    // Stop Chromium/menu shortcuts from opening the shell inspector as well.
    event.preventDefault();
    if (input.type === "keyDown" && !input.isAutoRepeat)
      f12 ? toggleLogic() : toggleDevTools(getTarget());
  });
}

export function installDevToolsMenu(
  getCurrentPage: () => WebContents | undefined,
  toggleLogic: () => void,
) {
  // Rebuild the existing menu without Electron's shell-targeting default role.
  const copyItems = (items: MenuItem[]): MenuItemConstructorOptions[] =>
    items
      .filter((item) => item.role?.toLowerCase() !== "toggledevtools")
      .map((item): MenuItemConstructorOptions => ({
        id: item.id,
        label: item.label,
        type: item.type,
        enabled: item.enabled,
        visible: item.visible,
        checked: item.checked,
        accelerator: item.accelerator || undefined,
        ...(item.submenu
          ? { submenu: copyItems(item.submenu.items) }
          : item.role
            ? { role: item.role }
            : {
                click: (menuItem, window, event) =>
                  item.click(menuItem, window, event),
              }),
      }));
  const menu = Menu.buildFromTemplate(
    copyItems(Menu.getApplicationMenu()?.items || []),
  );
  const toggle = () => {
    const focused = webContents.getFocusedWebContents();
    const owner =
      focused &&
      webContents
        .getAllWebContents()
        .find((w) => w.devToolsWebContents === focused);
    toggleDevTools(owner || getCurrentPage());
  };
  menu.append(
    new MenuItem({
      label: "调试",
      submenu: [
        {
          id: "runner-inspector-shortcut",
          label: "当前页面开发者工具",
          accelerator:
            process.platform === "darwin" ? "Alt+Command+I" : "Control+Shift+I",
          click: toggle,
        },
        {
          id: "runner-toggle-devtools",
          label: "逻辑调试（Network / Console / Sources）",
          accelerator: "F12",
          click: toggleLogic,
        },
      ],
    }),
  );
  Menu.setApplicationMenu(menu);
}
