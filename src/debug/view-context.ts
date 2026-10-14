/** Causal scope is bound to actual event listeners, never a time-nearness heuristic. */
export function installViewContext(native: any, pageId: number) {
  const scopes = new WeakMap<Event, any>();
  let current: any = null;
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const wrappers = new WeakMap<object, Map<string, EventListener>>();
  const contextFor = (event: Event) => {
    let context = scopes.get(event);
    if (!context) {
      const commanded = (globalThis as any).__runnerInputContext;
      const id = commanded?.operationId || crypto.randomUUID();
      context = {
        ...(commanded || {}),
        operationId: id,
        rootOperationId: commanded?.rootOperationId || id,
        pageId,
        source: commanded
          ? "mcp-input"
          : event.isTrusted
            ? "human-input"
            : "view-event",
        eventType: event.type,
      };
      scopes.set(event, context);
      native.debug({ type: "input", context, trusted: event.isTrusted });
      if (
        !commanded &&
        event.isTrusted &&
        !["focus", "blur", "change"].includes(event.type)
      )
        native.debug({ type: "human-input", context });
    }
    return context;
  };
  const inputTypes = new Set([
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "touchstart",
    "touchend",
    "input",
    "change",
    "keydown",
    "keyup",
    "wheel",
    "focus",
    "blur",
  ]);
  // Capture human control even on UI regions without a business event handler.
  for (const type of ["pointerdown", "keydown", "wheel"])
    add.call(window, type, contextFor, { capture: true, passive: true });
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (!listener || !inputTypes.has(type))
      return add.call(this, type, listener, options);
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    let byType = wrappers.get(listener);
    if (!byType) {
      byType = new Map();
      wrappers.set(listener, byType);
    }
    const key = type + ":" + capture;
    let wrapped = byType.get(key);
    if (!wrapped) {
      wrapped = function (this: EventTarget, event: Event) {
        const parent = current;
        current = contextFor(event);
        try {
          typeof listener === "function"
            ? listener.call(this, event)
            : listener.handleEvent(event);
        } finally {
          current = parent;
        }
      };
      byType.set(key, wrapped);
    }
    return add.call(this, type, wrapped, options);
  };
  EventTarget.prototype.removeEventListener = function (
    type,
    listener,
    options,
  ) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    return remove.call(
      this,
      type,
      (listener && wrappers.get(listener)?.get(type + ":" + capture)) ||
        listener,
      options,
    );
  };
  return {
    current: () => current,
    run(context: any, fn: () => void) {
      const parent = current;
      current = context;
      try {
        fn();
      } finally {
        current = parent;
      }
    },
  };
}
