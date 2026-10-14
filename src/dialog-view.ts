(async () => {
  const api = (globalThis as any).wxDialog;
  const dialog = await api.config(),
    args = dialog.args;
  const main = document.querySelector("main")!,
    title = document.createElement("h2"),
    content = document.createElement("p"),
    actions = document.createElement("footer"),
    error = document.createElement("p");
  error.setAttribute("role", "alert");
  title.textContent =
    args.title ||
    args.alertText ||
    (dialog.name.startsWith("choose") ? "选择文件" : "提示");
  content.textContent = args.content || "";
  main.append(title, content);
  let input: HTMLInputElement | undefined;
  if (args.editable) {
    input = document.createElement("input");
    input.placeholder = args.placeholderText || "";
    input.setAttribute("aria-label", "输入内容");
    main.append(input);
  }
  const add = (text: string, run: () => Promise<any>, color?: string) => {
    const button = document.createElement("button");
    button.textContent = text;
    if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))
      button.style.color = color;
    button.onclick = async () => {
      button.disabled = true;
      try {
        await run();
      } catch (e: any) {
        error.textContent = e.message;
      } finally {
        button.disabled = false;
      }
    };
    actions.append(button);
  };
  if (dialog.name === "openSetting") {
    const states: Record<string, string> = {
      authorized: "已允许",
      notDetermined: "尚未询问",
      denied: "已拒绝",
      restricted: "受系统限制",
      disabled: "系统定位服务已关闭",
      unavailable: "当前平台不可用",
      unknown: "未知",
    };
    content.textContent = `小程序：${args.appid}。系统定位权限：${states[args.systemAuthorization] || "未知"}。系统权限需在 macOS「隐私与安全性 → 定位服务」中管理。`;
    const setting = { ...args.authSetting };
    const scopes = Object.keys(setting);
    if (!scopes.length) {
      const p = document.createElement("p");
      p.textContent = "此小程序尚未请求权限。";
      main.append(p);
    }
    for (const scope of scopes) {
      const label = document.createElement("label"),
        checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = setting[scope];
      checkbox.disabled = !args.supportedScopes.includes(scope);
      checkbox.onchange = () => {
        setting[scope] = checkbox.checked;
      };
      label.append(
        checkbox,
        scope === "scope.userLocation" ? "允许此小程序访问位置" : scope === "scope.camera" ? "允许此小程序使用相机" : scope,
      );
      main.append(label);
    }
    add("取消", () => api.respond({ cancel: true }));
    add("保存", () => api.respond({ authSetting: setting }));
  } else if (dialog.name === "showModal" || dialog.name === "authorize") {
    if (dialog.name === "authorize")
      content.textContent = `小程序 ${args.appid}：${args.content}`;
    if (args.showCancel !== false)
      add(
        args.cancelText || (dialog.name === "authorize" ? "拒绝" : "取消"),
        () => api.respond({ cancel: true }),
        args.cancelColor,
      );
    add(
      args.confirmText || (dialog.name === "authorize" ? "允许" : "确定"),
      () =>
        api.respond({
          confirm: true,
          ...(input ? { content: input.value } : {}),
        }),
      args.confirmColor,
    );
  } else if (dialog.name === "showActionSheet") {
    args.itemList.forEach((text: string, tapIndex: number) =>
      add(text, () => api.respond({ tapIndex })),
    );
    add("取消", () => api.respond({ cancel: true }));
  } else {
    content.textContent = `最多选择 ${args.count || 9} 个文件`;
    add("取消", () => api.respond({ cancel: true }));
    add("选择文件…", () => api.pick());
  }
  main.append(actions, error);
  new ResizeObserver(() => {
    void api
      .fit(Math.ceil(main.getBoundingClientRect().height))
      .catch(() => {});
  }).observe(main);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") void api.respond({ cancel: true });
  });
  input?.focus();
})();
