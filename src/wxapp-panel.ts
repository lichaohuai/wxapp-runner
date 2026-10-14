import { devtoolsContract } from "./devtools-contract";
/** Registered in Electron's bundled native DevTools, not in the mini-program view. */
(async () => {
  const moduleURL = devtoolsContract.ui;
  const UI = await import(moduleURL);
  const bridge = (globalThis as any).wxappDebugger;
  function hasTabs(root: Document | ShadowRoot): boolean {
    if (root.querySelector("[role=tab]")) return true;
    return [...root.querySelectorAll("*")].some(
      (node) => node.shadowRoot && hasTabs(node.shadowRoot),
    );
  }
  const deadline = Date.now() + 10000;
  while (!hasTabs(document)) {
    if (Date.now() > deadline) throw Error("Native DevTools UI not ready");
    await new Promise((r) => setTimeout(r, 25));
  }
  const manager = UI.ViewManager.ViewManager.instance();
  if (manager.hasView("wxapp")) return;
  const create = async () => {
    const widget = new UI.View.SimpleView({ title: "Wxapp", viewId: "wxapp" });
    const root = widget.contentElement;
    const style = document.createElement("style");
    style.textContent = `.wxapp{font:12px system-ui;padding:12px;overflow:auto;height:100%;box-sizing:border-box;color:var(--sys-color-on-surface);background:var(--sys-color-cdt-base-container)}.wxapp button,.wxapp select,.wxapp input,.wxapp textarea{font:inherit;margin:4px;padding:5px}.wxapp pre{white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}.wxapp label{display:inline-block}.wxapp .error{color:#cf5050}.wxapp .toolbar{display:flex;flex-wrap:wrap;align-items:center;border-bottom:1px solid #8885}.wxapp textarea{display:block;min-width:360px;min-height:65px}.wxapp details{margin:8px 0}`;
    root.append(style);
    const panel = document.createElement("div");
    panel.className = "wxapp";
    root.append(panel);
    const bar = document.createElement("div");
    bar.className = "toolbar";
    panel.append(bar);
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Wxapp section");
    for (const name of [
      "状态",
      "加载链路",
      "官方契约",
      "变化",
      "请求",
      "实时日志",
      "存储",
      "定位",
      "模拟设备",
      "原生组件",
      "云开发",
      "小程序包",
      "函数 Hook",
      "模块源码",
      "启动分析",
      "Crypto 采集",
      "执行切片",
      "执行反虚拟化",
      "字段写监视",
      "Signer Autopsy",
      "函数 Oracle",
      "验收目录",
      "DOM",
      "异常",
      "操作追踪",
      "网络规则",
      "运行实例",
      "分析产物",
    ]) {
      const o = document.createElement("option");
      o.textContent = name;
      select.append(o);
    }
    bar.append(select);
    const refresh = document.createElement("button");
    refresh.textContent = "刷新";
    bar.append(refresh);
    const auto = document.createElement("input");
    auto.type = "checkbox";
    auto.setAttribute("aria-label", "自动刷新");
    const label = document.createElement("label");
    label.append(auto, "自动刷新");
    bar.append(label);
    const reveal = document.createElement("input");
    reveal.type = "checkbox";
    reveal.setAttribute("aria-label", "显示敏感字段");
    const revealLabel = document.createElement("label");
    revealLabel.append(reveal, "显示敏感字段");
    bar.append(revealLabel);
    const runtimes = document.createElement("select"),
      targets = document.createElement("select"),
      search = document.createElement("input");
    runtimes.setAttribute("aria-label", "运行实例");
    targets.setAttribute("aria-label", "调试目标");
    search.placeholder = "搜索实例、请求和事件";
    search.setAttribute("aria-label", "搜索");
    bar.prepend(runtimes, targets);
    bar.append(search);
    const call = (name: string, args: any = {}) =>
      bridge.call(name, {
        ...args,
        ...(runtimes.value ? { runtimeId: runtimes.value } : {}),
        revealSensitive: reveal.checked,
      });
    const targetArgs = () => (targets.value ? { targetId: targets.value } : {});
    const matches = (value: any) =>
      !search.value ||
      JSON.stringify(value)
        .toLocaleLowerCase()
        .includes(search.value.toLocaleLowerCase());
    async function identities() {
      let list: any;
      try {
        list = await bridge.call("runner_runtime", { action: "list" });
      } catch (e: any) {
        if (!/Unknown tool|Unknown MCP tool/.test(e.message)) throw e;
        return await bridge.call("runner_status", {});
      }
      const owner = !runtimes.value
        ? await bridge.call("runner_status", {})
        : undefined;
      const previous =
        runtimes.value || owner?.runtimeId || list.defaultRuntimeId;
      runtimes.replaceChildren(
        ...list.runtimes.map((r: any) => {
          const o = document.createElement("option");
          o.value = r.runtimeId;
          o.textContent = `${r.appid} · ${r.profile} · ${r.state}`;
          return o;
        }),
      );
      if ([...runtimes.options].some((o) => o.value === previous))
        runtimes.value = previous;
      const r = list.runtimes.find((r: any) => r.runtimeId === runtimes.value),
        oldTarget = targets.value;
      targets.replaceChildren(
        ...(r?.targets || []).map((t: any) => {
          const o = document.createElement("option");
          o.value = t.targetId;
          o.textContent = `${t.kind} · ${t.targetId}${t.connected ? "" : " · 已断开"}`;
          return o;
        }),
      );
      if ([...targets.options].some((o) => o.value === oldTarget))
        targets.value = oldTarget;
      return r;
    }
    const hint = document.createElement("p");
    hint.textContent =
      "读取真实运行状态；修改需要显式提交。正文为独立缓存，可重复读取。";
    panel.append(hint);
    const controls = document.createElement("div"),
      output = document.createElement("div");
    output.setAttribute("aria-label", "Wxapp result");
    panel.append(controls, output);
    let busy = false,
      cursor = 0;
    let outputRevision = 0;
    let awaitingStartup = false;
    let selectedRequest: any;
    const experiments = new Map<string, { a?: any; b?: any }>();
    const events: any[] = [];
    const show = (value: any) => {
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(value, null, 2);
      return pre;
    };
    const button = (name: string, action: () => any) => {
      const b = document.createElement("button");
      b.textContent = name;
      b.onclick = () => {
        outputRevision++;
        void Promise.resolve().then(action).catch(fail);
      };
      controls.append(b);
      return b;
    };
    const field = (placeholder: string, area = false) => {
      const el = area
        ? document.createElement("textarea")
        : document.createElement("input");
      el.placeholder = placeholder;
      el.setAttribute("aria-label", placeholder);
      controls.append(el);
      return el;
    };
    const fail = (e: any) => {
      output.replaceChildren(show({ error: e.message }));
    };
    function grouped(titleText: string, value: any, open = false) {
      const detail = document.createElement("details"),
        summary = document.createElement("summary");
      summary.textContent = titleText;
      detail.append(summary, show(value));
      detail.open = open;
      return detail;
    }
    function networkDetail(value: any) {
      const result = document.createElement("div");
      const metadata = { ...value };
      for (const [prefix, title] of [
        ["response", "响应"],
        ["request", "请求"],
      ]) {
        const preview = value[prefix + "BodyPreview"];
        if (!preview) continue;
        delete metadata[prefix + "Body"];
        delete metadata[prefix + "BodyPreview"];
        if (preview.decoding?.changed)
          result.append(
            grouped(`${title} · 已展开 JSON 字符串`, preview.decoded, true),
          );
        else if (preview.parsed !== undefined)
          result.append(
            grouped(`${title} · JSON / 表单`, preview.parsed, true),
          );
        if (preview.decoding)
          result.append(grouped(`${title} · 解析路径与限制`, preview.decoding));
        const original = grouped(
          `${title} · 原始格式${preview.truncated ? "（已截断，完整内容见产物）" : ""}`,
          {},
          false,
        );
        const pre = original.querySelector("pre")!;
        pre.textContent = preview.text ?? "正文不可用";
        result.append(original);
      }
      result.append(grouped("请求元数据、响应头与正文产物", metadata));
      return result;
    }
    async function render() {
      if (busy) return;
      busy = true;
      const revision = outputRevision;
      try {
        const section = select.value;
        const runtime = await identities();
        if (revision !== outputRevision) return;
        awaitingStartup = runtime?.state === "starting";
        hint.textContent = `${runtime?.sessionId || ""} · 历史记录保留至显式结束会话；输入送达不代表业务完成。`;
        if (runtime?.pendingDialogs?.length)
          hint.textContent += ` 等待 ${runtime.pendingDialogs.length} 个对话框回复（${runtime.pendingDialogs.map((d: any) => d.name).join("、")}）；可在弹窗或 runner_dialog 中处理。`;
        if (
          ["状态", "存储", "DOM", "定位"].includes(section) &&
          runtime?.state &&
          (runtime.state !== "running" || !runtime.serviceReady)
        ) {
          output.replaceChildren(
            show({
              status: awaitingStartup
                ? "正在启动，等待逻辑与视图就绪…"
                : runtime.state,
              runtimeId: runtime.runtimeId,
              sessionId: runtime.sessionId,
              exit: runtime.exit,
            }),
          );
          return;
        }
        let value: any;
        if (section === "官方契约") {
          const result=await call("runner_suite",{action:"contracts",q:search.value,limit:30});
          output.replaceChildren(grouped("账本版本与范围",{fingerprint:result.fingerprint,current:result.current,reason:result.reason,summary:result.summary},true),...result.entries.map((entry:any)=>grouped(entry.id,entry,false)));
          let offset=result.nextOffset, more=result.hasMore;
          const next=document.createElement("button");next.textContent="下一页";next.disabled=!more;
          next.onclick=async()=>{try {const page=await call("runner_suite",{action:"contracts",q:search.value,offset,limit:30,fingerprint:result.fingerprint});offset=page.nextOffset;more=page.hasMore;next.disabled=!more;next.before(...page.entries.map((entry:any)=>grouped(entry.id,entry,false)));}catch(error:any){output.append(show({error:error.message}));}};
          output.append(next);return;
        }
        if (section === "加载链路") {
          const status = await call("runner_status");
          output.replaceChildren(
            grouped(
              "启动与窗口状态",
              {
                stage: status.loader?.stage,
                logicStage: status.loader?.logicStage,
                visibility: status.loader?.visibility,
                current: status.current,
                logicFailure: status.logicFailure,
                pendingDialogs: status.pendingDialogs || [],
              },
              true,
            ),
            grouped("契约版本与覆盖范围", status.contracts || {}, false),
            grouped("逻辑上下文", status.loader?.contexts || [], true),
            grouped("插件启动数据与校验", {
              contacts: status.loader?.pluginContacts,
              verification: status.loader?.pluginVerification,
            }, true),
            grouped(
              "宿主能力缺口（实际调用）",
              status.loader?.nativeBoundary || {},
              true,
            ),
            grouped(
              "Worker 与 H5 调试目标",
              {
                workers: status.loader?.workers || [],
                h5: status.h5 || [],
                targets: runtime?.targets || [],
              },
              true,
            ),
            grouped(
              "官方模块来源",
              {
                logic: status.loaderProvenance,
                pages: status.loader?.pageModules,
              },
              false,
            ),
          );
          return;
        } else if (section === "状态") {
          value = await call("runner_state", {});
          output.replaceChildren(
            show({
              current: runtime.current,
              pages: value.pages,
              latestEventId: value.latestEventId,
            }),
          );
          const nodes = new Map<string, HTMLDetailsElement>();
          for (const item of value.instances.filter(matches)) {
            const node = grouped(
              `${item.kind} · ${item.route || item.file} · ${item.id} · ${item.lastLifecycle || ""}`,
              item,
              item.kind === "Page",
            );
            const use = document.createElement("button");
            use.textContent = "选择此实例";
            use.onclick = () => {
              const input = controls.querySelector<HTMLInputElement>(
                '[aria-label="instanceId"]',
              );
              if (input) input.value = item.id;
            };
            node.insertBefore(use, node.children[1]);
            nodes.set(item.id, node);
          }
          for (const item of value.instances) {
            const node = nodes.get(item.id);
            if (!node) continue;
            const parent =
              item.ownerMapping === "public-selectOwnerComponent" &&
              nodes.get(item.ownerId);
            (parent || output).append(node);
          }
          output.append(
            grouped(
              `注册表（${value.registrations.length}）`,
              value.registrations,
            ),
          );
          return;
        } else if (section === "变化") {
          const result = await call("runner_state", {
            action: "events",
            after: cursor,
            limit: 200,
          });
          cursor = result.nextCursor;
          events.push(...result.entries);
          if (events.length > 500) events.splice(0, events.length - 500);
          value = { ...result, entries: events };
        } else if (section === "定位") {
          value = await call("runner_state", { action: "location" });
          hint.textContent = value.simulated
            ? "模拟定位已启用：返回指定坐标，不是电脑的真实位置。" +
              (value.persisted
                ? "已为此小程序保存，重启后继续使用。"
                : "本次修改仅当前实例有效；重启使用已保存的位置或系统定位。")
            : "当前使用系统定位；系统关闭或拒绝时返回失败。可显式启用模拟位置进行调试。";
        } else if (section === "验收目录") {
          value = {
            catalog: await call("runner_suite", {
              action: "catalog",
              limit: 500,
            }),
            ...(await call("runner_suite", { action: "list" })),
          };
          if (search.value)
            value.catalog.pages = value.catalog.pages.filter(matches);
        } else if (section === "模拟设备") value = await call("runner_device");
        else if (section === "原生组件") value = await call("runner_native");
        else if (section === "云开发") value = await call("runner_cloud");
        else if (section === "函数 Hook")
          value = await call("runner_hook", { action: "list" });
        else if (section === "启动分析")
          value = {
            current: runtime?.analysis,
            note: "仅在新实例中，基础库之后、业务包之前注入。默认隔离 profile。",
          };
        else if (section === "Crypto 采集")
          value = await call("runner_crypto_watch", { action: "status" });
        else if (["执行反虚拟化", "字段写监视"].includes(section))
          value = await call("runner_execution", { action: "status" });
        else if (section === "Signer Autopsy")
          value = await call("runner_autopsy", { action: "list" });
        else if (section === "执行切片")
          value = await call("runner_slice", { action: "list" });
        else if (section === "函数 Oracle")
          value = await call("runner_oracle", { action: "list" });
        else if (section === "模块源码")
          value = await call("runner_source", { action: "list", limit: 50 });
        else if (section === "小程序包") {
          hint.textContent =
            "按名字搜索，或提供 appid + 版本。下载包含声明的分包，保存到独立包库；不会关闭或替换正在运行的小程序。";
          value = {
            library: await call("runner_packages", { action: "list" }),
            tasks: await call("runner_packages", { action: "jobs" }),
          };
        } else if (section === "存储") value = await call("runner_storage", {});
        else if (section === "异常" || section === "实时日志") {
          if (section === "实时日志")
            hint.textContent =
              "operateRealtimeData 本地接收记录，未上传微信后台。大正文通过 contentArtifactId 读取；id 为调试游标，realtimeId 为基础库回执 ID。";
          let after = 0;
          const entries: any[] = [];
          let result: any;
          do {
            result = await call("runner_logs", {
              after,
              limit: 200,
              ...(section === "实时日志" ? { source: "realtime" } : {}),
            });
            entries.push(...result.entries);
            after = result.nextCursor;
          } while (result.hasMore);
          value = {
            ...result,
            entries: entries.filter(
              (e) =>
                section === "实时日志" ||
                e.level === "error" ||
                e.level === "warn" ||
                e.source === "diagnostic",
            ),
          };
        } else if (section === "DOM" || section === "操作追踪") return;
        else if (section === "网络规则")
          value = {
            ...(await call("runner_network_rules")),
            ...(await call("runner_network_rules", { action: "paused" })),
          };
        else if (section === "运行实例")
          value = {
            ...(await call("runner_runtime")),
            control: await call("runner_control"),
          };
        else if (section === "分析产物")
          value = {
            ...(await call("runner_profile")),
            ...(await call("runner_artifact")),
          };
        else {
          const records = await call("runner_network", { limit: 100 });
          if (revision !== outputRevision) return;
          output.replaceChildren();
          for (const r of records.filter(matches)) {
            const detail = document.createElement("details"),
              title = document.createElement("summary");
            title.textContent = `${r.method} ${r.status ?? r.state} ${r.url} · ${r.durationMs?.toFixed(1) ?? "…"} ms`;
            detail.append(title);
            detail.addEventListener("toggle", async () => {
              if (detail.open) {
                try {
                  const value = await call("runner_network", {
                    id: r.id,
                  });
                  while (detail.children.length > 1) detail.lastChild!.remove();
                  detail.append(networkDetail(value));
                  const operationId =
                    value.context?.rootOperationId ||
                    value.context?.operationId;
                  if (operationId) {
                    const jump = document.createElement("button");
                    jump.textContent = "查看关联操作";
                    jump.onclick = () => {
                      select.value = "操作追踪";
                      change();
                      (
                        controls.querySelector(
                          '[aria-label="operationId"]',
                        ) as HTMLInputElement
                      ).value = operationId;
                      void trace(operationId);
                    };
                    detail.append(jump);
                  }
                  const analyze = document.createElement("button");
                  analyze.textContent = "分析此请求的字段来源";
                  analyze.onclick = () => {
                    selectedRequest = { id: r.id, runtimeId: runtimes.value };
                    select.value = "Signer Autopsy";
                    change();
                    const input = controls.querySelector<HTMLTextAreaElement>(
                      '[aria-label="执行分析参数"]',
                    );
                    if (input)
                      input.value = JSON.stringify(
                        { action: "start", requestId: r.id, timeoutMs: 60000 },
                        null,
                        2,
                      );
                    hint.textContent =
                      "启动后重新操作一次页面即可；也可在参数中指定一次原操作。不会直接重发旧 HTTP 请求。";
                  };
                  detail.append(analyze);
                  if (value.callStack)
                    detail.append(grouped("调用位置", value.callStack));
                } catch (e) {
                  fail(e);
                }
              }
            });
            output.append(detail);
          }
          return;
        }
        if (revision !== outputRevision) return;
        if (["变化", "异常", "实时日志"].includes(section)) {
          const { entries, ...meta } = value;
          output.replaceChildren(show(meta));
          for (const event of [...entries].filter(matches).reverse())
            output.append(
              grouped(
                `#${event.id} · ${event.type || event.source} · ${event.context?.rootHandler || event.name || event.level || ""}`,
                event,
              ),
            );
        } else output.replaceChildren(show(value));
      } catch (e) {
        fail(e);
      } finally {
        busy = false;
      }
    }
    async function trace(operationId: string) {
      let after = 0;
      const entries: any[] = [];
      for (;;) {
        const page = await call("runner_trace", {
          operationId,
          after,
          limit: 200,
        });
        entries.push(...page.entries);
        after = page.nextCursor;
        if (!page.hasMore) break;
      }
      output.replaceChildren(
        ...entries
          .filter(matches)
          .map((e) => grouped(`#${e.id} · ${e.source} · ${e.type || ""}`, e)),
      );
    }
    function change(renderInitial = true) {
      outputRevision++;
      controls.replaceChildren();
      if (select.value === "请求") {
        const url = field("URL 包含"),
          body = field("正文包含"),
          fields = field("投影字段，逗号分隔"),
          idA = field("请求 ID A"),
          idB = field("请求 ID B");
        fields.value = "id,url,method,status,source,handler";
        button("过滤请求", async () =>
          output.replaceChildren(
            show(
              await call("runner_network", {
                after: 0,
                filter: {
                  ...(url.value ? { urlIncludes: url.value } : {}),
                  ...(body.value ? { bodyIncludes: body.value } : {}),
                },
                fields: fields.value
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean),
              }),
            ),
          ),
        );
        button("读取请求详情", async () =>
          output.replaceChildren(
            networkDetail(await call("runner_network", { id: idA.value })),
          ),
        );
        button("比较两个请求", async () =>
          output.replaceChildren(
            show(
              await call("runner_network", {
                action: "diff",
                idA: idA.value,
                idB: idB.value,
              }),
            ),
          ),
        );
      }
      if (select.value === "函数 Hook") {
        const target = field("函数路径，例如 getApp().utils.getSign"),
          condition = field("只读条件，例如 args[0].length > 0"),
          id = field("hookId");
        button("安装 Hook（5 次／30 秒）", async () => {
          const r = await call("runner_hook", {
            target: target.value,
            ...(condition.value ? { when: condition.value } : {}),
          });
          id.value = r.hookId;
          output.replaceChildren(show(r));
        });
        for (const [label, action] of [
          ["读取 Hook 记录", "read"],
          ["撤除 Hook", "remove"],
        ])
          button(label, async () =>
            output.replaceChildren(
              show(await call("runner_hook", { action, hookId: id.value })),
            ),
          );
      }
      if (select.value === "模块源码") {
        const module = field("模块路径"),
          factory = field("工厂 ID（可选）"),
          q = field("源码关键词"),
          symbol = field("运行时函数路径"),
          offset = field("源码偏移");
        offset.value = "0";
        button("读取模块工厂", async () => {
          const r = await call("runner_source", {
            action: "get",
            path: module.value,
            ...(factory.value ? { factoryId: factory.value } : {}),
            offset: Number(offset.value),
          });
          offset.value = String(r.nextOffset);
          output.replaceChildren(show(r));
        });
        button("读取当前运行工厂", async () => {
          const r = await call("runner_source", {
            action: "get",
            path: module.value,
            current: true,
            offset: 0,
          });
          factory.value = r.factoryId;
          offset.value = String(r.nextOffset);
          output.replaceChildren(show(r));
        });
        button("列出同名工厂", async () => {
          const r = await call("runner_source", {
            action: "list",
            path: module.value,
          });
          output.replaceChildren(show(r));
          for (const m of r.modules || []) {
            const choose = document.createElement("button");
            choose.textContent = `选择 ${m.file}:${m.line}:${m.column} · ${m.sha256.slice(0, 12)}`;
            choose.onclick = () => {
              factory.value = m.factoryId;
              offset.value = "0";
            };
            output.append(choose);
          }
        });
        button("搜索模块源码", async () =>
          output.replaceChildren(
            show(await call("runner_source", { action: "search", q: q.value })),
          ),
        );
        button("检查插件依赖", async () => {
          const r = await call("runner_source", {
            action: "dependencies",
            ...(module.value ? { path: module.value } : {}),
            offset: Number(offset.value),
            limit: 50,
          });
          offset.value = String(r.nextOffset);
          output.replaceChildren(show(r));
        });
        button("定位运行时函数", async () =>
          output.replaceChildren(
            show(
              await call("runner_source", {
                action: "locate",
                target: symbol.value,
              }),
            ),
          ),
        );
        for (const [label, action] of [
          ["格式化模块", "format"],
          ["保守去混淆", "deobfuscate"],
          ["查看模块符号图", "graph"],
        ])
          button(label, async () =>
            output.replaceChildren(
              show(
                await call("runner_source", {
                  action,
                  path: module.value,
                  ...(factory.value ? { factoryId: factory.value } : {}),
                  offset: Number(offset.value),
                  includeMap: action !== "graph",
                }),
              ),
            ),
          );
      }
      if (select.value === "小程序包") {
        const keyword = field("小程序名称"),
          appid = field("确认 appid"),
          version = field("版本（按 appid 下载时必填）"),
          job = field("下载任务 ID");
        const request = () =>
          keyword.value.trim()
            ? {
                keyword: keyword.value.trim(),
                ...(appid.value.trim()
                  ? { expectedAppid: appid.value.trim() }
                  : {}),
              }
            : { appid: appid.value.trim(), version: Number(version.value) };
        button("搜索小程序", async () =>
          output.replaceChildren(
            show(
              await call("runner_packages", {
                action: "search",
                keyword: keyword.value.trim(),
              }),
            ),
          ),
        );
        button("解析版本", async () => {
          const r = await call("runner_packages", {
            action: "resolve",
            ...request(),
          });
          appid.value = r.appid;
          version.value = String(r.version);
          output.replaceChildren(show(r));
        });
        button("下载主包及全部分包", async () => {
          const r = await call("runner_packages", {
            action: "download",
            ...request(),
          });
          job.value = r.jobId;
          output.replaceChildren(show(r));
        });
        for (const [text, action] of [
          ["查询下载进度", "get"],
          ["取消下载", "cancel"],
        ])
          button(text, async () =>
            output.replaceChildren(
              show(
                await call("runner_packages", {
                  action,
                  jobId: job.value.trim(),
                }),
              ),
            ),
          );
        button("校验本地包", async () =>
          output.replaceChildren(
            show(
              await call("runner_packages", {
                action: "inspect",
                appid: appid.value.trim(),
                version: Number(version.value),
              }),
            ),
          ),
        );
      }
      if (select.value === "原生组件") {
        const id = field("原生组件 ID"),
          position = field("播放位置（秒）");
        const imagePath = field("相机图片绝对路径"),
          scanResult = field("模拟扫码内容");
        for (const mode of ["system", "image", "simulated"])
          button("相机输入：" + mode, async () =>
            output.replaceChildren(
              show(
                await call("runner_native", {
                  action: "camera-input",
                  id: id.value,
                  mode,
                  ...(mode === "image" && imagePath.value
                    ? { file: imagePath.value }
                    : {}),
                }),
              ),
            ),
          );
        button("发送模拟扫码", async () =>
          output.replaceChildren(
            show(
              await call("runner_native", {
                action: "scan",
                id: id.value,
                result: scanResult.value,
              }),
            ),
          ),
        );
        button("停止相机", async () =>
          output.replaceChildren(
            show(await call("runner_native", { action: "stop", id: id.value })),
          ),
        );
        for (const action of ["get", "play", "pause", "seek"])
          button(action, async () =>
            output.replaceChildren(
              show(
                await call("runner_native", {
                  action,
                  id: id.value,
                  ...(action === "seek"
                    ? { position: Number(position.value) }
                    : {}),
                }),
              ),
            ),
          );
      }
      if (select.value === "云开发") {
        const request = field("云操作 JSON（真实远端）", true),
          job = field("云任务 ID");
        request.value =
          '{"operation":"databaseQuery","collection":"test","limit":20}';
        button("执行所填云操作", async () => {
          const result = await call("runner_cloud", {
            ...JSON.parse(request.value),
            action: "start",
          });
          job.value = result.jobId;
          output.replaceChildren(show(result));
        });
        button("读取云任务结果", async () =>
          output.replaceChildren(
            show(
              await call("runner_cloud", { action: "get", jobId: job.value }),
            ),
          ),
        );
      }
      if (select.value === "启动分析") {
        const request = document.createElement("textarea");
        request.setAttribute("aria-label", "启动分析配置");
        request.value = JSON.stringify(
          {
            enabled: true,
            cryptoTap: true,
            defeatAntiHook: false,
            ttlMs: 60000,
            execution: { enabled: true, files: [], modules: [] },
          },
          null,
          2,
        );
        controls.append(request);
        button("新建隔离分析实例", async () => {
          const current = await call("runner_status");
          const result = await call("runner_runtime", {
            action: "start",
            packageDir: current.packageDir,
            appid: current.appid,
            analysis: JSON.parse(request.value),
          });
          output.replaceChildren(show(result));
        });
      }
      if (["Crypto 采集", "执行切片", "函数 Oracle"].includes(select.value)) {
        const name =
          select.value === "Crypto 采集"
            ? "runner_crypto_watch"
            : select.value === "执行切片"
              ? "runner_slice"
              : "runner_oracle";
        const request = document.createElement("textarea");
        request.setAttribute("aria-label", "分析工具参数");
        request.value = JSON.stringify(
          { action: select.value === "Crypto 采集" ? "status" : "list" },
          null,
          2,
        );
        controls.append(request);
        if (select.value === "Crypto 采集") {
          const ids = field("探针 ID（逗号分隔）"),
            run = field("采集执行 ID"),
            operation = field("采集操作 ID");
          const after = field("Crypto 游标");
          after.value = "0";
          button("读取可读步骤与验算", async () => {
            const result = await call(name, {
              action: "read",
              summary: true,
              after: Number(after.value),
              limit: 30,
              ...(run.value ? { runId: run.value } : {}),
            });
            after.value = String(result.nextCursor ?? after.value);
            output.replaceChildren(show(result));
          });
          for (const [label, action] of [
            ["按指定操作启用探针", "arm"],
            ["暂停所选探针", "disarm"],
          ])
            button(label, async () =>
              output.replaceChildren(
                show(
                  await call(name, {
                    action,
                    tapIds: ids.value
                      .split(",")
                      .map((v) => v.trim())
                      .filter(Boolean),
                    ...(action === "arm"
                      ? {
                          count: 1000,
                          ...(run.value ? { runId: run.value } : {}),
                          ...(operation.value
                            ? { operationId: operation.value }
                            : {}),
                        }
                      : {}),
                  }),
                ),
              ),
            );
        }
        button("执行分析命令", async () =>
          output.replaceChildren(
            show(
              await call(name, {
                ...JSON.parse(request.value),
                revealSensitive: reveal.checked,
              }),
            ),
          ),
        );
      }
      if (
        ["执行反虚拟化", "字段写监视", "Signer Autopsy"].includes(select.value)
      ) {
        const name =
          select.value === "Signer Autopsy"
            ? "runner_autopsy"
            : "runner_execution";
        const request = document.createElement("textarea");
        request.setAttribute("aria-label", "执行分析参数");
        request.value = JSON.stringify(
          select.value === "字段写监视"
            ? { action: "watch", properties: ["X-Sign", "sign"] }
            : { action: name === "runner_autopsy" ? "list" : "status" },
          null,
          2,
        );
        controls.append(request);
        let nextSliceCursor: string | null = null;
        if (name === "runner_execution") {
          const sink = field("切片终点事件 ID");
          const runExport = field("要导出的采集 runId"),
            exportJob = field("导出任务 ID");
          button("流式导出完整记录", async () => {
            const result = await call(name, {
              action: "export",
              runId: runExport.value,
              revealSensitive: reveal.checked,
            });
            exportJob.value = result.id;
            output.replaceChildren(show(result));
          });
          button("查询导出产物", async () =>
            output.replaceChildren(
              show(
                await call(name, {
                  action: "getExport",
                  jobId: exportJob.value,
                }),
              ),
            ),
          );
          button("取消导出", async () =>
            output.replaceChildren(
              show(
                await call(name, {
                  action: "cancelExport",
                  jobId: exportJob.value,
                }),
              ),
            ),
          );

          const readSlice = async (query: any) => {
            const result = await call(name, {
              ...query,
              revealSensitive: reveal.checked,
            });
            nextSliceCursor = result.nextSliceCursor || null;
            request.value = JSON.stringify(query, null, 2);
            output.replaceChildren(show(result));
          };
          button("查看依赖分类", async () => {
            output.replaceChildren(
              show(
                await call(name, {
                  action: "dependencies",
                  eventId: Number(sink.value),
                }),
              ),
            );
          });
          const expand = field("局部展开索引的事件 ID（逗号分隔）");
          button("开始分页切片", async () => {
            nextSliceCursor = null;
            await readSlice({
              action: "explain",
              eventId: Number(sink.value),
              paged: true,
              expandEvents: expand.value
                ? expand.value.split(",").map((v) => Number(v.trim()))
                : [],
              maxNodes: 100,
              fields: [
                "kind",
                "operator",
                "native",
                "value",
                "deps",
                "location",
                "provenance",
                "opaque",
              ],
            });
          });
          button("读取下一页切片", async () => {
            if (!nextSliceCursor)
              throw Error("请先开始分页切片；当前没有下一页");
            await readSlice({
              action: "explain",
              sliceCursor: nextSliceCursor,
              fields: [
                "kind",
                "operator",
                "native",
                "value",
                "deps",
                "location",
                "provenance",
                "opaque",
              ],
            });
          });
          button("按源码汇总执行", async () => {
            const previous = JSON.parse(request.value);
            const query = {
              action: "summary",
              groupBy: "source",
              limit: 30,
              ...(previous.runId ? { runId: previous.runId } : {}),
              ...(previous.natives ? { natives: previous.natives } : {}),
            };
            request.value = JSON.stringify(query, null, 2);
            output.replaceChildren(
              show(
                await call(name, { ...query, revealSensitive: reveal.checked }),
              ),
            );
          });
        }
        button("执行所填分析操作", async () => {
          const result = await call(name, {
            ...JSON.parse(request.value),
            revealSensitive: reveal.checked,
          });
          nextSliceCursor = result.nextSliceCursor || null;
          output.replaceChildren(show(result));
          if (name === "runner_autopsy" && result.id) {
            const id = controls.querySelector<HTMLInputElement>(
              '[aria-label="Autopsy 任务 ID"]',
            );
            if (id) id.value = result.id;
          }
        });
      }
      if (select.value === "Signer Autopsy") {
        const job = field("Autopsy 任务 ID");
        const choice = (label: string, options: [string, string][]) => {
          const el = document.createElement("select");
          el.setAttribute("aria-label", label);
          for (const [value, text] of options) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = text;
            el.append(option);
          }
          controls.append(el);
          return el;
        };
        const requestId = field("分析请求 ID（可从请求页选择）"),
          url = field("待观察 URL 包含"),
          scope = choice("分析字段位置", [
            ["header", "请求头"],
            ["body", "请求正文"],
            ["query", "查询参数"],
          ]),
          fieldName = field("分析字段名"),
          triggerMode = choice("分析触发方式", [
            ["manual", "人工操作一次"],
            ["click", "点击页面元素一次"],
            ["oracle", "调用已有 Oracle 一次"],
          ]),
          triggerValue = field("触发选择器或 Oracle ID"),
          triggerArgs = field("Oracle 参数数组", true),
          condition = choice("业务结果条件", [
            ["none", "不判断业务结果"],
            ["text", "出现文字"],
            ["element", "元素可见"],
            ["hidden", "元素消失"],
            ["route", "到达路由"],
            ["state", "data 等于预期值"],
            ["log", "出现新日志"],
          ]),
          expected = field("预期文字、选择器、路由或 JSON 值"),
          instance = field("结果实例 ID"),
          dataPath = field("data 路径（点分隔）"),
          timeout = field("分析超时毫秒");
        if (selectedRequest?.runtimeId === runtimes.value)
          requestId.value = selectedRequest.id;
        fieldName.value = "X-Sign";
        triggerArgs.value = "[]";
        timeout.value = "10000";
        const note = document.createElement("p");
        note.textContent =
          "1 选择请求与字段 → 2 只读预检 → 3 启动采集并操作一次 → 4 检查步骤／业务条件 → 5 源码、复算与 A/B。条件匹配仅表示你指定的结果出现，不证明由本次操作独占引起。";
        controls.append(note);
        const config = () => ({
          ...(requestId.value ? { requestId: requestId.value } : {}),
          ...(url.value ? { urlIncludes: url.value } : {}),
          ...(fieldName.value
            ? { field: { in: scope.value, name: fieldName.value } }
            : {}),
          timeoutMs: Number(timeout.value),
          ...(triggerMode.value === "manual"
            ? {}
            : {
                trigger:
                  triggerMode.value === "click"
                    ? {
                        tool: "runner_click",
                        arguments: { selector: triggerValue.value },
                      }
                    : {
                        tool: "runner_oracle",
                        arguments: {
                          action: "call",
                          oracleId: triggerValue.value,
                          args: JSON.parse(triggerArgs.value),
                        },
                      },
              }),
          ...(condition.value === "none"
            ? {}
            : {
                resultCondition:
                  condition.value === "state"
                    ? {
                        kind: "state",
                        instanceId: instance.value,
                        path: dataPath.value.split("."),
                        equals: JSON.parse(expected.value),
                      }
                    : {
                        kind: condition.value,
                        [condition.value === "route"
                          ? "route"
                          : ["element", "hidden"].includes(condition.value)
                            ? "selector"
                            : "text"]: expected.value,
                      },
              }),
        });
        const key = () => JSON.stringify([runtimes.value, config()]);
        let checkedKey = "",
          checkedSession = "";
        const start = button("启动本次分析（最多触发一次）", async () => {
          if (checkedKey !== key()) throw Error("配置已变化，请重新预检");
          start.disabled = true;
          checkedKey = "";
          const result = await call("runner_autopsy", {
            ...config(),
            action: "start",
            sessionId: checkedSession,
          });
          job.value = result.id;
          output.replaceChildren(show(result));
        });
        start.disabled = true;
        const preflight = button("只读预检分析条件", async () => {
          start.disabled = true;
          checkedKey = "";
          const signature = key(),
            result = await call("runner_autopsy", {
              ...config(),
              action: "preflight",
            });
          output.replaceChildren(show(result));
          if (result.ready && signature === key()) {
            checkedKey = signature;
            checkedSession = result.sessionId;
            start.disabled = false;
          }
        });
        controls.insertBefore(preflight, start);
        const invalidate = () => {
          start.disabled = true;
          checkedKey = "";
        };
        for (const el of [
          requestId,
          url,
          scope,
          fieldName,
          triggerMode,
          triggerValue,
          triggerArgs,
          condition,
          expected,
          instance,
          dataPath,
          timeout,
        ])
          el.addEventListener("input", invalidate);
        const visibility = () => {
          triggerValue.hidden = triggerMode.value === "manual";
          triggerArgs.hidden = triggerMode.value !== "oracle";
          expected.hidden = condition.value === "none";
          instance.hidden = dataPath.hidden = condition.value !== "state";
        };
        triggerMode.addEventListener("change", visibility);
        condition.addEventListener("change", visibility);
        visibility();
        button("填入已有 Oracle", async () => {
          const result = await call("runner_oracle", { action: "list" });
          output.replaceChildren(show(result));
          for (const oracle of result.oracles || []) {
            const id = oracle.oracleId || oracle.id;
            const b = document.createElement("button");
            b.textContent = "选择 Oracle · " + id;
            b.onclick = () => {
              triggerMode.value = "oracle";
              triggerValue.value = id;
              visibility();
              invalidate();
            };
            output.append(b);
          }
        });
        const sourceAt = async (location: any) => {
          const loc = location?.location || location;
          if (!loc?.file || !loc.line)
            throw Error("本记录没有可确认的源码位置");
          const all: any[] = [];
          let offset = 0,
            more = true;
          while (more && offset < 2000) {
            const r = await call("runner_source", {
              action: "list",
              file: loc.file,
              offset,
              limit: 100,
            });
            all.push(...r.modules);
            more = r.hasMore;
            offset = r.nextOffset;
          }
          const found = all.filter(
            (m) =>
              (loc.line > m.line ||
                (loc.line === m.line && loc.column >= m.column)) &&
              (loc.line < m.endLine ||
                (loc.line === m.endLine && loc.column <= m.endColumn)),
          );
          if (found.length !== 1 || more) {
            output.replaceChildren(
              show({
                location: loc,
                candidates: found,
                truncated: more,
                reason: "无法唯一确定工厂；请在模块源码中明确选择",
              }),
            );
            return;
          }
          const m = found[0];
          select.value = "模块源码";
          change(false);
          (
            controls.querySelector(
              '[aria-label="模块路径"]',
            ) as HTMLInputElement
          ).value = m.path;
          (
            controls.querySelector(
              '[aria-label="工厂 ID（可选）"]',
            ) as HTMLInputElement
          ).value = m.factoryId;
          output.replaceChildren(
            show(
              await call("runner_source", {
                action: "get",
                path: m.path,
                factoryId: m.factoryId,
                offset: 0,
              }),
            ),
          );
        };
        let currentReport: any;
        button("读取分析报告", async () => {
          const result = await call("runner_autopsy", {
            action: "get",
            jobId: job.value,
          });
          currentReport = result;
          output.replaceChildren(show(result));
          const summary = result.report?.cryptoSummary;
          if (summary)
            output.append(grouped("Crypto 步骤与独立验算", summary, true));
          if (result.report?.outcome)
            output.append(
              grouped(
                "输入、传输与业务条件",
                result.outcome || result.report.outcome,
                true,
              ),
            );
          for (const step of summary?.steps || []) {
            if (!(step.source?.location || step.source)?.file) continue;
            const b = document.createElement("button");
            b.textContent = `定位 Crypto 调用源码 · ${step.callId} · ${step.label}`;
            b.onclick = () => void sourceAt(step.source).catch(fail);
            output.append(b);
          }
          for (const field of result.report?.fields || []) {
            const loc = field.steps?.find(
              (s: any) => s.location?.file,
            )?.location;
            if (!loc) continue;
            const b = document.createElement("button");
            b.textContent = `定位字段源码 · ${field.field?.name}`;
            b.onclick = () => void sourceAt(loc).catch(fail);
            output.append(b);
          }
          for (const oracle of result.report?.oracles || []) {
            const invoke = document.createElement("button");
            invoke.textContent =
              "准备复算 · " +
              (oracle.source?.expression?.slice(0, 60) || oracle.oracleId);
            invoke.onclick = () => {
              select.value = "函数 Oracle";
              change();
              const input = controls.querySelector<HTMLTextAreaElement>(
                '[aria-label="分析工具参数"]',
              );
              if (input)
                input.value = JSON.stringify(
                  { action: "call", oracleId: oracle.oracleId, args: [] },
                  null,
                  2,
                );
            };
            output.append(invoke);
          }
        });
        for (const side of ["a", "b"] as const)
          button(`将当前报告设为 ${side.toUpperCase()}`, () => {
            if (!currentReport?.runId || currentReport.phase !== "finished")
              throw Error("先读取已结束任务的报告");
            const pair = experiments.get(runtimes.value) || {};
            pair[side] = {
              runtimeId: runtimes.value,
              sessionId: currentReport.sessionId,
              runId: currentReport.runId,
              requestId: currentReport.requestId,
            };
            experiments.set(runtimes.value, pair);
            output.replaceChildren(
              show({ comparison: pair, actionsSubmitted: 0 }),
            );
          });
        button("比较 A/B 的执行、Crypto 和请求", async () => {
          const pair = experiments.get(runtimes.value);
          if (!pair?.a || !pair.b || pair.a.sessionId !== pair.b.sessionId)
            throw Error("先选择同一会话的 A、B 报告");
          const { a, b } = pair;
          const commands: [string, any][] = [
            [
              "runner_execution",
              { action: "diff", runA: a.runId, runB: b.runId },
            ],
            [
              "runner_crypto_watch",
              { action: "diff", runA: a.runId, runB: b.runId },
            ],
            [
              "runner_network",
              { action: "diff", idA: a.requestId, idB: b.requestId },
            ],
          ];
          const results = await Promise.all(
            commands.map(async ([tool, args]) => {
              try {
                return {
                  tool,
                  result: await call(tool, { ...args, sessionId: a.sessionId }),
                };
              } catch (e: any) {
                return { tool, error: e.message };
              }
            }),
          );
          output.replaceChildren(
            show({ comparison: pair, actionsSubmitted: 0, results }),
          );
        });
        button("读取当前分析产物", async () => {
          if (!currentReport?.artifactId) throw Error("先读取带有产物的报告");
          select.value = "分析产物";
          change(false);
          (
            controls.querySelector(
              '[aria-label="artifactId"]',
            ) as HTMLInputElement
          ).value = currentReport.artifactId;
          output.replaceChildren(
            show(
              await call("runner_artifact", {
                action: "read",
                id: currentReport.artifactId,
              }),
            ),
          );
        });
        button("取消分析任务", async () =>
          output.replaceChildren(
            show(
              await call("runner_autopsy", {
                action: "cancel",
                jobId: job.value,
              }),
            ),
          ),
        );
      }
      if (select.value === "模拟设备") {
        const preset = document.createElement("select");
        preset.setAttribute("aria-label", "设备预设");
        for (const name of ["pc", "android", "ios"]) {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          preset.append(option);
        }
        controls.append(preset);
        button("启用设备模拟", async () => {
          await call("runner_device", {
            action: "preset",
            preset: preset.value,
            simulation: true,
          });
          await render();
        });
        button("关闭设备模拟", async () => {
          await call("runner_device", {
            action: "preset",
            preset: "pc",
            simulation: false,
          });
          await render();
        });
        const state = field("设备状态 JSON", true);
        state.value = '{"battery":{"level":70,"isCharging":false}}';
        button("设置设备状态", async () => {
          await call("runner_device", {
            action: "set",
            state: JSON.parse(state.value),
          });
          await render();
        });
        const event = field("设备事件名称"),
          data = field("设备事件数据 JSON", true);
        event.value = "compass";
        data.value = '{"direction":90,"accuracy":5}';
        button("发送模拟输入", async () =>
          output.replaceChildren(
            show(
              await call("runner_device", {
                action: "emit",
                event: event.value,
                data: JSON.parse(data.value),
              }),
            ),
          ),
        );
      }
      if (select.value === "官方契约") {
        const id=field("契约 ID"),scenario=field("已登记场景 ID"),job=field("契约任务 ID");
        scenario.value="view-library-batches";
        button("证据、实现与断言",async()=>{
          const result=await call("runner_suite",{action:"contracts",contractId:id.value,details:true,limit:1});
          output.replaceChildren(show({current:result.current,reason:result.reason,fingerprint:result.fingerprint}),...result.entries.flatMap((entry:any)=>[
            grouped(entry.id,{implementation:entry.implementation,boundaries:entry.boundaries,observed:entry.observed},true),
            grouped("官方源码证据",entry.official,false),grouped("场景与断言",entry.verification,true)]));
        });
        for(const [title,collection] of [["扫描文件","files"],["未解析调用","unresolved"],["已登记场景","scenarios"]])
          button(title,async()=>output.replaceChildren(show(await call("runner_suite",{action:"contracts",collection,q:search.value,limit:30}))));
        button("导出完整账本",async()=>output.replaceChildren(show(await call("runner_suite",{action:"contracts",exportReport:true,limit:1}))));
        button("在新隔离夹具中运行",async()=>{const result=await call("runner_suite",{action:"contractRun",scenarioId:scenario.value});job.value=result.id;output.replaceChildren(show(result));});
        button("查询契约任务",async()=>output.replaceChildren(show(await call("runner_suite",{action:"get",jobId:job.value}))));
        button("取消契约任务",async()=>output.replaceChildren(show(await call("runner_suite",{action:"cancel",jobId:job.value}))));
      }
      if (select.value === "验收目录") {
        const routes = field("页面路径（每行一页）", true),
          steps = field("场景步骤 JSON", true),
          job = field("验收任务 ID");
        steps.value = '[{"tool":"runner_screenshot","arguments":{}}]';
        button("运行所选页面", async () => {
          const result = await call("runner_suite", {
            action: "start",
            routes: routes.value
              .split(/\n/)
              .map((s) => s.trim())
              .filter(Boolean),
            steps: JSON.parse(steps.value),
          });
          job.value = result.id;
          output.replaceChildren(show(result));
        });
        button("运行分析场景（保持当前页）", async () => {
          const result = await call("runner_suite", {
            action: "start",
            mode: "analysis",
            steps: JSON.parse(steps.value),
          });
          job.value = result.id;
          output.replaceChildren(show(result));
        });
        button("查询任务结果", async () =>
          output.replaceChildren(
            show(
              await call("runner_suite", { action: "get", jobId: job.value }),
            ),
          ),
        );
        button("取消任务", async () =>
          output.replaceChildren(
            show(
              await call("runner_suite", {
                action: "cancel",
                jobId: job.value,
              }),
            ),
          ),
        );
      }
      if (select.value === "定位") {
        const latitude = field("纬度（WGS84）"),
          longitude = field("经度（WGS84）"),
          accuracy = field("模拟精度（米）");
        accuracy.value = "25";
        const rememberLabel = document.createElement("label");
        const remember = document.createElement("input");
        remember.type = "checkbox";
        rememberLabel.append(remember, "为此小程序保存定位（重启后沿用）");
        accuracy.after(rememberLabel);
        button("启用模拟定位", async () => {
          if (![latitude, longitude, accuracy].every((f) => f.value.trim()))
            throw Error("请填写经纬度和精度");
          await call("runner_state", {
            action: "location",
            persist: remember.checked,
            location: {
              mode: "simulated",
              latitude: Number(latitude.value),
              longitude: Number(longitude.value),
              accuracy: Number(accuracy.value),
            },
          });
          await render();
        });
        button("恢复系统定位", async () => {
          await call("runner_state", {
            action: "location",
            persist: false,
            location: { mode: "system" },
          });
          await render();
        });
      }
      if (select.value === "操作追踪") {
        const id = field("operationId");
        button("查询操作时间线", () => trace(id.value));
      }
      if (select.value === "网络规则") {
        const rule = field("规则 JSON（默认关闭）", true);
        rule.value = JSON.stringify(
          {
            enabled: false,
            priority: 0,
            match: { urlIncludes: "/example" },
            action: "mock",
            response: {
              status: 200,
              headers: { "content-type": "application/json" },
              body: '{"ok":true}',
            },
          },
          null,
          2,
        );
        button("保存规则", async () => {
          await call("runner_network_rules", {
            action: "set",
            rule: JSON.parse(rule.value),
          });
          await render();
        });
        const id = field("规则或挂起请求 ID");
        for (const action of ["enable", "disable", "remove"])
          button(action, async () => {
            await call("runner_network_rules", { action, id: id.value });
            await render();
          });
        const decision = field("请求处理 JSON", true);
        decision.value = '{"action":"continue"}';
        button("处理挂起请求", async () => {
          await call("runner_network_rules", {
            action: "resolve",
            id: id.value,
            decision: JSON.parse(decision.value),
          });
          await render();
        });
        const conditions = field("网络条件 JSON", true);
        conditions.value =
          '{"offline":false,"latencyMs":0,"uploadBytesPerSecond":0,"downloadBytesPerSecond":0}';
        button("应用网络条件", async () => {
          await call("runner_network_rules", {
            action: "conditions",
            conditions: JSON.parse(conditions.value),
          });
          await render();
        });
        const requestId = field("重发的 requestId");
        button("显式重发一次", async () =>
          output.replaceChildren(
            show(await call("runner_replay", { id: requestId.value })),
          ),
        );
      }
      if (select.value === "运行实例") {
        const packageDir = field("明文包绝对路径"),
          appid = field("appid"),
          profile = field("可选 profile");
        for (const action of ["start", "switch"])
          button(action === "start" ? "启动新实例" : "预检并换包", async () => {
            await call("runner_runtime", {
              action,
              packageDir: packageDir.value,
              ...(appid.value ? { appid: appid.value } : {}),
              ...(profile.value ? { profile: profile.value } : {}),
            });
            await render();
          });
        for (const action of ["stop", "restart", "closeSession"])
          button(action, async () => {
            await call("runner_runtime", { action });
            await render();
          });
        button("打开选中目标 F12", () =>
          call("runner_debugger", { action: "open", ...targetArgs() }),
        );
      }
      if (select.value === "分析产物") {
        for (const kind of ["cpu", "trace", "heap", "allocations"])
          button("启动 " + kind, async () => {
            await call("runner_profile", {
              action: "start",
              kind,
              ...targetArgs(),
            });
            await render();
          });
        const jobId = field("jobId");
        button("停止分析", async () => {
          await call("runner_profile", { action: "stop", jobId: jobId.value });
          await render();
        });
        const artifactId = field("artifactId"),
          destination = field("导出绝对路径");
        button("读取产物预览", async () =>
          output.replaceChildren(
            show(
              await call("runner_artifact", {
                action: "read",
                id: artifactId.value,
              }),
            ),
          ),
        );
        button("导出产物", async () =>
          output.replaceChildren(
            show(
              await call("runner_artifact", {
                action: "export",
                id: artifactId.value,
                destination: destination.value,
              }),
            ),
          ),
        );
        button("导出网络会话目录", async () =>
          output.replaceChildren(
            show(
              await call("runner_artifact", {
                action: "session",
                destination: destination.value,
              }),
            ),
          ),
        );
        button("生成 HAR", async () => {
          output.replaceChildren(
            show(await call("runner_artifact", { action: "har" })),
          );
        });
      }
      if (select.value === "状态") {
        const id = field("instanceId"),
          patch = field("setData JSON", true),
          selector = field("组件内 CSS selector");
        button("读取实例", async () => {
          output.replaceChildren(
            show(
              await call("runner_state", {
                action: "get",
                instanceId: id.value,
              }),
            ),
          );
        });
        button("提交 setData", async () => {
          await call("runner_state", {
            action: "setData",
            instanceId: id.value,
            patch: JSON.parse(patch.value),
          });
          await render();
        });
        button("定位组件内 DOM", async () => {
          output.replaceChildren(
            show(
              await call("runner_state", {
                action: "locate",
                instanceId: id.value,
                selector: selector.value,
              }),
            ),
          );
        });
      }
      if (select.value === "存储") {
        const key = field("storage key"),
          value = field("storage JSON value", true);
        button("写入", async () => {
          await call("runner_storage", {
            action: "set",
            key: key.value,
            value: JSON.parse(value.value),
          });
          await render();
        });
        button("删除此键", async () => {
          await call("runner_storage", {
            action: "remove",
            key: key.value,
          });
          await render();
        });
        const confirm = document.createElement("input");
        confirm.type = "checkbox";
        const lab = document.createElement("label");
        lab.append(confirm, "确认清空当前小程序存储");
        controls.append(lab);
        button("清空", async () => {
          await call("runner_storage", {
            action: "clear",
            confirm: confirm.checked,
          });
          await render();
        });
      }
      if (select.value === "DOM") {
        const selector = field("CSS selector");
        for (const action of ["inspect", "highlight"])
          button(action, async () => {
            output.replaceChildren(
              show(
                await call("runner_dom", {
                  selector: selector.value,
                  action,
                }),
              ),
            );
          });
      }
      if (renderInitial) void render();
    }
    reveal.onchange = () => {
      events.length = 0;
      cursor = 0;
      void render();
    };
    runtimes.onchange = () => {
      cursor = 0;
      events.length = 0;
      change();
    };
    search.oninput = () => void render();
    select.onchange = () => change();
    refresh.onclick = () => void render();
    change();
    setInterval(() => {
      if ((auto.checked || awaitingStartup) && widget.isShowing())
        void render();
    }, 1000);
    return widget;
  };
  const location = await manager.resolveLocation("panel");
  location.appendView(await create());
})().catch((e) => console.error("Wxapp panel failed", e));
