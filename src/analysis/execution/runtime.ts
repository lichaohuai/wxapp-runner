/** Serialized into one business realm. Native JS evaluates operators/assignments. */
export function executionRuntime(config: any = {}) {
  const g: any = globalThis;
  if (g.__wxappExecutionV1) return g.__wxappExecutionV1;
  const define = Object.defineProperty,
    descriptor = Object.getOwnPropertyDescriptor,
    ownKeys = Reflect.ownKeys,
    apply = Reflect.apply,
    construct = Reflect.construct,
    now = g.__runnerAnalysisContext?.now || Date.now.bind(Date),
    json = JSON.stringify,
    nativeCall = Function.prototype.call,
    nativeApply = Function.prototype.apply,
    arrayPrototype = Array.prototype,
    objectPrototype = Object.prototype,
    arrayConstructor = Array,
    getPrototypeOf = Object.getPrototypeOf,
    arraySpeciesGetter = descriptor(Array, Symbol.species)?.get;
  const capacity = config.capacity || 10000,
    valueLimit = config.valueLimit || 1024;
  const byteLimit = config.byteLimit || 268435456;
  // Bounded side-pool of full-length strings that snapshot() would truncate but
  // that a crypto op might consume, so cryptoCandidates can rehash the real
  // input. Keyed by content (dedup); FIFO-evicted; separate from the global
  // byte cap so it never enlarges the per-event snapshot.
  const cryptoStrings = new Map<string, any>();
  let cryptoStringBytes = 0;
  const cryptoStringMax = config.cryptoStringMax || 4096,
    cryptoStringByteBudget = config.cryptoStringByteBudget || 8388608;
  let retainedBytes = 0, frameEvictions = 0, frameGaps = 0;
  // Separate budget for state-mode init retention so it never competes with the
  // invocation's byteLimit (a full init would otherwise starve the target run).
  let initStateBytes = 0;
  const closedFrames = new Set<number>();
  const recordBytes = new Map<number, number>();
  const invocationIds = new Set<number>();
  let lastEvictedEvent = 0;
  // Per-run event buckets exempt from the capacity FIFO. A pinned run's events
  // are retained until the run stops (or is dropped from the runs cap), so a
  // matched request's causal chain survives long enough to be sliced.
  const pinned = new Map<string, number[]>();
  let initialization: any = null;
  const realmId =
    g.__runnerAnalysisContext?.realmId ||
    config.realmId ||
    String(now()) + "-" + Math.random().toString(36).slice(2);
  const byId = new Map<number, any>(),
    frames = new Map<number, any>(),
    heap = new WeakMap<object, Map<any, any>>(),
    objects = new WeakMap<object, string>(),
    functionSites = new WeakMap<Function, string>(),
    managedAliases = new WeakSet<Function>(),
    handles = new Map<string, any>(),
    oracles = new Map<string, any>(),
    sites: any = {},
    files = new Map<string, any>(),
    runs = new Map<string, any>(),
    watches = new Map<string, any>(),
    slices = new Map<string, any>();
  let sequence = 0,
    frameSeq = 0,
    objectSeq = 0,
    runSeq = 0,
    watchSeq = 0,
    oracleSeq = 0,
    sliceSeq = 0,
    active: any = null,
    mute = 0;
  const isProxy = (v: any) => g.__runnerAnalysisContext?.isProxy?.(v) === true;
  const ctx = () => g.__runnerAnalysisContext?.get() || {};
  const hush = (fn: () => any) => {
    mute++;
    try {
      return fn();
    } catch {
      return undefined;
    } finally {
      mute--;
    }
  };
  const objectId = (o: any) => {
    if (o === null || !["object", "function"].includes(typeof o)) return null;
    let id = objects.get(o);
    if (!id) {
      id = "object-" + realmId + "-" + ++objectSeq;
      objects.set(o, id);
    }
    return id;
  };
  const snapshot = (v: any): any => {
    if (v === null || ["number", "boolean", "undefined"].includes(typeof v))
      return v;
    if (typeof v === "string")
      return v.length > valueLimit
        ? {
            preview: v.slice(0, valueLimit),
            truncated: true,
            characters: v.length,
          }
        : v;
    if (typeof v === "bigint") return { bigint: String(v) };
    if (typeof v === "symbol") return { symbol: String(v) };
    return { objectId: objectId(v), type: typeof v };
  };
  // Retain only long strings (> valueLimit, <= the host hash() 8192 ceiling):
  // short strings survive untruncated on their events, and anything the host
  // cannot hash is useless here. Bounded by count and total bytes.
  const retainCryptoString = (
    v: any,
    eventId: number,
    kind: string,
    site: string,
  ) => {
    if (typeof v !== "string" || v.length <= valueLimit || v.length > 8192)
      return;
    if (cryptoStrings.has(v)) return;
    const cost = v.length * 2;
    if (cost > cryptoStringByteBudget) return;
    while (
      cryptoStrings.size &&
      (cryptoStrings.size >= cryptoStringMax ||
        cryptoStringBytes + cost > cryptoStringByteBudget)
    ) {
      const oldest = cryptoStrings.keys().next().value!;
      cryptoStringBytes -= oldest.length * 2;
      cryptoStrings.delete(oldest);
    }
    cryptoStrings.set(v, {
      eventId,
      kind,
      runId: active?.id,
      location: sites[site],
    });
    cryptoStringBytes += cost;
  };
  const frame = (id: number) => frames.get(id);
  const fresh = (id: any) => {
    const r = byId.get(id);
    return r
      ? r.runId === active?.id || r.runId === initialization?.id
        ? r.id
        : null
      : active && id >= active.start && id <= sequence
        ? id
        : null;
  };
  const deps = (f: any, ids: any[]) =>
    ids.map((id) => fresh(f?.latest.get(id))).filter(Boolean);
  const condition = (p: any, env: any): any => {
    if (!p) return true;
    if (p.type === "literal") return p.value;
    if (p.type === "root") return env[p.name];
    if (p.type === "member") {
      const o = condition(p.object, env);
      if (o == null || isProxy(o)) return undefined;
      const d = descriptor(Object(o), p.key);
      return d && "value" in d ? d.value : undefined;
    }
    if (p.type === "unary") {
      const x = condition(p.arg, env);
      return p.op === "!"
        ? !x
        : p.op === "typeof"
          ? typeof x
          : p.op === "-"
            ? -x
            : +x;
    }
    const x = condition(p.left, env);
    if (p.op === "&&") return x && condition(p.right, env);
    if (p.op === "||") return x || condition(p.right, env);
    const y = condition(p.right, env);
    switch (p.op) {
      case "===":
        return x === y;
      case "!==":
        return x !== y;
      case "==":
        return x == y;
      case "!=":
        return x != y;
      case ">":
        return x > y;
      case ">=":
        return x >= y;
      case "<":
        return x < y;
      case "<=":
        return x <= y;
      case "+":
        return x + y;
      case "-":
        return x - y;
      case "*":
        return x * y;
      case "/":
        return x / y;
      case "%":
        return x % y;
    }
  };
  const record = (
    site: string,
    kind: string,
    value: any,
    dependencies: any[] = [],
    extra: any = {},
    fid?: number,
  ): any => {
    if (mute || !active || active.state !== "recording") return null;
    if (now() > active.expiresAt || active.count >= active.maxEvents) {
      active.state = "limited";
      active.reason = now() > active.expiresAt ? "ttl" : "event-limit";
      return null;
    }
    // state-mode init: keep only property writes. Non-writes (reads, calls,
    // branches) are startup noise for the purpose of recovering the init state
    // tables; skipping them here means the maxEvents cap counts writes only and
    // the retained set stays compact. Their recorders still run their own
    // side-effects (ref tracking, setHeap) around this call.
    if (
      active === initialization &&
      active.mode === "state" &&
      kind !== "put" &&
      kind !== "delete"
    )
      return null;
    return hush(() => {
      const id = ++sequence,
        r = {
          id,
          runId: active.id,
          time: now(),
          operationId: ctx().operationId,
          rootOperationId: ctx().rootOperationId,
          kind,
          site,
          location: sites[site],
          frameId: fid,
          parentFrameId: frame(fid!)?.parent,
          functionSite: frame(fid!)?.site,
          callPath: frame(fid!)?.path,
          value: snapshot(value),
          deps: [...new Set(dependencies.filter(Boolean))],
          controlDeps: [...(frame(fid!)?.controls?.values() || [])].map(fresh).filter(Boolean),
          ...extra,
        };
      const inherited = extra.callId
        ? byId.get(extra.callId)?.logpointIds || []
        : [];
      const matched = [...inherited];
      for (const w of watches.values())
        if (
          w.mode === "logpoint" &&
          w.remaining > 0 &&
          w.expiresAt > now() &&
          r.location?.file === w.location.file &&
          r.location.line === w.location.line &&
          (!w.location.column || r.location.column === w.location.column) &&
          (!w.kinds || w.kinds.includes(kind)) &&
          condition(w.condition, {
            args: r.args,
            result: r.value,
            thisArg: r.receiver,
          })
        ) {
          matched.push(w.id);
          w.remaining--;
        }
      if (matched.length)
        Object.assign(r, {
          logpointIds: matched,
          stack: new Error().stack?.slice(0, 3000),
        });
      // Conservative serialized UTF-16 record budget. Not a V8 heap measurement.
      const bytes = json(r).length * 2 + 128;
      // state-mode init writes use their own budget (initStateBytes, bounded in
      // retainInitStateEvent) and never count against the invocation byteLimit.
      const initStateWrite =
        active === initialization && active.mode === "state" && kind === "put";
      if (!initStateWrite && retainedBytes + bytes > byteLimit) {
        sequence--;
        active.state = "limited";
        active.reason = "byte-limit";
        return null;
      }
      recordBytes.set(id, bytes);
      if (initStateWrite) initStateBytes += bytes;
      else retainedBytes += bytes;
      byId.set(id, r);
      active.count++;
      retainCryptoString(value, id, kind, site);
      if (r.runId !== initialization?.id) {
        const bucket = active.pinRun ? pinned.get(active.id) : undefined;
        if (bucket) bucket.push(id);
        else invocationIds.add(id);
      }
      if (invocationIds.size > capacity) {
        const oldId = invocationIds.values().next().value!;
        invocationIds.delete(oldId);
        const old = byId.get(oldId)!;
        lastEvictedEvent = Math.max(lastEvictedEvent,oldId);
        byId.delete(old.id);
        retainedBytes -= recordBytes.get(old.id) || 0;
        recordBytes.delete(old.id);
        const oldRun = runs.get(old.runId);
        if (oldRun) {oldRun.evicted++;oldRun.lastEvictedEvent=old.id;}
      }
      frame(fid!)?.latest.set(site, id);
      return id;
    });
  };
  const fm = (fid: number) =>
    frame(fid) || {
      latest: new Map(),
      cells: new Map(),
      refs: new Map(),
      tests: new Map(),
    };
  const toKey = (v: any) => ownKeys({ [v]: null })[0];
  const ref = (fid: number, site: string) => fm(fid).refs.get(site)?.at(-1);
  const popRef = (fid: number, site: string) => fm(fid).refs.get(site)?.pop();
  const entry = (o: any, k: any) =>
    o != null && ["object", "function"].includes(typeof o)
      ? heap.get(o)?.get(k)
      : undefined;
  // Compact current-state retention for state-mode init: keep only the latest
  // write event per (object,key) and evict superseded ones, so the retained set
  // approximates the live state tables rather than the whole init history.
  // LRU-bounded by stateCap. Only touches events already exempt from the FIFO
  // (init-run events, line ~274); full-mode init and invocation are untouched.
  const initStateIds = new Set<number>();
  const dropInitStateEvent = (evId: any) => {
    if (evId == null || !initStateIds.has(evId)) return;
    initStateIds.delete(evId);
    if (byId.has(evId)) {
      initStateBytes -= recordBytes.get(evId) || 0;
      recordBytes.delete(evId);
      byId.delete(evId);
    }
  };
  const retainInitStateEvent = (id: number) => {
    initStateIds.add(id);
    const cap = initialization?.stateCap || 200000;
    const budget = initialization?.stateByteBudget || 134217728;
    while (
      initStateIds.size > 1 &&
      (initStateIds.size > cap || initStateBytes > budget)
    )
      dropInitStateEvent(initStateIds.values().next().value);
  };
  const setHeap = (o: any, k: any, id: any, v: any) => {
    if (!objectId(o)) return;
    const stateMode = active === initialization && active?.mode === "state";
    const prior = stateMode ? heap.get(o)?.get(k)?.id : undefined;
    if (!id) {
      heap.get(o)?.delete(k);
      if (stateMode) dropInitStateEvent(prior);
      return;
    }
    let m = heap.get(o);
    if (!m) {
      m = new Map();
      heap.set(o, m);
    }
    if (m.size < 2000 || m.has(k)) {
      m.set(k, { id, valueObjectId: objectId(v) });
      if (stateMode) {
        if (prior != null && prior !== id) dropInitStateEvent(prior);
        retainInitStateEvent(id);
      }
    }
  };
  const fields = (o: any, depth = 0, seen = new WeakSet<object>()): any => {
    if (!objectId(o) || depth > 3 || seen.has(o) || isProxy(o)) return null;
    seen.add(o);
    const out: any = { objectId: objectId(o), properties: {} };
    let count = 0;
    try {
      for (const k of ownKeys(o)) {
        if (typeof k !== "string") continue;
        if (++count > 80) {
          out.truncated = true;
          break;
        }
        const d = descriptor(o, k);
        if (!d || !("value" in d)) continue;
        define(out.properties, k, {
          enumerable: true,
          value: {
            ref: fresh(entry(o, k)?.id),
            value: snapshot(d.value),
            object: depth < 3 ? fields(d.value, depth + 1, seen) : undefined,
          },
        });
      }
    } catch {
      out.uninspectable = true;
    }
    return out;
  };
  const finishPut = (
    site: string,
    value: any,
    ids: any[],
    fid: number,
    compound: boolean,
    deleted = false,
  ) => {
    const f = fm(fid),
      r = popRef(fid, site);
    if (!r) return value;
    hush(() => {
      const previous = r.previous || entry(r.base, r.key),
        d =
          r.unknownKey || isProxy(r.base)
            ? undefined
            : descriptor(Object(r.base), r.key),
        stored = d && "value" in d ? d.value : undefined;
      const id = recordUnmuted(
        site,
        deleted ? "delete" : "put",
        value,
        [...deps(f, ids), ...(compound ? [fresh(previous?.id)] : [])],
        {
          objectId: objectId(r.base),
          property: r.unknownKey
            ? "[object key: coercion unobserved]"
            : typeof r.key === "symbol"
              ? String(r.key)
              : r.key,
          storedValue: snapshot(stored),
          storage: deleted
            ? "delete-result"
            : d && "value" in d
              ? "own-data-observed"
              : "setter/proxy/inherited-unknown",
          operator: sites[site]?.operator,
          prefix: sites[site]?.prefix,
          stack: new Error().stack?.slice(0, 3000),
        },
        fid,
      );
      if (deleted) {
        if (value) heap.get(r.base)?.delete(r.key);
      } else if (d && "value" in d) setHeap(r.base, r.key, id, stored);
    });
    return value;
  };
  // Guard object inspection while allowing one record. User getters are never read here.
  function recordUnmuted(...args: any[]) {
    mute--;
    try {
      return (record as any)(...args);
    } finally {
      mute++;
    }
  }
  const nativeNames = new Map<Function, string>();
  for (const [o, names, label] of [
    [Object, ["assign", "defineProperty", "defineProperties"], "Object"],
    [Reflect, ["set", "deleteProperty", "defineProperty"], "Reflect"],
    [JSON, ["stringify", "parse"], "JSON"],
    [String, ["fromCharCode", "fromCodePoint"], "String"],
    [Number.prototype, ["toString"], "Number"],
    [g, ["parseInt", "parseFloat"], "Global"],
    [
      String.prototype,
      [
        "toUpperCase",
        "toLowerCase",
        "slice",
        "substring",
        "substr",
        "concat",
        "charAt",
        "charCodeAt",
        "codePointAt",
        "indexOf",
        "lastIndexOf",
        "includes",
        "startsWith",
        "endsWith",
        "split",
        "trim",
        "trimStart",
        "trimEnd",
      ],
      "String",
    ],
    [
      Array.prototype,
      [
        "join",
        "sort",
        "push",
        "pop",
        "shift",
        "unshift",
        "splice",
        "concat",
        "slice",
        "reverse",
        "indexOf",
        "lastIndexOf",
        "includes",
      ],
      "Array",
    ],
    [Math, ["floor", "ceil", "trunc", "abs", "min", "max", "random"], "Math"],
    [Date, ["now"], "Date"],
  ] as any[])
    for (const name of names) nativeNames.set(o[name], label + "." + name);
  const nativeSearchFns = new WeakSet(
    [...nativeNames]
      .filter(([, name]) =>
        ["Array.indexOf", "Array.lastIndexOf", "Array.includes"].includes(name),
      )
      .map(([fn]) => fn),
  );
  const nativeSplice = arrayPrototype.splice;
  // The event cache owns values. Slice sessions retain only IDs and small page
  // metadata, so reading a graph neither duplicates bodies nor reruns business code.
  function explainPage(a: any) {
    for (const [id, job] of slices)
      if (job.expiresAt <= now()) slices.delete(id);
    let job: any,
      pageIndex = 0;
    if (a.sliceCursor) {
      const split = a.sliceCursor.lastIndexOf(":"),
        id = a.sliceCursor.slice(0, split),
        index = a.sliceCursor.slice(split + 1);
      job = slices.get(id);
      if (!job || !/^(0|[1-9][0-9]*)$/.test(index))
        throw Error(
          "SLICE_CURSOR_EXPIRED_OR_UNKNOWN: restart explain with eventId",
        );
      pageIndex = Number(index);
      if (a.expandEvents && json(a.expandEvents) !== json(job.expandEvents)) throw Error("SLICE_OPTIONS_MISMATCH");
      if (
        pageIndex > job.pages.length ||
        (pageIndex === job.pages.length && job.done)
      )
        throw Error("SLICE_CURSOR_INVALID");
      for (const [key, expected] of [
        ["eventId", job.sinkId],
        ["maxNodes", job.pageSize],
        ["includeAddress", job.includeAddress],
        ["maxTotalNodes", job.maxTotalNodes],
      ])
        if (a[key] !== undefined && a[key] !== expected)
          throw Error(
            "SLICE_OPTIONS_MISMATCH: continuation inherits its initial options",
          );
    } else {
      const sink = byId.get(a.eventId);
      if (!sink) throw Error("EVENT_EVICTED_OR_UNKNOWN");
      const pageSize = a.maxNodes ?? 500,
        maxTotalNodes = a.maxTotalNodes ?? 250000;
      if (
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 2000 ||
        !Number.isInteger(maxTotalNodes) ||
        maxTotalNodes < 1 ||
        maxTotalNodes > 1000000
      )
        throw Error("SLICE_LIMIT_INVALID");
      job = {
        id: `slice-${realmId}-${++sliceSeq}`,
        sinkId: sink.id,
        runId: sink.runId,
        snapshotCursor: sequence,
        pageSize,
        maxTotalNodes,
        includeAddress: !!a.includeAddress,
        expandEvents: a.expandEvents || [],
        expiresAt: now() + 300000,
        queued: new Set([sink.id]),
        pending: [sink.id],
        pages: [],
        visited: 0,
        missing: 0,
        opaque: 0,
        truncated: false,
        done: false,
      };
      if (slices.size >= 4) slices.delete(slices.keys().next().value!);
      slices.set(job.id, job);
    }
    if (pageIndex === job.pages.length) {
      const ids: number[] = [],
        missing: number[] = [],
        opaque: number[] = [];
      let scanned = 0;
      while (job.pending.length && scanned < job.pageSize) {
        const id = job.pending.pop();
        scanned++;
        job.visited++;
        const event = byId.get(id);
        if (!event) {
          missing.push(id);
          job.missing++;
          continue;
        }
        ids.push(id);
        if (event.opaque || event.provenance?.startsWith("unobserved")) {
          opaque.push(id);
          job.opaque++;
        }
        for (const dependency of [
          ...event.deps,
          ...(job.includeAddress || job.expandEvents.includes(id) ? event.addressDeps || [] : []),
          ...(job.expandEvents.includes(id) ? event.controlDeps || [] : []),
        ]) {
          if (job.queued.has(dependency)) continue;
          if (job.queued.size >= job.maxTotalNodes) {
            job.truncated = true;
            job.reason = "node-limit";
            continue;
          }
          job.queued.add(dependency);
          job.pending.push(dependency);
        }
      }
      if (job.pages.length >= 9999 && job.pending.length) {
        job.truncated = true;
        job.reason = "page-limit";
        job.pending.length = 0;
      }
      job.done = !job.pending.length;
      ids.sort((a, b) => a - b);
      job.pages.push({
        ids,
        missing,
        opaqueBoundaries: opaque,
        scanned,
        visitedNodes: job.visited,
        missingCount: job.missing,
        opaqueCount: job.opaque,
        hasMore: !job.done,
        complete: job.done && !job.truncated && !job.missing,
        truncated: job.truncated,
        reason: job.reason,
      });
    }
    const page = job.pages[pageIndex],
      entries = page.ids.map((id: number) => byId.get(id));
    if (entries.some((e: any) => !e))
      throw Error(
        "SLICE_PAGE_EVICTED: previously returned events no longer retained",
      );
    const { ids, ...metadata } = page;
    return {
      ...metadata,
      entries,
      sliceId: job.id,
      sliceCursor: `${job.id}:${pageIndex}`,
      nextSliceCursor: page.hasMore ? `${job.id}:${pageIndex + 1}` : null,
      sinkId: job.sinkId,
      runId: job.runId,
      snapshotCursor: job.snapshotCursor,
      expiresAt: job.expiresAt,
      pageIndex,
      maxTotalNodes: job.maxTotalNodes,
      addressDependenciesIncluded: job.includeAddress,
      expandedEvents: job.expandEvents,
      representation:
        "executed-path dependency slice; paged, ID-linked, not globally ordered",
      generalizedAlgorithm: false,
    };
  }
  const api: any = {
    beginSource(file: string) {
      if (!initialization || active === initialization || active?.state === "recording") return null;
      if (initialization.reason || now() > initialization.expiresAt) return null;
      const previous = active;
      active = initialization; initialization.state = "recording";
      return {previous};
    },
    endSource(marker: any) {
      if (!marker) return;
      if (initialization.state === "recording") initialization.state="stopped";
      active=marker.previous;
    },
    isRecording(runId: string) {
      return (
        active?.id === runId &&
        active.state === "recording" &&
        active.expiresAt > now()
      );
    },
    register(info: any) {
      Object.assign(sites, info.sites);
      files.set(info.fileId, {
        file: info.file,
        hash: info.hash,
        sites: Object.keys(info.sites).length,
        gaps: info.gaps,
      });
    },
    functionLocation(fn: any) {
      const site = functionSites.get(fn);
      return site ? { ...sites[site], site } : null;
    },
    describe(id: number) {
      const e = byId.get(id);
      return e
        ? { site: e.site, location: e.location, callPath: e.callPath }
        : undefined;
    },
    alias(fn: any, wrapper: any) {
      if (typeof wrapper === "function") managedAliases.add(wrapper);
      const site = functionSites.get(fn);
      if (site) functionSites.set(wrapper, site);
      const native = nativeNames.get(fn);
      if (native) nativeNames.set(wrapper, native);
    },
    mark(site: string, fn: any, name: string, owner?: number) {
      if (owner && frame(owner)) {frame(owner).pinned=true;closedFrames.delete(owner);}
      if (typeof fn === "function") {
        functionSites.set(fn, site);
        if (name && !fn.name)
          hush(() => define(fn, "name", { value: name, configurable: true }));
      }
      return fn;
    },
    enter(site: string) {
      const id = ++frameSeq,
        c = ctx();
      while (frames.size >= 20000 && closedFrames.size) {
        const old = closedFrames.values().next().value!;
        closedFrames.delete(old); frames.delete(old); frameEvictions++;
      }
      if (frames.size >= 20000) { frameGaps++; return id; }
      if (c.executionInvocation?.site === site) (c.executionInvocation.frames ??= []).push(id);
      frames.set(id, {
        id,
        site,
        executing: true,
        parent: c.executionFrame,
        inScope:
          site === active?.functionSite || !!frame(c.executionFrame)?.inScope,
        path: [...(frame(c.executionFrame)?.path || []), site].slice(-32),
        invocation:
          c.executionInvocation?.site === site
            ? c.executionInvocation
            : undefined,
        latest: new Map(),
        cells: new Map(),
        refs: new Map(),
        tests: new Map(),
        controls: new Map(),
      });
      record(site, "enter", undefined, [], {}, id);
      return id;
    },
    leave(fid: number) {
      const f=frame(fid); if (!f) return;
      f.executing = false;
      f.refs.clear();
      if (!f.pinned) closedFrames.add(fid);
    },
    branch(site: string, value: any, ids: string[], fid: number) {
      record(site, "branch", !!value, deps(fm(fid), ids), {}, fid);
      return value;
    },
    controlEnter(site: string, fid: number) { fm(fid).controls?.set(site, fm(fid).latest.get(site)); },
    controlLeave(site: string, fid: number) { fm(fid).controls?.delete(site); },
    parameter(binding: string, value: any, index: number, fid: number) {
      const f = fm(fid),
        inv = f.invocation,
        origin = fresh(inv?.argRefs?.[index]),
        id = record(
          f.site,
          "parameter",
          value,
          [origin],
          {
            binding,
            index,
            provenance: origin ? "argument" : "unobserved-argument",
          },
          fid,
        );
      f.cells.set(binding, id);
    },
    read(
      site: string,
      value: any,
      binding: string,
      owner: number,
      fid: number,
    ) {
      record(
        site,
        "read",
        value,
        [fresh(fm(owner).cells.get(binding))],
        {
          binding,
          provenance: fresh(fm(owner).cells.get(binding))
            ? "binding"
            : "unobserved-binding",
        },
        fid,
      );
      return value;
    },
    beforeVar(site: string, binding: string, owner: number, fid: number) {
      const f = fm(fid),
        stack = f.refs.get(site) || [];
      if (stack.length >= 64) stack.shift();
      stack.push({ variable: true, id: fresh(fm(owner).cells.get(binding)) });
      f.refs.set(site, stack);
    },
    writeVar(
      site: string,
      value: any,
      binding: string,
      owner: number,
      ids: any[],
      fid: number,
    ) {
      const id = record(
        site,
        "write",
        value,
        [
          ...deps(fm(fid), ids),
          ref(fid, site)?.variable ? popRef(fid, site).id : null,
        ],
        { binding, operator: sites[site]?.operator },
        fid,
      );
      fm(owner).cells.set(binding, id);
      return value;
    },
    updateVar(
      site: string,
      value: any,
      binding: string,
      owner: number,
      fid: number,
    ) {
      const f = fm(owner),
        id = record(
          site,
          "update",
          value,
          [fresh(f.cells.get(binding))],
          {
            binding,
            operator: sites[site]?.operator,
            prefix: sites[site]?.prefix,
          },
          fid,
        );
      f.cells.set(binding, id);
      return value;
    },
    value(site: string, value: any, ids: any[], fid: number) {
      record(
        site,
        sites[site]?.kind || "value",
        value,
        deps(fm(fid), ids),
        { operator: sites[site]?.operator },
        fid,
      );
      return value;
    },
    test(site: string, value: any, fid: number) {
      fm(fid).tests.set(site, { truthy: !!value, nullish: value == null });
      return value;
    },
    logical(site: string, value: any, op: string, ids: any[], fid: number) {
      const f = fm(fid),
        test = f.tests.get(site),
        right =
          op === "&&"
            ? test?.truthy
            : op === "||"
              ? !test?.truthy
              : test?.nullish;
      record(
        site,
        "logical",
        value,
        deps(f, right ? ids : [ids[0]]),
        { operator: op },
        fid,
      );
      return value;
    },
    selected(site: string, value: any, ids: any[], fid: number) {
      const f = fm(fid),
        selected = f.tests.get(site)?.truthy ? 1 : 2;
      record(
        site,
        "conditional",
        value,
        deps(f, [ids[0], ids[selected]]),
        { branch: selected },
        fid,
      );
      return value;
    },
    get(site: string, base: any, key: any, ids: any[], fid: number) {
      if (base == null) return base[key];
      const k = toKey(key),
        value = base[k],
        primitiveString =
          typeof base === "string" &&
          (k === "length" ||
            (typeof k === "string" &&
              /^(0|[1-9][0-9]*)$/.test(k) &&
              Number(k) < base.length));
      record(
        site,
        "get",
        value,
        primitiveString ? deps(fm(fid), [ids[0]]) : [fresh(entry(base, k)?.id)],
        {
          objectId: objectId(base),
          addressDeps: deps(fm(fid), ids),
          property: typeof k === "symbol" ? String(k) : k,
          provenance: primitiveString
            ? "primitive-string"
            : fresh(entry(base, k)?.id)
              ? "heap-write"
              : "unobserved-property",
        },
        fid,
      );
      return value;
    },
    base(site: string, base: any, fid: number) {
      const f = fm(fid),
        stack = f.refs.get(site) || [];
      if (stack.length >= 64) stack.shift();
      stack.push({ base });
      f.refs.set(site, stack);
      return base;
    },
    key(site: string, key: any, fid: number) {
      const r = ref(fid, site);
      const objectKey =
        key !== null && ["object", "function"].includes(typeof key);
      const converted = (k: any) => {
        if (r) {
          r.key = k;
          if (!r.converted) r.previous = entry(r.base, k);
          r.converted = true;
        }
        record(
          site,
          "write-attempt",
          undefined,
          [],
          {
            objectId: objectId(r?.base),
            property: typeof k === "symbol" ? String(k) : k,
          },
          fid,
        );
        return k;
      };
      if (objectKey)
        return {
          [Symbol.toPrimitive]() {
            return converted(toKey(key));
          },
        };
      converted(typeof key === "symbol" ? key : String(key));
      return key;
    },
    pattern(site: string, value: any, ids: any[], fid: number) {
      while (ref(fid, site)) finishPut(site, value, ids, fid, false);
      return value;
    },
    put: finishPut,
    deleted(site: string, value: any, fid: number) {
      return finishPut(site, value, [], fid, false, true);
    },
    object(site: string, value: any, props: any[], fid: number) {
      const f = fm(fid),
        id = record(
          site,
          "object",
          value,
          deps(
            f,
            props.map((p) => p[1]),
          ),
          {},
          fid,
        );
      hush(() => {
        for (const [k, child] of props) {
          const d = descriptor(value, k);
          if (!d || !("value" in d)) continue;
          const e = recordUnmuted(
            site,
            "put",
            d.value,
            [...deps(f, [child])],
            {
              objectId: objectId(value),
              property: k,
              storage: "literal-own-data",
            },
            fid,
          );
          setHeap(value, k, e, d.value);
        }
        f.latest.set(site, id);
      });
      return value;
    },
    array(site: string, value: any, ids: any[], fid: number, spread = false) {
      const f = fm(fid),
        id = record(
          site,
          "array",
          value,
          deps(f, ids),
          {
            opaque: spread,
            unknownElementPositions: spread ? { from: ids.length } : undefined,
          },
          fid,
        );
      hush(() => {
        for (let i = 0; i < Math.min(value.length, 1000); i++) {
          const d = descriptor(value, String(i));
          if (d && "value" in d)
            setHeap(
              value,
              String(i),
              fresh(f.latest.get(ids[i])) || id,
              d.value,
            );
        }
        f.latest.set(site, id);
      });
      return value;
    },
    fn(fn: any) {
      return { fn, base: undefined };
    },
    method(base: any, key: any, ids: any[] = [], fid = 0) {
      if (base == null) return { fn: base[key], base };
      const k = toKey(key);
      // Snapshot before argument evaluation; later arguments may reassign the base binding.
      return { fn: base[k], base, key: k, receiverRefs: deps(fm(fid), ids) };
    },
    invoke(
      site: string,
      reference: any,
      args: any[],
      ids: any[],
      fid: number,
      isNew: boolean,
      spread = false,
    ) {
      if (!active || active.state !== "recording")
        return isNew
          ? construct(reference.fn, args)
          : apply(reference.fn, reference.base, args);
      const f = fm(fid),
        isCall = reference.fn === nativeCall,
        isApply = reference.fn === nativeApply;
      let effectiveArgs = args,
        effectiveRefs = ids.map((id) => fresh(f.latest.get(id))),
        effectiveFn = reference.fn,
        effectiveReceiver = reference.base,
        receiverRefs = reference.receiverRefs || [];
      if (isCall) {
        effectiveFn = reference.base;
        effectiveReceiver = args[0];
        receiverRefs = [effectiveRefs[0]];
        effectiveArgs = args.slice(1);
        effectiveRefs = effectiveRefs.slice(1);
      }
      if (isApply && Array.isArray(args[1]) && !isProxy(args[1])) {
        const ds = hush(() => Object.getOwnPropertyDescriptors(args[1]));
        if (ds && Object.values(ds).every((d: any) => "value" in d)) {
          effectiveFn = reference.base;
          effectiveReceiver = args[0];
          receiverRefs = [effectiveRefs[0]];
          effectiveArgs = Array.from(
            { length: Math.min(args[1].length, 1000) },
            (_, i) => ds[String(i)]?.value,
          );
          effectiveRefs = effectiveArgs.map((_, i) =>
            fresh(entry(args[1], String(i))?.id),
          );
        }
      }
      const inv: any = {
          site: functionSites.get(effectiveFn),
          argRefs: effectiveRefs,
          receiverRefs,
        },
        name = nativeNames.get(effectiveFn),
        start = record(
          site,
          "call",
          undefined,
          [...inv.argRefs, ...(effectiveReceiver == null ? [] : receiverRefs)],
          {
            callee: sites[site]?.expression,
            native: name,
            opaque: spread,
            unknownArgumentPositions: spread ? { from: ids.length } : undefined,
            calleeLocation: sites[inv.site],
            args: hush(() => effectiveArgs.map(snapshot)),
            receiver: hush(() => snapshot(effectiveReceiver)),
            receiverDeps: receiverRefs.filter(Boolean),
            argumentDeps: inv.argRefs.filter(Boolean),
            dependencyMeaning: "observed-call-inputs",
            argumentsHeap: hush(() => effectiveArgs.map((x) => fields(x))),
          },
          fid,
        );
      // Crypto inputs arrive as call arguments (e.g. the concatenated sign
      // string passed to MD5); retain the untruncated arg for later rehashing.
      if (typeof start === "number")
        for (let i = 0; i < Math.min(effectiveArgs.length, 32); i++)
          retainCryptoString(effectiveArgs[i], start, "call-arg", site);
      if (
        start &&
        typeof effectiveFn === "function" &&
        (!isProxy(effectiveFn) || inv.site || managedAliases.has(effectiveFn))
      ) {
        handles.set(String(start), {
          fn: effectiveFn,
          receiver: effectiveReceiver,
          site: inv.site,
          callSite: site,
          location: sites[site],
          expiresAt: now() + 300000,
        });
        if (handles.size > 1000) handles.delete(handles.keys().next().value!);
      }
      const arr =
        Array.isArray(effectiveReceiver) && !isProxy(effectiveReceiver)
          ? effectiveReceiver
          : null;
      const arrLength = arr
        ? hush(() => descriptor(arr, "length")?.value)
        : undefined;
      const popped =
        arr && name === "Array.pop"
          ? fresh(entry(arr, String(arrLength - 1))?.id)
          : null;
      const aggregate =
        arr &&
        ["Array.join", "Array.shift", "Array.reverse"].includes(name || "")
          ? hush(() =>
              Array.from(heap.get(arr)?.values() || [], (x: any) =>
                fresh(x.id),
              ),
            ) || []
          : [];
      // Native search on a dense, ordinary array has no user callbacks or key
      // coercions. Inspect only data descriptors, then check against the actual
      // native result. Exotic receivers remain opaque; never rerun a getter.
      const searchPlan =
        arr &&
        nativeSearchFns.has(effectiveFn) &&
        ["Array.indexOf", "Array.lastIndexOf", "Array.includes"].includes(
          name || "",
        )
          ? hush(() => {
              if (
                getPrototypeOf(arr) !== arrayPrototype ||
                arrLength > 2000 ||
                (effectiveArgs.length > 1 &&
                  effectiveArgs[1] !== undefined &&
                  typeof effectiveArgs[1] !== "number")
              )
                return null;
              const backward = name === "Array.lastIndexOf";
              let from =
                effectiveArgs.length < 2 && backward
                  ? arrLength - 1
                  : (effectiveArgs[1] ?? 0);
              from = Number.isNaN(from) ? 0 : Math.trunc(from);
              let index = backward
                ? from >= 0
                  ? Math.min(from, arrLength - 1)
                  : arrLength + from
                : from >= 0
                  ? from
                  : Math.max(arrLength + from, 0);
              const refs: number[] = [],
                indices: number[] = [];
              let known = true,
                match = -1;
              for (
                ;
                index >= 0 && index < arrLength;
                index += backward ? -1 : 1
              ) {
                const d = descriptor(arr, String(index));
                if (!d || !("value" in d)) return null;
                indices.push(index);
                const input = fresh(entry(arr, String(index))?.id);
                if (input) refs.push(input);
                else known = false;
                if (
                  d.value === effectiveArgs[0] ||
                  (name === "Array.includes" &&
                    Number.isNaN(d.value) &&
                    Number.isNaN(effectiveArgs[0]))
                ) {
                  match = index;
                  break;
                }
              }
              return {
                refs,
                known,
                indices,
                result: name === "Array.includes" ? match !== -1 : match,
              };
            })
          : null;
      const splicePlan =
        arr && effectiveFn === nativeSplice && !spread
          ? hush(() => {
              if (
                getPrototypeOf(arr) !== arrayPrototype ||
                arrLength > 2000 ||
                descriptor(arr, "constructor") ||
                getPrototypeOf(arrayPrototype) !== objectPrototype ||
                getPrototypeOf(objectPrototype) !== null ||
                descriptor(arrayPrototype, "constructor")?.value !==
                  arrayConstructor ||
                descriptor(arrayConstructor, Symbol.species)?.get !==
                  arraySpeciesGetter ||
                effectiveArgs
                  .slice(0, 2)
                  .some((x) => x !== undefined && typeof x !== "number")
              )
                return null;
              const integer = (x: any) =>
                x === undefined || Number.isNaN(x) ? 0 : Math.trunc(x);
              const relative = integer(effectiveArgs[0]),
                from =
                  relative < 0
                    ? Math.max(arrLength + relative, 0)
                    : Math.min(relative, arrLength),
                remove =
                  effectiveArgs.length === 0
                    ? 0
                    : effectiveArgs.length === 1
                      ? arrLength - from
                      : Math.min(
                          Math.max(integer(effectiveArgs[1]), 0),
                          arrLength - from,
                        );
              const original: { value: any; ref: any }[] = [];
              for (let i = 0; i < arrLength; i++) {
                const d = descriptor(arr, String(i));
                if (!d || !("value" in d)) return null;
                original.push({
                  value: d.value,
                  ref: fresh(entry(arr, String(i))?.id),
                });
              }
              const inserted = effectiveArgs
                .slice(2)
                .map((value, i) => ({ value, ref: inv.argRefs[i + 2] }));
              const after = [
                ...original.slice(0, from),
                ...inserted,
                ...original.slice(from + remove),
              ];
              if (after.length > 2000) return null;
              return {
                from,
                after,
                removed: original.slice(from, from + remove),
              };
            })
          : null;
      // Only model native concat when no getter, Proxy, custom species or
      // spreadability hook can change its copy semantics. Inspect descriptors,
      // never execute user code a second time to infer a result's provenance.
      const copyPlan =
        ["Array.concat", "Array.slice"].includes(name || "") && arr
          ? hush(() => {
              if (
                getPrototypeOf(arrayPrototype) !== objectPrototype ||
                getPrototypeOf(objectPrototype) !== null ||
                descriptor(arrayPrototype, "constructor")?.value !==
                  arrayConstructor ||
                descriptor(arrayConstructor, Symbol.species)?.get !==
                  arraySpeciesGetter ||
                descriptor(arrayPrototype, Symbol.isConcatSpreadable) ||
                descriptor(objectPrototype, Symbol.isConcatSpreadable)
              )
                return null;
              const copied: any[] = [];
              const slicing = name === "Array.slice";
              if (
                slicing &&
                (effectiveArgs.length > 2 ||
                  effectiveArgs.some(
                    (x) => x !== undefined && !Number.isInteger(x),
                  ))
              )
                return null;
              const index = (n: number, length: number) =>
                n < 0 ? Math.max(0, length + n) : Math.min(n, length);
              for (const [inputIndex, input] of (slicing
                ? [arr]
                : [arr, ...effectiveArgs]
              ).entries()) {
                if (
                  input !== null &&
                  ["object", "function"].includes(typeof input)
                ) {
                  if (
                    isProxy(input) ||
                    !Array.isArray(input) ||
                    getPrototypeOf(input) !== arrayPrototype ||
                    descriptor(input, Symbol.isConcatSpreadable) ||
                    (inputIndex === 0 && descriptor(input, "constructor"))
                  )
                    return null;
                  const length = descriptor(input, "length")?.value;
                  if (!Number.isInteger(length)) return null;
                  const from = slicing
                    ? index(effectiveArgs[0] ?? 0, length)
                    : 0;
                  const to = slicing
                    ? index(effectiveArgs[1] ?? length, length)
                    : length;
                  if (Math.max(0, to - from) + copied.length > 2000)
                    return null;
                  for (let i = from; i < to; i++) {
                    const d = descriptor(input, String(i));
                    if (!d) {
                      if (
                        descriptor(arrayPrototype, String(i)) ||
                        descriptor(objectPrototype, String(i))
                      )
                        return null;
                      copied.push({ hole: true });
                      continue;
                    }
                    if (!("value" in d)) return null;
                    copied.push({
                      value: d.value,
                      ref: fresh(entry(input, String(i))?.id),
                    });
                  }
                } else {
                  if (copied.length >= 2000) return null;
                  copied.push({
                    value: input,
                    ref: inv.argRefs[inputIndex - 1],
                  });
                }
              }
              return copied;
            })
          : null;
      const mutationTarget =
        name === "Reflect.set" && effectiveArgs.length > 3
          ? effectiveArgs[3]
          : effectiveArgs[0];
      const mutationKeys: any[] =
        hush(() => {
          if (!name) return [];
          if (
            [
              "Object.defineProperty",
              "Reflect.set",
              "Reflect.defineProperty",
              "Reflect.deleteProperty",
            ].includes(name)
          )
            return typeof effectiveArgs[1] === "symbol" ||
              effectiveArgs[1] === null ||
              !["object", "function"].includes(typeof effectiveArgs[1])
              ? [
                  typeof effectiveArgs[1] === "symbol"
                    ? effectiveArgs[1]
                    : String(effectiveArgs[1]),
                ]
              : [];
          const sources =
            name === "Object.assign"
              ? effectiveArgs.slice(1)
              : name === "Object.defineProperties"
                ? [effectiveArgs[1]]
                : [];
          return [
            ...new Set(
              sources.flatMap((x) =>
                x != null && !isProxy(x)
                  ? ownKeys(Object(x)).filter(
                      (k) => descriptor(Object(x), k)?.enumerable,
                    )
                  : [],
              ),
            ),
          ].slice(0, 100);
        }) || [];
      for (const key of mutationKeys)
        record(
          site,
          "write-attempt",
          undefined,
          [],
          {
            objectId: objectId(mutationTarget),
            property: typeof key === "symbol" ? String(key) : key,
            native: name,
          },
          fid,
        );
      const c = {
        ...ctx(),
        executionFrame: fid,
        executionInvocation: inv,
        executionRunId: active?.id,
        executionEventId: start,
      };
      try {
        const perform = () =>
            isNew
              ? construct(reference.fn, args)
              : apply(reference.fn, reference.base, args),
          value = g.__runnerAnalysisContext
            ? g.__runnerAnalysisContext.run(c, perform)
            : perform();
        const search =
          searchPlan && searchPlan.result === value ? searchPlan : null;
        const splice =
          splicePlan &&
          hush(() => {
            const matches = (object: any, items: any[]) =>
              Array.isArray(object) &&
              !isProxy(object) &&
              descriptor(object, "length")?.value === items.length &&
              items.every((item, i) => {
                const d = descriptor(object, String(i));
                return d && "value" in d && Object.is(d.value, item.value);
              });
            return matches(arr, splicePlan.after) &&
              matches(value, splicePlan.removed)
              ? splicePlan
              : null;
          });
        const end = record(
          site,
          "call-return",
          value,
          [
            start,
            fresh(inv.returnRef),
            popped,
            ...aggregate,
            ...(search?.refs || []),
          ],
          {
            callId: start,
            callee: sites[site]?.expression,
            native: name,
            ...(splice ? { mutation: "mapped-dense-splice" } : {}),
            ...(search
              ? {
                  provenance: search.known
                    ? "native-array-search"
                    : "unobserved-array-search-input",
                  searchRange: {
                    first: search.indices[0] ?? null,
                    last: search.indices.at(-1) ?? null,
                    count: search.indices.length,
                  },
                }
              : {}),
            opaque:
              !inv.returnRef &&
              !search?.known &&
              !(
                name?.startsWith("Math.") &&
                name !== "Math.random" &&
                effectiveArgs.every(
                  (x) =>
                    x === null ||
                    ["undefined", "number", "string", "boolean"].includes(
                      typeof x,
                    ),
                )
              ) &&
              !(name === "Array.pop" && popped) &&
              !(
                [
                  "String.fromCharCode",
                  "String.fromCodePoint",
                  "Global.parseInt",
                  "Global.parseFloat",
                ].includes(name || "") &&
                effectiveArgs.every(
                  (x) =>
                    x === null || !["object", "function"].includes(typeof x),
                )
              ) &&
              !(
                name === "Number.toString" &&
                typeof effectiveReceiver === "number" &&
                effectiveArgs.every(
                  (x) =>
                    x === null || !["object", "function"].includes(typeof x),
                )
              ) &&
              !(
                name?.startsWith("String.") &&
                typeof effectiveReceiver === "string" &&
                effectiveArgs.every(
                  (a: any) =>
                    a === null || !["object", "function"].includes(typeof a),
                )
              ),
          },
          fid,
        );
        if (splice)
          hush(() => {
            const copy = (
              target: any,
              items: any[],
              from: number,
              storage: string,
            ) => {
              for (let i = from; i < items.length; i++) {
                const item = items[i];
                const id = recordUnmuted(
                  site,
                  "put",
                  item.value,
                  [item.ref],
                  {
                    objectId: objectId(target),
                    property: String(i),
                    native: name,
                    storage,
                    provenance: item.ref
                      ? "array-mutation-input"
                      : "unobserved-array-mutation-input",
                    opaque: !item.ref,
                    mutationCallId: end,
                  },
                  fid,
                );
                setHeap(target, String(i), id, item.value);
              }
            };
            for (let i = splice.after.length; i < arrLength; i++)
              heap.get(arr!)?.delete(String(i));
            copy(arr, splice.after, splice.from, "native-splice-move");
            copy(value, splice.removed, 0, "native-splice-removed");
            if (splice.after.length !== arrLength)
              setHeap(arr, "length", end, splice.after.length);
          });
        if (arr && name === "Array.push")
          hush(() => {
            for (let i = 0; i < effectiveArgs.length; i++)
              setHeap(
                arr,
                String(arrLength + i),
                inv.argRefs[i] || start,
                effectiveArgs[i],
              );
          });
        if (
          name === "String.split" &&
          typeof effectiveReceiver === "string" &&
          effectiveArgs.every(
            (x) => x === null || !["object", "function"].includes(typeof x),
          ) &&
          Array.isArray(value)
        )
          hush(() => {
            // A primitive separator cannot invoke user Symbol.split or getters.
            // Preserve the native operation as a dependency, without re-running it.
            for (let i = 0; i < Math.min(value.length, 2000); i++) {
              const item = descriptor(value, String(i));
              if (!item || !("value" in item)) continue;
              const id = recordUnmuted(
                site,
                "put",
                item.value,
                [end],
                {
                  objectId: objectId(value),
                  property: String(i),
                  native: name,
                  storage: "native-split-result",
                  provenance: "native-call-result",
                },
                fid,
              );
              setHeap(value, String(i), id, item.value);
            }
          });
        if (copyPlan)
          hush(() => {
            for (const [i, item] of copyPlan.entries()) {
              if (item.hole) continue;
              const id = recordUnmuted(
                site,
                "put",
                item.value,
                [item.ref],
                {
                  objectId: objectId(value),
                  property: String(i),
                  native: name,
                  storage:
                    name === "Array.concat"
                      ? "native-concat-copy"
                      : "native-slice-copy",
                  provenance: item.ref
                    ? "array-copy-input"
                    : "unobserved-array-copy-input",
                  opaque: !item.ref,
                },
                fid,
              );
              setHeap(value, String(i), id, item.value);
            }
          });
        if (arr && name === "Array.pop")
          hush(() => {
            heap.get(arr)?.delete(String(arrLength - 1));
          });
        if (
          arr &&
          !splice &&
          [
            "Array.sort",
            "Array.shift",
            "Array.unshift",
            "Array.splice",
            "Array.reverse",
          ].includes(name!)
        )
          hush(() => {
            // Unknown permutations remain explicit opaque dependencies, never stale index links.
            heap.delete(arr);
            for (let i = 0; i < Math.min(arr.length, 2000); i++) {
              const d = descriptor(arr, String(i));
              if (d && "value" in d) setHeap(arr, String(i), end, d.value);
            }
          });
        if (
          name &&
          /^(Object\.(assign|definePropert)|Reflect\.(set|delete|define))/.test(
            name,
          )
        )
          hush(() => {
            const target = mutationTarget;
            if (isProxy(target)) return;
            for (const k of mutationKeys) {
              const d = descriptor(Object(target), k);
              if (name === "Reflect.deleteProperty") {
                const id = recordUnmuted(
                  site,
                  "delete",
                  value,
                  [end],
                  {
                    objectId: objectId(target),
                    property: String(k),
                    storage: "native-delete-result",
                  },
                  fid,
                );
                if (value) heap.get(target)?.delete(k);
                continue;
              }
              if (d && "value" in d && value !== false) {
                const e = recordUnmuted(
                  site,
                  "put",
                  d.value,
                  [end],
                  {
                    objectId: objectId(target),
                    property: String(k),
                    storage: "native-post-state",
                    opaque: true,
                  },
                  fid,
                );
                setHeap(target, k, e, d.value);
              }
            }
            f.latest.set(site, end);
          });
        // Synthetic index records describe the returned/mutated objects, not
        // the value of the call expression itself.
        f.latest.set(site, end);
        return value;
      } catch (error) {
        // Native array mutations may write several elements before throwing.
        // Those writes were not observed individually; old index links are unsafe.
        if (
          arr &&
          [
            "Array.splice",
            "Array.sort",
            "Array.reverse",
            "Array.shift",
            "Array.unshift",
            "Array.push",
            "Array.pop",
          ].includes(name || "")
        )
          heap.delete(arr);
        record(
          site,
          "call-throw",
          undefined,
          [start],
          { error: String((error as any)?.message || error) },
          fid,
        );
        throw error;
      } finally {
        // Exact synchronous call exit, including exceptions and native callbacks.
        // Async/generator frames may resume later and are never prematurely evicted.
        for (const id of inv.frames || []) {
          const f=frame(id), location=f && sites[f.site];
          if (f && !location?.async && !location?.generator) api.leave(id);
        }
      }
    },
    returned(site: string, value: any, ids: any[], fid: number) {
      const f = fm(fid),
        id = record(site, "return", value, deps(f, ids), {}, fid);
      if (f.invocation) f.invocation.returnRef = id;
      const location=sites[f.site];
      if (!location?.async && !location?.generator && !location?.hasFinally) api.leave(fid);
      return value;
    },
    command(a: any) {
      for (const [id, o] of oracles)
        if (o.expiresAt <= now()) oracles.delete(id);
      if (active?.state === "recording" && active.expiresAt <= now()) {
        active.state = "limited";
        active.reason = "ttl";
      }
      if (a.action === "cryptoCandidates") {
        const algos = ["md5", "sha1", "sha256", "sha384", "sha512", "sm3"];
        const digestLen: any = {
          md5: 32,
          sha1: 40,
          sha256: 64,
          sha384: 96,
          sha512: 128,
          sm3: 64,
        };
        const hexRe = /^[a-f0-9]{32,128}$/i;
        const inScope = (e: any) => !a.runId || e.runId === a.runId;
        const hash = (algorithm: string, input: string) =>
          g.__runnerAnalysisContext?.hash?.(algorithm, input);
        // Query-time work caps. Reported below; nothing is silently truncated.
        const maxInputs = 4000,
          maxOutputs = 1000,
          hashBudget = 60000;
        const candidates: any[] = [];
        const seen = new Set<string>(); // dedupe by `${algorithm}:${output}`
        // OUTPUT digests: hex 32-128 seen as a call return value. This is where
        // CryptoJS's MD5(x).toString() lands (its input is NOT its own arg).
        const outputs = new Map<string, any>();
        // INPUT strings: full call args + string-typed values. Long inputs that
        // snapshot() truncated are recovered from the crypto string pool.
        const inputs = new Map<string, any>();
        let inputsCapped = false,
          outputsCapped = false;
        const addInput = (s: any, meta: any) => {
          if (typeof s !== "string" || !s.length || s.length > 8192) return;
          if (inputs.has(s)) return;
          if (inputs.size >= maxInputs) {
            inputsCapped = true;
            return;
          }
          inputs.set(s, meta);
        };
        // Pooled long inputs first (highest value: the truncated sign strings).
        for (const [s, meta] of cryptoStrings)
          if (!a.runId || meta.runId === a.runId) addInput(s, meta);
        // Then call args, then plain string values; collect outputs in one pass.
        for (const e of byId.values()) {
          if (!inScope(e)) continue;
          if (e.kind === "call" && Array.isArray(e.args))
            for (const arg of e.args)
              addInput(arg, {
                eventId: e.id,
                kind: "call-arg",
                location: e.location,
              });
        }
        const addOutput = (v: any, evId: number, cId: any, loc: any) => {
          if (typeof v !== "string" || !hexRe.test(v)) return;
          const key = v.toLowerCase();
          if (outputs.has(key)) return;
          if (outputs.size >= maxOutputs) {
            outputsCapped = true;
            return;
          }
          outputs.set(key, { eventId: evId, callId: cId, value: v, location: loc });
        };
        for (const e of byId.values()) {
          if (!inScope(e)) continue;
          // Outputs: any hex 32-128 seen as a return value, a plain value, or a
          // call arg. crypto-js MD5(x).toString()'s hex frequently surfaces only
          // as a request header/body value (a later arg), never as its own
          // call-return, so binding outputs to call-return alone misses it. A
          // false-positive is impossible: a candidate is only emitted when
          // hash(input)===output actually holds (line ~1837).
          addOutput(e.value, e.id, e.callId, byId.get(e.callId)?.location || e.location);
          if (Array.isArray(e.args))
            for (const arg of e.args) addOutput(arg, e.id, e.id, e.location);
          // Any string value is also a candidate input (covers hash-of-hash).
          if (typeof e.value === "string")
            addInput(e.value, {
              eventId: e.id,
              kind: e.kind,
              location: e.location,
            });
        }
        // (A) Backward-compatible single-call binding: return value is hex AND
        // the same call's args[0] hashes to it. Tight per-call evidence.
        for (const e of byId.values()) {
          if (
            e.kind !== "call-return" ||
            !inScope(e) ||
            typeof e.value !== "string" ||
            !hexRe.test(e.value)
          )
            continue;
          const start = byId.get(e.callId),
            input = start?.args?.[0];
          if (typeof input !== "string") continue;
          for (const algorithm of algos) {
            if (digestLen[algorithm] !== e.value.length) continue;
            const digest = hash(algorithm, input);
            if (digest && digest.toLowerCase() === e.value.toLowerCase()) {
              seen.add(algorithm + ":" + e.value.toLowerCase());
              candidates.push({
                eventId: e.id,
                callId: e.callId,
                algorithm,
                input,
                output: e.value,
                location: start.location,
                binding: "single-call",
                verification:
                  "actual UTF-8 input/output match for this call only",
              });
            }
          }
        }
        // (B) Cross-match: decouple input and output across calls. Hash each
        // input once per relevant algorithm into an index, then look up each
        // output. Only algorithms whose digest length occurs among the observed
        // outputs are computed, bounded by hashBudget.
        const wantedLens = new Set(
          [...outputs.values()].map((o) => o.value.length),
        );
        const wantedAlgos = algos.filter((al) => wantedLens.has(digestLen[al]));
        const index = new Map<string, any>();
        let hashOps = 0,
          hashCapped = false;
        outer: for (const [input, meta] of inputs) {
          for (const algorithm of wantedAlgos) {
            if (hashOps >= hashBudget) {
              hashCapped = true;
              break outer;
            }
            const digest = hash(algorithm, input);
            hashOps++;
            if (digest) {
              const k = algorithm + ":" + digest.toLowerCase();
              if (!index.has(k)) index.set(k, { algorithm, input, meta });
            }
          }
        }
        for (const o of outputs.values())
          for (const algorithm of wantedAlgos) {
            if (digestLen[algorithm] !== o.value.length) continue;
            const key = algorithm + ":" + o.value.toLowerCase();
            if (seen.has(key)) continue;
            const hit = index.get(key);
            if (hit) {
              seen.add(key);
              candidates.push({
                eventId: o.eventId,
                callId: o.callId,
                algorithm,
                input: hit.input,
                output: o.value,
                location: o.location,
                inputLocation: hit.meta?.location,
                binding: "cross-call",
                verification:
                  "actual UTF-8 hash(input)===output; input and output observed in separate calls of this run",
              });
            }
          }
        // (C) Optional HMAC (opt-in via hmac:true): try recorded string values
        // as keys over a bounded key/message set. Needs the host hmac bridge.
        let hmacTried = false,
          hmacCapped = false;
        if (
          a.hmac === true &&
          typeof g.__runnerAnalysisContext?.hmac === "function"
        ) {
          hmacTried = true;
          const hmac = g.__runnerAnalysisContext.hmac;
          const hmacKeyCap = 32,
            hmacMsgCap = 96,
            hmacBudget = 20000;
          const all = [...inputs.keys()];
          // Shorter strings are the likelier keys (secrets/salts).
          const keys = [...all]
            .sort((x, y) => x.length - y.length)
            .slice(0, hmacKeyCap);
          const msgs = all.slice(0, hmacMsgCap);
          if (all.length > hmacKeyCap || all.length > hmacMsgCap)
            hmacCapped = true;
          let ops = 0;
          hmacOuter: for (const key of keys)
            for (const msg of msgs)
              for (const algorithm of wantedAlgos) {
                if (ops >= hmacBudget) {
                  hmacCapped = true;
                  break hmacOuter;
                }
                const digest = hmac(algorithm, key, msg);
                ops++;
                if (!digest) continue;
                const outKey = algorithm + ":" + digest.toLowerCase();
                if (seen.has(outKey)) continue;
                const o = outputs.get(digest.toLowerCase());
                if (o && digestLen[algorithm] === o.value.length) {
                  seen.add(outKey);
                  candidates.push({
                    eventId: o.eventId,
                    callId: o.callId,
                    algorithm: "hmac-" + algorithm,
                    key,
                    input: msg,
                    output: o.value,
                    location: o.location,
                    binding: "cross-call-hmac",
                    verification:
                      "actual UTF-8 HMAC(key,input)===output; key and input tried from recorded string values",
                  });
                }
              }
        }
        // (D) AES-ECB reverse: some signatures (e.g. an X-Sign) are AES-ECB(hex)
        // of a short string under a UTF-8 string key, NOT a hash. Try recorded
        // 16/24/32-length strings as keys against recorded strings as plaintext,
        // bounded, matching the observed hex outputs. Runs by default (bounded)
        // because opt-in flags are stripped by an out-of-date MCP schema. False
        // positives are impossible: emitted only when AES-ECB(key,pt)===output.
        const aesEcb = g.__runnerAnalysisContext?.aesEcb;
        let aesTried = false,
          aesCapped = false;
        if (typeof aesEcb === "function" && outputs.size) {
          aesTried = true;
          const keyCap = 48,
            ptCap = 500,
            aesBudget = 40000;
          const all = [...inputs.keys()];
          const allKeys = all.filter(
            (s) => s.length === 16 || s.length === 24 || s.length === 32,
          );
          const allPts = all.filter((s) => s.length <= 256);
          if (allKeys.length > keyCap || allPts.length > ptCap) aesCapped = true;
          const keyCands = allKeys.slice(0, keyCap);
          const ptCands = allPts.slice(0, ptCap);
          let ops = 0;
          aesOuter: for (const key of keyCands)
            for (const pt of ptCands) {
              if (ops >= aesBudget) {
                aesCapped = true;
                break aesOuter;
              }
              const hex = aesEcb(key, pt);
              ops++;
              if (!hex) continue;
              const o = outputs.get(hex.toLowerCase());
              if (!o) continue;
              const outKey = "aes-ecb:" + hex.toLowerCase();
              if (seen.has(outKey)) continue;
              seen.add(outKey);
              candidates.push({
                eventId: o.eventId,
                callId: o.callId,
                algorithm: "aes-ecb",
                key,
                input: pt,
                output: o.value,
                location: o.location,
                binding: "cross-call-aes",
                verification:
                  "actual AES-ECB(utf8 key, utf8 plaintext)===output; key and plaintext tried from recorded strings",
              });
            }
        }
        return {
          candidates: candidates.slice(a.after, a.after + a.limit),
          hasMore: candidates.length > a.after + a.limit,
          nextCursor:
            a.after +
            Math.min(a.limit, Math.max(0, candidates.length - a.after)),
          total: candidates.length,
          stats: {
            inputs: inputs.size,
            outputs: outputs.size,
            pooledStrings: cryptoStrings.size,
            hashOps,
            wantedAlgorithms: wantedAlgos,
            caps: { maxInputs, maxOutputs, hashBudget },
            inputsCapped,
            outputsCapped,
            hashCapped,
            aes: aesTried
              ? { tried: true, capped: aesCapped }
              : { tried: false },
            hmac: hmacTried
              ? { tried: true, capped: hmacCapped }
              : {
                  tried: false,
                  reason:
                    a.hmac === true
                      ? "HMAC_BRIDGE_UNAVAILABLE"
                      : "not requested (pass hmac:true)",
                },
          },
          unobserved:
            "non-string inputs/keys, AES ciphertext, and non-UTF-8 encodings still require explicit crypto_watch taps",
        };
      }
      if (a.action === "oracleExport") {
        const e = byId.get(a.eventId),
          h = handles.get(String(e?.callId || a.eventId));
        if (!h || h.expiresAt < now())
          throw Error("CALL_HANDLE_EVICTED_OR_EXPIRED");
        if (oracles.size >= 64) throw Error("ORACLE_LIMIT");
        const id = "execution-oracle-" + realmId + "-" + ++oracleSeq;
        oracles.set(id, h);
        return {
          oracleId: id,
          source: sites[h.site] || h.location,
          functionSourceKnown: !!h.site,
          standalone: false,
          doesNotInvoke: true,
        };
      }
      if (a.action === "oracleList")
        return {
          oracles: [...oracles].map(([id, h]) => ({
            oracleId: id,
            source: sites[h.site] || h.location,
            expiresAt: h.expiresAt,
          })),
        };
      if (a.action === "oracleRemove") {
        oracles.delete(a.oracleId);
        return { status: "removed" };
      }
      if (a.action === "oracleCall") {
        const h = oracles.get(a.oracleId);
        if (!h || h.expiresAt < now()) throw Error("ORACLE_EXPIRED");
        const value = api.invoke(
          h.callSite || h.site,
          { fn: h.fn, base: h.receiver },
          a.args,
          [],
          0,
          false,
        );
        const done = (v: any) => ({
          oracleId: a.oracleId,
          result: snapshot(v),
          calls: 1,
        });
        return a.awaitPromise && value instanceof Promise
          ? value.then(done)
          : done(value);
      }
      if (a.action === "diff") {
        const index = (run: string) => {
          const counts = new Map(),
            out = new Map();
          for (const e of byId.values()) {
            if (e.runId !== run) continue;
            const base = json([e.callPath, e.site, e.kind, e.property]),
              n = counts.get(base) || 0;
            counts.set(base, n + 1);
            out.set(base + ":" + n, e);
          }
          return out;
        };
        const left = index(a.runA),
          right = index(a.runB),
          changes: any[] = [];
        for (const key of new Set([...left.keys(), ...right.keys()])) {
          const x = left.get(key),
            y = right.get(key);
          if (!x || !y || json(x.value) !== json(y.value))
            changes.push({
              key,
              kind: !x ? "only-b" : !y ? "only-a" : "changed",
              before: x,
              after: y,
            });
        }
        return {
          changes: changes.slice(a.after, a.after + a.limit),
          nextCursor:
            a.after + Math.min(a.limit, Math.max(0, changes.length - a.after)),
          hasMore: changes.length > a.after + a.limit,
          basis:
            "function call path + original site + operation + property + occurrence; matching is not causality",
          incomplete:
            !runs.has(a.runA) ||
            !runs.has(a.runB) ||
            !!runs.get(a.runA)?.evicted ||
            !!runs.get(a.runB)?.evicted,
        };
      }
      if (a.action === "dependencies") {
        const e = byId.get(a.eventId);
        if (!e) throw Error("EVENT_EVICTED_OR_UNKNOWN");
        const describe = (ids: number[]) => ids.map(id => ({id, retained: byId.has(id),
          runId: byId.get(id)?.runId, phase: runs.get(byId.get(id)?.runId)?.phase}));
        return {eventId: e.id, data: describe(e.deps || []), address: describe(e.addressDeps || []),
          control: describe([...(e.controlDeps || []), ...(e.kind === "conditional" || e.kind === "logical" ? e.deps.slice(0,1) : [])]),
          controlCoverage: "expression conditions and enclosing if branches; loops/switch dispatch are not included",
          source: e.location, provenance: e.provenance, opaque: e.opaque};
      }
      if (a.action === "status")
        return {
          enabled: true,
          cache: {retainedBytes, byteLimit, events: byId.size, capacity,
            accounting: "serialized UTF-16 record bytes plus 128 bytes per event; excludes VM heap and indexes"},
          frameEvictions, frameGaps, retainedFrames:frames.size,
          initialization: initialization && {...initialization},
          initStateRetained: initStateIds.size,
          initStateBytes,
          active: active && { ...active },
          files: [...files.values()],
          runs: [...runs.values()],
          watches: [...watches.values()],
          latestCursor: sequence,
          capabilities: {
            sourceOperations: true,
            writeSites: true,
            opcodeTrace: false,
            unmodifiedSourceOnDisk: true,
          },
        };
      if (a.action === "start") {
        if (active === initialization && active?.state === "recording") active.state = "stopped";
        if (active?.state === "recording")
          throw Error("EXECUTION_BUSY: stop the active run first");
        const id = "execution-" + realmId + "-" + ++runSeq;
        active = {
          id,
          state: "recording",
          phase: a.phase === "initialization" ? "initialization" : "invocation",
          count: 0,
          evicted: 0,
          start: sequence + 1,
          expiresAt: now() + (a.ttlMs || config.ttlMs || 60000),
          maxEvents: a.maxEvents || config.maxEvents || 20000,
          functionSite: a.functionSite,
          pinRun: a.pinRun === true,
          // state-mode only meaningful for the initialization run; carried so
          // record()/setHeap() can switch to compact current-state retention.
          mode: a.phase === "initialization" && a.mode === "state" ? "state" : "full",
          stateCap: a.stateCap || 200000,
        };
        runs.set(id, active);
        if (active.pinRun) pinned.set(id, []);
        if (runs.size > 100) {
          const oldId = runs.keys().next().value!;
          const bucket = pinned.get(oldId);
          if (bucket) {
            pinned.delete(oldId);
            for (const e of bucket) if (byId.has(e)) invocationIds.add(e);
          }
          runs.delete(oldId);
        }
        return { runId: id, cursor: sequence, state: active.state };
      }
      if (a.action === "stop") {
        const run = runs.get(a.runId || active?.id);
        if (!run) throw Error("RUN_NOT_FOUND");
        if (run.state === "recording") run.state = "stopped";
        // Release the pin: the run's retained events rejoin the normal FIFO so
        // they can be evicted from here on, bounding memory.
        if (run.pinRun) {
          run.pinRun = false;
          const bucket = pinned.get(run.id);
          pinned.delete(run.id);
          if (bucket)
            for (const e of bucket) if (byId.has(e)) invocationIds.add(e);
        }
        return { ...run };
      }

      if (a.action === "logpoint") {
        if (watches.size >= 100) throw Error("WATCH_LIMIT");
        const id = "logpoint-" + realmId + "-" + ++watchSeq;
        watches.set(id, {
          id,
          mode: "logpoint",
          location: a.location,
          kinds: a.kinds || ["call", "call-return", "call-throw"],
          condition: a.condition,
          remaining: a.count,
          expiresAt: now() + a.ttlMs,
        });
        return { watchId: id, cursor: sequence };
      }
      if (a.action === "watch") {
        if (watches.size >= 100) throw Error("WATCH_LIMIT");
        const id = "write-watch-" + realmId + "-" + ++watchSeq;
        watches.set(id, { id, properties: a.properties, objectId: a.objectId });
        return { watchId: id, cursor: sequence };
      }
      if (a.action === "unwatch") {
        watches.delete(a.watchId);
        return { status: "removed" };
      }
      if (a.action === "read" || a.action === "summary") {
        const w = a.watchId ? watches.get(a.watchId) : null;
        if (a.watchId && !w) throw Error("WATCH_NOT_FOUND");
        if (a.action === "summary" && a.runId && !runs.has(a.runId))
          throw Error("RUN_NOT_FOUND");
        const snapshotCursor = Math.min(a.beforeEvent ?? sequence, sequence);
        const oldestCursor = byId.keys().next().value ?? sequence + 1;
        const filtered: any[] = [];
        let scanned = 0;
        for (
          let id = Math.max(oldestCursor, (a.after || 0) + 1);
          id <= snapshotCursor;
          id++
        ) {
          const r = byId.get(id);
          scanned++;
          if (
            r &&
            (!a.runId || r.runId === a.runId) &&
            (!a.kinds || a.kinds.includes(r.kind)) &&
            (!a.natives || a.natives.includes(r.native)) &&
            (!a.expressionIncludes ||
              r.location?.expression?.includes(a.expressionIncludes)) &&
            (!a.location ||
              (r.location?.file === a.location.file &&
                r.location?.line === a.location.line &&
                (!a.location.column ||
                  r.location?.column === a.location.column))) &&
            (!w ||
              (w.mode === "logpoint"
                ? r.logpointIds?.includes(w.id)
                : ["put", "delete", "write-attempt"].includes(r.kind) &&
                  (!w.properties.length || w.properties.includes(r.property)) &&
                  (!w.objectId || w.objectId === r.objectId)))
          ) {
            filtered.push(r);
            // Read pagination seeks by event id and retains one lookahead;
            // it must not rescan the entire recording for every 200-row page.
            if (a.action === "read" && filtered.length > (a.limit || 30)) break;
          }
        }
        const entries = filtered.slice(0, a.limit || 30);
        if (a.action === "summary") {
          const groups = new Map<string, any>();
          for (const r of filtered) {
            const key =
              a.groupBy === "kind"
                ? r.kind
                : a.groupBy === "native"
                  ? r.native || "<non-native>"
                  : `${r.site}\0${r.kind}\0${r.native || ""}`;
            let group = groups.get(key);
            if (!group) {
              group = {
                id: r.id,
                count: 0,
                firstEvent: r.id,
                lastEvent: r.id,
                ...(a.groupBy === "native"
                  ? { native: r.native || null }
                  : { kind: r.kind }),
                ...(a.groupBy !== "kind" && a.groupBy !== "native"
                  ? { location: r.location, native: r.native }
                  : {}),
              };
              groups.set(key, group);
            }
            group.count++;
            group.lastEvent = r.id;
          }
          const all = [...groups.values()],
            offset = a.offset || 0;
          const page = all.slice(offset, offset + (a.limit || 30));
          return {
            entries: page,
            groupBy: a.groupBy || "source",
            matchedEvents: filtered.length,
            groupCount: all.length,
            nextOffset: offset + page.length,
            hasMore: offset + page.length < all.length,
            snapshotCursor,
            latestCursor: sequence,
            gap: (a.after || 0) < oldestCursor - 1 || ((a.runId ? runs.get(a.runId)?.lastEvictedEvent : lastEvictedEvent) || 0) > (a.after || 0),
            scanned,
            cursorResetRequired:
              (a.after || 0) > sequence || (a.beforeEvent ?? 0) > sequence,
            meaning:
              "Observed event counts grouped by recorded source or native; counts do not infer causality. Pin beforeEvent to snapshotCursor when paging.",
          };
        }
        return {
          entries,
          nextCursor: entries.at(-1)?.id ?? snapshotCursor,
          latestCursor: sequence,
          snapshotCursor,
          oldestCursor,
          scanned,
          cursorResetRequired: a.after > sequence,
          hasMore: entries.length < filtered.length,
          gap: (a.after || 0) < oldestCursor - 1 || ((a.runId ? runs.get(a.runId)?.lastEvictedEvent : lastEvictedEvent) || 0) > (a.after || 0),
        };
      }
      if (a.action === "explain") {
        if (a.paged || a.sliceCursor) return explainPage(a);
        const sink = byId.get(a.eventId);
        if (!sink) throw Error("EVENT_EVICTED_OR_UNKNOWN");
        const seen = new Set<number>(),
          pending = [sink.id],
          missing = new Set<number>(),
          ordered: any[] = [];
        while (pending.length && seen.size < (a.maxNodes || 500)) {
          const id = pending.pop()!;
          if (seen.has(id)) continue;
          seen.add(id);
          const e = byId.get(id);
          if (!e) {
            missing.add(id);
            continue;
          }
          ordered.push(e);
          pending.push(
            ...e.deps,
            ...(a.includeAddress || a.expandEvents?.includes(id) ? e.addressDeps || [] : []),
            ...(a.expandEvents?.includes(id) ? e.controlDeps || [] : []),
          );
        }
        ordered.sort((a, b) => a.id - b.id);
        const semantic = ordered.filter((e) =>
          [
            "put",
            "call",
            "call-return",
            "binary",
            "template",
            "return",
            "parameter",
            "conditional",
            "update",
          ].includes(e.kind),
        );
        semantic.push(
          ...ordered.filter(
            (e) => e.kind === "write" && e.operator && e.operator !== "=",
          ),
        );
        semantic.sort((a, b) => a.id - b.id);
        return {
          sink,
          events: ordered,
          semantic,
          missing: [...missing],
          truncated: !!pending.length,
          opaqueBoundaries: ordered
            .filter((e) => e.opaque || e.provenance?.startsWith("unobserved"))
            .map((e) => e.id),
          oracleCandidates: ordered
            .filter((e) => e.kind === "call" && handles.has(String(e.id)))
            .map((e) => ({
              eventId: e.id,
              source:
                sites[handles.get(String(e.id)).site] ||
                handles.get(String(e.id)).location,
              functionSourceKnown: !!handles.get(String(e.id)).site,
            })),
          representation: "executed-path dependency slice",
          addressDependenciesIncluded: !!a.includeAddress,
          generalizedAlgorithm: false,
        };
      }
      throw Error("UNKNOWN_EXECUTION_ACTION");
    },
  };
  define(g, "__wxappExecutionV1", {
    value: Object.freeze(api),
    writable: false,
    configurable: false,
  });
  if (config.initialization?.enabled) {
    api.command({action: "start", phase: "initialization", ...config.initialization});
    initialization = active;
  }
  return api;
}
