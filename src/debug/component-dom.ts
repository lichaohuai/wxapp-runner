/** Adapters for the actual backend nodes exposed by the pinned 3.17.3 base library. No geometry matching. */
export function installComponentInspection(pageId: number, route: string) {
  const w = globalThis as any;
  function describe(element: Element, componentDefinitions: string[] = []) {
    let node: any;
    for (
      let el: any = element;
      el && !node;
      el = el.parentElement || el.getRootNode()?.host
    )
      node = el.__wxElement;
    if (!node)
      return {
        status: "unknown",
        reason: "No framework backend node",
        pageId,
        route,
      };
    const framework =
      "_$nodeTreeContext" in node
        ? "glass-easel"
        : "__domElement" in node
          ? "exparser"
          : null;
    if (!framework)
      return {
        status: "unknown",
        reason: "Unsupported backend shape",
        pageId,
        route,
      };
    const owner = (n: any) =>
      framework === "glass-easel"
        ? n.ownerShadowRoot?._$host
        : n.ownerShadowRoot?.__wxHost;
    const custom = (n: any) =>
      framework === "glass-easel"
        ? componentDefinitions.includes(n.is) && !!n.shadowRoot
        : n.__component__ === true;
    const ids: string[] = [],
      seen = new Set<any>();
    while (node && !seen.has(node)) {
      seen.add(node);
      const next = owner(node);
      if (
        !next &&
        (node.tagName === "body" || node === (document.body as any).__wxElement)
      )
        break;
      if (custom(node)) {
        const id = framework === "glass-easel" ? node._$nodeId : node.__id;
        if (!id)
          return {
            status: "unknown",
            reason: "Component has no scoped ID",
            framework,
            pageId,
            route,
          };
        ids.unshift(String(id));
      }
      node = next;
    }
    if (!node || seen.size > 100)
      return {
        status: "unknown",
        reason: "No confirmed page owner",
        framework,
        pageId,
        route,
      };
    return {
      status: "mapped",
      method: "framework-owner-chain-and-public-component-ids",
      framework,
      pageId,
      route,
      componentPath: ids,
    };
  }
  w.__runnerDescribeComponent = describe;
  w.__runnerLocateComponent = (
    identity: any,
    clientId: string,
    componentDefinitions: string[] = [],
  ) => {
    if (String(identity.pageId) !== String(pageId))
      throw Error("Component belongs to another page");
    const matches: Element[] = [];
    const scan = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll("*")) {
        const node = (el as any).__wxElement;
        if (
          node &&
          (node.__component__ === true ||
            (componentDefinitions.includes(node.is) && node.shadowRoot))
        ) {
          const d = describe(el, componentDefinitions);
          if (
            d.status === "mapped" &&
            JSON.stringify(d.componentPath) ===
              JSON.stringify(identity.componentPath)
          )
            matches.push(el);
        }
        if (el.shadowRoot) scan(el.shadowRoot);
      }
    };
    if (!identity.componentPath.length) matches.push(document.body);
    else scan(document);
    if (matches.length !== 1)
      return {
        status: "unknown",
        reason: `Owner chain matched ${matches.length} DOM hosts`,
      };
    const el = matches[0];
    const snapshots = (w.__runnerMcpSnapshots ||= new Map());
    let map = snapshots.get(clientId);
    if (!map) {
      map = new Map();
      snapshots.set(clientId, map);
    }
    const nodeId = "component:" + crypto.randomUUID();
    map.set(nodeId, el);
    const r = el.getBoundingClientRect();
    return {
      ...describe(el, componentDefinitions),
      nodeId,
      tag: el.tagName.toLowerCase(),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
  };
}
