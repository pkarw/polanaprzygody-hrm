---
title: "Render spec UI mockups with a locally staged Chromium runtime"
modules: ["platform"]
areas: ["spec-pr", "backend-ui"]
topics: ["mockups", "playwright", "screenshots", "sandbox-tooling"]
---

# Render spec UI mockups with a locally staged Chromium runtime

**Context**: Producing PNG mockups for the `patient` specs (2026-09-29, and again for VCAL on
2026-09-30) required a headless browser. The
sandbox has `playwright` in `node_modules` but no downloaded browser, no root account, and no
`libnspr4`/`libnss3`/`libgbm1`/`libasound2` — `chromium.launch()` fails with
`error while loading shared libraries`, and `npx playwright install-deps` needs root.

**Problem**: The obvious fixes are unavailable (no `sudo`, `apt-get update` cannot write `/var/lib/apt`),
and the fallback of hand-writing SVG instead of HTML/CSS throws away the layout engine that makes
mockups look like the real backend UI.

**Rule**: Stage the runtime in writable paths instead of giving up on a browser.

1. `npx playwright install chromium` — downloads the headless shell into `~/.cache/ms-playwright`.
2. Get the `.deb` files. Two routes, in order of preference:
   - Point apt at temp dirs, no root needed:
     `apt-get -o Dir::State::lists=/tmp/apt/lists -o Dir::Cache=/tmp/apt/cache -o Dir::State::status=/tmp/apt/state/status -o Debug::NoLocking=1 update`
     (seed `status` from `/var/lib/dpkg/status` so installed packages are not re-fetched), then the same
     options with `install -y --download-only --no-install-recommends <libs>`.
   - When apt has no usable sources at all — `apt-get download` answering
     `E: Unable to locate package libnss3` even for a package that certainly exists — skip apt and read
     the archive directly: `GET https://deb.debian.org/debian/dists/<suite>/main/binary-amd64/Packages.gz`,
     gunzip it, map `Package:` → `Filename:`, and fetch each `.deb` from `<mirror>/<Filename>`.
     Twenty lines of Node, no privileges, no apt state.
3. `dpkg-deb -x` every `.deb` into one prefix and run node with
   `LD_LIBRARY_PATH=<prefix>/usr/lib/x86_64-linux-gnu:<prefix>/lib/x86_64-linux-gnu`.
4. Verify with `ldd <chrome-headless-shell> | grep "not found"` before launching, and **repeat** — the
   first extraction reveals a second wave of missing transitive libraries. The full set for
   `chromium_headless_shell` on bookworm: `libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0
   libcups2 libdbus-1-3 libgbm1 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libasound2
   libxi6 libdrm2 libwayland-server0`.

Write mockups as one HTML file of `.screen` frames with the app's real tokens from
`src/app/globals.css`, and screenshot per frame with `locator('#id').screenshot()` at
`deviceScaleFactor: 2`.

Two failure modes that cost a render cycle each:

- **Emoji are tofu.** No emoji font is installed. Use geometric glyphs
  (`▤ ◍ ♡ ◷ ⚠ ⊞ ◎ ✓ ✕ ▾ ◌ ♪ ⇢`) instead. Circled letters are tofu too — `ⓘ` (U+24D8) does not render;
  draw the info badge in CSS (`border-radius:50%` around a literal `i`) rather than reaching for a glyph.
- **The page script runs in the global scope, so it collides with `window`.** `const top = …` — a natural
  name for a "pixel offset from the top" helper in a calendar mockup — throws
  `Identifier 'top' has already been declared`, `window.__SCREENS` stays `undefined`, and the render
  script fails with the unhelpful `screens is not iterable`. Same trap for `name`, `status`, `length`,
  `origin`, `parent`, `self`, `location`. Attach a `pageerror` listener while debugging a mockup page
  that renders nothing; the browser reports the real cause the render script hides.

**Applies to**: `.ai/specs/assets/*` mockups, `om-spec-writing` / `om-backend-ui-design` design
artefacts, and any skill that needs a screenshot without the configured browser provider.
