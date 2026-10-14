/** Version-specific native frontend entry points. Upgrade these with native UI regressions. */
export const devtoolsContract = {
  electron: "40.10.6",
  chromium: "144.0.7559.236",
  root: "devtools://devtools/bundled/",
  logic: "js_app.html?experiments=true&v8only=true&ws=",
  view: "inspector.html?experiments=true&ws=",
  ui: "devtools://devtools/bundled/ui/legacy/legacy.js",
  common: "devtools://devtools/bundled/core/common/common.js",
  breakpoints: "devtools://devtools/bundled/models/breakpoints/breakpoints.js",
  network: "devtools://devtools/bundled/panels/network/network.js",
  textUtils: "devtools://devtools/bundled/models/text_utils/text_utils.js",
  sourceFrame:
    "devtools://devtools/bundled/ui/legacy/components/source_frame/source_frame.js",
} as const;
