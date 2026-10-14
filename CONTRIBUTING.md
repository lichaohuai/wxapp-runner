# Contributing

Changes should remain generic across mini-programs. Keep business domains, credentials and app-specific algorithm patches out of the runtime.

Before submitting changes:

```sh
npm ci
npm run typecheck
npm run test:public
```

For runtime changes, add a focused synthetic fixture and record any externally required base library/package version. Clearly distinguish fixtures, simulations, visible rendering and real business acceptance.

Do not commit `.local`, `.env`, account profiles, downloaded packages, proprietary base libraries, private traces, screenshots, HAR files or source excerpts that you cannot redistribute.

Contributions are submitted under the project's Apache-2.0 license.
