# Source distribution

WxappRunner project code is licensed under Apache-2.0. Dependency licenses remain unchanged; see LICENSE, NOTICE and THIRD_PARTY_NOTICES.md.

This repository distributes source code, not installers. It intentionally excludes:

- WeChat base libraries and native framework binaries;
- downloaded third-party mini-program packages;
- private account gateways, credentials, device IDs and login sessions;
- copied third-party SDK factories and app-specific reconstructed algorithms;
- raw reverse-engineering artifacts, private traces, screenshots and user data;
- prior private Git history and prebuilt application bundles.

The runtime currently expects a separately supplied compatible base library. Providing an external path does not itself establish a license to use that software. The project license covers only the rights its contributors can grant.

Source-only publication checks cover TypeScript and the public fixture suite. Other runtime and platform claims require the relevant external inputs and current test evidence. Historical private acceptance reports are not included or automatically applicable to this public checkout.
