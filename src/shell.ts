const w = window as any;
const runner = w.runner;
const config = runner.config();
let state: any = {};
const nav = document.querySelector("nav")!;
async function navigate(name: string, args: any) {
  const r = await runner.navigate(name, args);
  if (r.error) {
    document.querySelector("#toast")!.textContent = r.error;
    setTimeout(
      () => (document.querySelector("#toast")!.textContent = ""),
      6000,
    );
  }
}
(document.querySelector("#back") as HTMLElement).onclick = () =>
  navigate("navigateBack", {});
(document.querySelector("#share-menu") as HTMLElement).onclick = () => {
  void runner
    .nativeRequest("__shareMenu", { pageId: state.pageId })
    .catch((e: Error) => {
      document.querySelector("#toast")!.textContent = e.message;
    });
};
function renderTabs() {
  const m = state;
  const tabBar = m.tabBar || config.tabBar;
  const showTabBar =
    (m.showTabBar ?? m.isTab) && tabBar?.custom !== true;
  nav.style.display = showTabBar ? "flex" : "none";
  if (!showTabBar) return;
  nav.style.backgroundColor = tabBar?.backgroundColor || "white";
  nav.style.borderTopColor = tabBar?.borderStyle === "white" ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.05)";
  for (const [index, item] of (tabBar?.list || []).entries()) {
    const active = item.pagePath.replace(/\.html$/, "") === m.route;
    // Badge pushes can arrive while a user/MCP click is in progress. Keep the
    // button and label identities stable instead of rebuilding the whole bar.
    const b =
      (nav.children[index] as HTMLButtonElement) ||
      document.createElement("button");
    b.style.color = active ? tabBar.selectedColor : tabBar.color;
    const img = b.querySelector("img") || document.createElement("img");
    const icon = (key: string) => item[key + "Path"] ||
      (item[key + "Data"] ? "data:image/png;base64," + item[key + "Data"] : "");
    const src = (active ? icon("selectedIcon") : "") || icon("icon");
    if (src) { if (img.getAttribute("src") !== src) img.setAttribute("src", src); }
    else img.removeAttribute("src");
    img.hidden = !src;
    if (!img.parentNode) b.appendChild(img);
    const label =
      b.querySelector(".tab-label") || document.createElement("span");
    label.className = "tab-label";
    if (label.textContent !== item.text) label.textContent = item.text;
    if (!label.parentNode) b.appendChild(label);
    b.style.position = "relative";
    const badge = m.tabBadges?.[index];
    if (
      badge?.type === "redDot" ||
      (badge?.type === "text" && badge.badgeValue)
    ) {
      const mark =
        b.querySelector<HTMLElement>(".tab-badge") ||
        document.createElement("span");
      mark.className = "tab-badge";
      mark.dataset.index = String(index);
      mark.dataset.type = badge.type;
      const value = badge.type === "text" ? badge.badgeValue : "";
      if (mark.textContent !== value) mark.textContent = value;
      mark.style.cssText =
        "position:absolute;top:2px;left:calc(50% + 6px);background:#f43530;color:white;border-radius:12px;pointer-events:none;font-size:10px;line-height:16px;min-width:16px;padding:0 4px";
      if (badge.type === "redDot")
        mark.style.cssText += ";width:8px;height:8px;min-width:8px;padding:0";
      if (!mark.parentNode) b.appendChild(mark);
    } else b.querySelector(".tab-badge")?.remove();
    // app-config tab paths are rooted at the package, unlike a business
    // navigateTo("../detail") URL which is relative to the current page.
    b.onclick = () =>
      navigate("switchTab", { url: "/" + item.pagePath.replace(/^\//, "") });
    if (!b.parentNode) nav.appendChild(b);
  }
  while (nav.children.length > (tabBar?.list?.length || 0))
    nav.lastChild?.remove();
}
w.__runnerSetTabBarBadges = async (badges: any) => {
  state.tabBadges = badges;
  renderTabs();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
runner.onMessage((m: any) => {
  if (m.type !== "shell-state") return;
  state = m;
  document.querySelector("#title")!.textContent = m.title;
  (document.querySelector("#back") as HTMLButtonElement).disabled = !m.canBack;
  document.querySelector("header")!.style.display =
    m.showNavigationBar === false ? "none" : "flex";
  const ui = m.pageUi;
  if (ui) {
    const header = document.querySelector("header")!;
    header.style.backgroundColor =
      ui.navigationBar.navigationBarBackgroundColor;
    header.style.color =
      ui.navigationBar.navigationBarTextStyle === "white"
        ? "#ffffff"
        : "#000000";
    (document.querySelector("#nav-loading") as HTMLElement).style.display = ui
      .navigationBar.showLoading
      ? "inline-block"
      : "none";
    (document.querySelector("#share-menu") as HTMLElement).hidden =
      !ui.share.showShareMenu && !ui.share.showShareTimelineMenu;
  }
  renderTabs();
});
