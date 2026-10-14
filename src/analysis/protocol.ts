export const analysisProtocolVersion = 5;
export function requiredAnalysisProtocol(name: string, a: any) {
  if (
    (name === "runner_autopsy" &&
      (a.resultCondition || a.action === "preflight")) ||
    (name === "runner_crypto_watch" && a.summary)
  )
    return 5;
  return requiresReviewProtocol(name, a) ? 4 : 0;
}
export function requiresReviewProtocol(name: string, a: any) {
  return (
    (name === "runner_source" && (a.current || !!a.factoryId)) ||
    (name === "runner_crypto_watch" && ["arm", "disarm"].includes(a.action)) ||
    (a.analysis?.networkMode && a.analysis.networkMode !== "normal") ||
    [...(a.analysis?.taps || []), ...(a.taps || []), ...(a.probes || [])].some(
      (tap: any) => tap.scope && tap.scope !== "all",
    )
  );
}
