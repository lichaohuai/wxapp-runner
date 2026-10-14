/** Keep network experiments visibly distinct from ordinary compatibility runs. */
export function runtimeTitle(config: any, simulatedLocation = false) {
  return [
    "WxappRunner",
    config.appid,
    config.profile && config.profile !== "default" ? config.profile : undefined,
    config.analysis?.enabled ? "分析实例" : undefined,
    config.analysis?.networkMode === "local-only"
      ? "仅本机网络 · 外网图片已拦截"
      : undefined,
    simulatedLocation ? "模拟定位" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}
