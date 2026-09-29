---
title: "Render spec UI mockups with a locally staged Chromium runtime"
modules: ["platform"]
areas: ["spec-pr", "backend-ui"]
topics: ["mockups", "playwright", "screenshots", "sandbox-tooling"]
---

# Render spec UI mockups with a locally staged Chromium runtime

**Context**: Producing PNG mockups for the `patient` specs (2026-09-29) required a headless browser. The
sandbox has `playwright` in `node_modules` but no downloaded browser, no root account, and no
`libnspr4`/`libnss3`/`libgbm1`/`libasound2` — `chromium.launch()` fails with
`error while loading shared libraries`, and `npx playwright install-deps` needs root.

**Problem**: The obvious fixes are unavailable (no `sudo`, `apt-get update` cannot write `/var/lib/apt`),
and the fallback of hand-writing SVG instead of HTML/CSS throws away the layout engine that makes
mockups look like the real backend UI.

**Rule**: Stage the runtime in writable paths instead of giving up on a browser.

1. `npx playwright install chromium` — downloads the headless shell into `~/.cache/ms-playwright`.
2. Point apt at temp dirs, no root needed:
   `apt-get -o Dir::State::lists=/tmp/apt/lists -o Dir::Cache=/tmp/apt/cache -o Dir::State::status=/tmp/apt/state/status -o Debug::NoLocking=1 update`
   (seed `status` from `/var/lib/dpkg/status` so installed packages are not re-fetched), then the same
   options with `install -y --download-only --no-install-recommends <libs>`.
3. `dpkg-deb -x` every `.deb` into one prefix and run node with
   `LD_LIBRARY_PATH=<prefix>/usr/lib/x86_64-linux-gnu:<prefix>/lib/x86_64-linux-gnu`.
4. Verify with `ldd <chrome-headless-shell> | grep "not found"` before launching.

Write mockups as one HTML file of `.screen` frames with the app's real tokens from
`src/app/globals.css`, and screenshot per frame with `locator('#id').screenshot()` at
`deviceScaleFactor: 2`. Headless Chromium here has no emoji font: emoji render as tofu, so use
geometric glyphs (`▤ ◍ ♡ ◷ ⚠ ⊞ ◎ ✓ ✕ ▾`) instead.

**Applies to**: `.ai/specs/assets/*` mockups, `om-spec-writing` / `om-backend-ui-design` design
artefacts, and any skill that needs a screenshot without the configured browser provider.
