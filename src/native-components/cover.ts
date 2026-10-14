/**
 * WebView native cover contract (TextView / ImageView / ScrollView).
 * Keep the base library's own DOM, styles, component identity and event path.
 * Only replace its native-only visibility gate; never recreate business UI.
 */
export function createCoverBackend(
  w: any,
  emit: (name: string, data: any) => void,
) {
  const views = new Map<
    number,
    { host: HTMLElement; component: any; kind: string; cleanup: () => void }
  >();
  const dom = (node: any): HTMLElement | undefined =>
    node?.$$ || node?.$ || node;

  function enableDOM() {
    // 3.17.3 installs this standalone rule because native covers paint elsewhere.
    // Removing only that gate retains business CSS visibility/hidden semantics.
    for (const sheet of [...document.styleSheets]) {
      if (
        sheet.ownerNode?.textContent?.trim() !==
        "wx-cover-view, wx-cover-image { visibility: hidden; }"
      )
        continue;
      const rule = sheet.cssRules[0] as CSSStyleRule;
      if (rule?.style.visibility === "hidden")
        rule.style.visibility = "inherit";
    }
  }

  function find(id: number, kind: string) {
    return [
      ...document.querySelectorAll<HTMLElement>("wx-cover-view,wx-cover-image"),
    ].find((host: any) => {
      const c = host.__wxElement;
      return (
        c &&
        (kind === "ScrollView"
          ? c.__scrollViewId === id
          : c._vid === id || c._viewId === id)
      );
    });
  }

  function remove(id: number) {
    const item = views.get(id);
    if (!item) return;
    item.cleanup();
    views.delete(id);
    if (![...views.values()].some((v) => v.host === item.host))
      item.host.removeAttribute("data-runner-cover");
    // Baselib coalesces removals to the root. Retire descendant native IDs too.
    for (const [childId, child] of [...views])
      if (item.host.contains(child.host) && item.host !== child.host)
        remove(childId);
  }

  async function invoke(name: string, args: any) {
    const match =
      /^(insert|update|remove)(TextView|ImageView|ScrollView)$/.exec(name)!;
    const [, action, kind] = match,
      id = args.viewId;
    if (!Number.isFinite(id)) throw Error("viewId required");
    if (action === "remove") {
      remove(id);
      return { viewId: id };
    }
    let item = views.get(id);
    if (!item && action === "insert") {
      const host = find(id, kind);
      if (!host) throw Error("Cover component identity unavailable");
      const component = (host as any).__wxElement;
      enableDOM();
      host.dataset.runnerCover = "dom";
      // These are private template wrappers, not authored page elements.
      for (const key of ["container", "content"]) {
        const wrapper = dom(component.$?.[key]);
        if (wrapper?.style.visibility === "hidden")
          wrapper.style.visibility = "inherit";
      }
      const previousZ = host.style.zIndex;
      const lift =
        component._isRoot &&
        host.closest("wx-map,wx-video,wx-camera") &&
        getComputedStyle(host).zIndex === "auto";
      if (lift) host.style.zIndex = "1";
      const content = dom(component.$?.content);
      let drag: { x: number; y: number; left: number; top: number } | undefined;
      const down = (event: MouseEvent) => {
        if (event.button === 0 && content)
          drag = {
            x: event.clientX,
            y: event.clientY,
            left: content.scrollLeft,
            top: content.scrollTop,
          };
      };
      const move = (event: MouseEvent) => {
        if (!drag || !content) return;
        if (!(event.buttons & 1)) {
          drag = undefined;
          return;
        }
        const dx = event.clientX - drag.x,
          dy = event.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) < 5) return;
        if (component._scrollX) content.scrollLeft = drag.left - dx;
        if (component._scrollY) content.scrollTop = drag.top - dy;
        event.preventDefault();
      };
      const up = () => {
        drag = undefined;
      };
      const onScroll = () => {
        if (!content || !host.isConnected) return;
        host.setAttribute("data-runner-scrolling", "true");
        emit("onScrollViewScroll", {
          viewId: id,
          nodeId: component.getNodeId(),
          scrollTop: content.scrollTop,
          scrollLeft: content.scrollLeft,
          scrollWidth: content.scrollWidth,
          scrollHeight: content.scrollHeight,
        });
      };
      const onScrollEnd = () => host.removeAttribute("data-runner-scrolling");
      if (kind === "ScrollView") {
        content?.addEventListener("scroll", onScroll, { passive: true });
        content?.addEventListener("scrollend", onScrollEnd, { passive: true });
        host.addEventListener("mousedown", down);
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }
      item = {
        host,
        component,
        kind,
        cleanup: () => {
          content?.removeEventListener("scroll", onScroll);
          content?.removeEventListener("scrollend", onScrollEnd);
          host.removeAttribute("data-runner-scrolling");
          host.removeEventListener("mousedown", down);
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          if (lift && host.style.zIndex === "1") host.style.zIndex = previousZ;
        },
      };
      views.set(id, item);
    }
    if (!item || !item.host.isConnected)
      throw Error("Cover component is stale");
    // Position, color, label and image URL already belong to the original DOM.
    // Applying native screen rectangles again would double offsets/transforms.
    if (kind === "ScrollView") {
      const content = dom(item.component.$?.content);
      if (content) {
        // Native mode's private content wrapper clips overflow. It must become
        // the actual scrolling surface, matching the native ScrollView offset.
        if (args.scrollX !== undefined)
          content.style.overflowX = args.scrollX ? "auto" : "hidden";
        if (args.scrollY !== undefined)
          content.style.overflowY = args.scrollY ? "auto" : "hidden";
        if (args.scrollTop !== undefined) content.scrollTop = args.scrollTop;
        if (args.scrollLeft !== undefined) content.scrollLeft = args.scrollLeft;
      }
    }
    if (args.hide !== undefined)
      item.host.toggleAttribute("data-runner-cover-hidden", !!args.hide);
    return { viewId: id };
  }
  const style = document.createElement("style");
  style.textContent =
    "wx-cover-view,wx-cover-image {font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif} [data-runner-cover-hidden] { visibility: hidden !important; }";
  document.head.append(style);
  w.__runnerCover = {
    inspect: (host: Element) => {
      const items = [...views.entries()].filter(
        ([, v]) => v.host === host && host.isConnected,
      );
      return items.length
        ? {
            backend: "baselib-dom",
            nativeIds: items.map(([id, v]) => ({ id, kind: v.kind })),
            visible: getComputedStyle(host).visibility === "visible",
            scrolling: host.hasAttribute("data-runner-scrolling"),
          }
        : null;
    },
  };
  window.addEventListener("pagehide", () => {
    for (const id of [...views.keys()]) remove(id);
  });
  return {
    handles: (name: string) =>
      /^(insert|update|remove)(TextView|ImageView|ScrollView)$/.test(name),
    invoke,
  };
}
