import { contractId } from "./model";
/** Explicit assertion bindings, reviewed against the fixture's asserts. A receipt
 * proves these assertions, never all semantics of the named API. */
export const contractScenarios = [
  {
    id: "foundation-resource-bytes", script: "smoke-native-libraries", report: "docs/native-libraries-result.json",
    bindings: [
      { contracts: [contractId("host","invoke","loadWAFile"), contractId("host","invoke","loadWAFileSync")],
        observedAs: [contractId("logic","invoke","loadWAFile"),contractId("logic","invoke","loadWAFileSync"),contractId("view","invoke","loadWAFile"),contractId("view","invoke","loadWAFileSync")],
        assertions: ["officialFoundationBytes","originalBridgeBinaryDecode","syncAsyncCallbackOrder","absentLibraryFails","packageDirectoryRejected","callbackOnce"],
        description: "Actual supplied WASM bytes through the original logic/view bridge, sync/async ordering and failed reads" },
    ],
  },
  {
    id: "h5-history-and-route", script: "smoke-h5-back", report: "docs/h5-history-contract-result.json",
    bindings: [
      { contracts: [contractId("host","invoke","insertHTMLWebView"),contractId("host","invoke","updateHTMLWebView"),contractId("host","invoke","removeHTMLWebView")],
        observedAs:[contractId("view","invoke","insertHTMLWebView"),contractId("view","invoke","updateHTMLWebView"),contractId("view","invoke","removeHTMLWebView")],
        assertions:["initialDocumentBackExits","redirectBackExits","realHistoryPreserved","sameDocumentHistoryPreserved","destroyedOnce","componentSourceUpdated","componentRemovedWithoutPageClose"],
        description:"Original web-view component, HTTP/client redirects, SPA/hash history and page teardown" },
      { contracts:[contractId("host","invoke","getCurrentRoute")],
        observedAs:[contractId("logic","invoke","getCurrentRoute"),contractId("view","invoke","getCurrentRoute")],
        assertions:["currentRouteAliases","hiddenPageReadsCurrentRoute","routeRestoredAfterBack"],
        description:"Navigator.currentRoute aliases, current rather than calling page, and back restoration" },
    ],
  },
  {
    id: "view-library-batches", script: "smoke-view-loader", report: "docs/view-loader-result.json",
    bindings: [
      { contracts: [contractId("view","invoke","loadLibFiles")], assertions: ["nativeContractViewCallbacks", "actualAuxiliaryLibrary", "auxiliaryLibrarySharedOnce", "auxiliaryLibraryRejectsPackageFile"], description: "Actual WARecordSDK, shared load and package/library separation" },
      { contracts: [contractId("host","invoke","loadJsFiles")], observedAs:[contractId("view","invoke","loadJsFiles")], assertions: ["callbackAfterExecution", "orderedDependencies", "batchCompletesBeforeMicrotasks", "sharedLoadOnce", "invalidArgumentsNoEffects", "missingScriptFails", "executionFailureNotReplayed"], description: "Ordered batches, callback after execution, deduplication and failure without replay" },
    ],
  },
  {
    id: "worker-native-isolation", script: "smoke-official-workers", report: "docs/official-workers-result.json",
    bindings: [
      { contracts: [contractId("worker","invoke","createRequestTask")], assertions: ["nativeContractWorkerIdentity", "officialWorkerClient", "isolatedRealms", "requestCallbacks", "inflightAbortOnTerminate", "noLateCallback"], description: "Original Worker SDK, isolated HTTP callbacks and termination" },
      { contracts: [contractId("worker","invoke","createDownloadTask"), contractId("worker","invoke","createUploadTask")], assertions: ["downloadUpload"], description: "Worker download and upload callbacks through a local server" },
      { contracts: [contractId("worker","invoke","createSocketTask")], assertions: ["socket"], description: "Original Worker SocketTask text echo" },
    ],
  },
] as const;
export function scenario(id: string) {
  const found = contractScenarios.find(s=>s.id===id);
  if (!found) throw Object.assign(Error("Unknown registered contract scenario"), {code:"CONTRACT_SCENARIO_UNKNOWN"});
  return found;
}
