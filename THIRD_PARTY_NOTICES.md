# Third-party components

Original DeepLook API code is licensed under Apache-2.0. The pinned browser submodule is a separate Apache-2.0 project with its own [third-party notices](vendor/deeplook/THIRD_PARTY_NOTICES.md).

The container sandbox profile in `security/playwright-seccomp.json` derives from Playwright. Its Apache-2.0 license is retained in [security/PLAYWRIGHT-LICENSE](security/PLAYWRIGHT-LICENSE).

The runtime container installs Chromium, its sandbox, fonts, certificates and other Debian packages. Those components retain their original licenses and package copyright files. The container does not distribute the proprietary Google Chrome binary. Build dependencies include TypeScript (Apache-2.0) and Node.js type declarations (MIT); their license files remain in their packages.

Node.js and the base container image have separate upstream licenses. Apache-2.0 for this repository applies to original project work, not a replacement license for third-party software.
