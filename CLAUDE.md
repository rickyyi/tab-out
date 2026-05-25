# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tab Out is a Chrome Manifest V3 extension that replaces the new tab page with a dashboard of all open tabs grouped by domain. Pure client-side — no server, no build system, no npm dependencies.

## Dev Setup & Commands

- **No build step.** This is a plain HTML/CSS/JS Chrome extension. Edit files directly, then reload the extension in Chrome.
- **To load in Chrome:** Go to `chrome://extensions`, enable Developer mode, click "Load unpacked", select the `extension/` folder.
- **To reload after changes:** Click the refresh icon on the extension card in `chrome://extensions` (or `chrome.runtime.reload()` in the console).
- **No tests or linters.** Vanilla JS with no tooling.
- **Personal config:** `extension/config.local.js` (gitignored) — defines `LOCAL_LANDING_PAGE_PATTERNS` and `LOCAL_CUSTOM_GROUPS` for custom domain grouping rules.

## Architecture

### File Structure

```
extension/
  manifest.json        — Chrome MV3 manifest (permissions: tabs, activeTab, storage)
  index.html           — New tab page HTML shell
  app.js               — Main dashboard logic (~2300 lines, vanilla JS)
  style.css            — All styles (~2340 lines, CSS custom properties theming)
  background.js        — Service worker: toolbar badge with tab count
  lunisolar.js         — Lunar calendar library (external dependency)
  config.local.js      — Personal overrides (gitignored)
  icons/               — Extension icons (16px, 48px, 128px)
```

### Data Flow

1. `app.js` calls `chrome.tabs.query({})` to read all open browser tabs directly
2. Tabs are grouped by domain (hostname), with a special `__landing-pages__` group for homepage URLs (Gmail inbox, X home, YouTube home, etc.)
3. Domain groups are rendered as CSS column-grid cards with individual tab rows
4. User actions (close, focus, save) dispatch via a single `document.addEventListener('click', ...)` event delegation handler on `[data-action]` attributes
5. "Saved for later" tabs, health reminders, and recently-closed history persist in `chrome.storage.local`

### Key Modules in app.js

| Section | Lines | Purpose |
|---|---|---|
| Recently Closed | 35–76 | Stores last 50 closed tabs in `closedHistory` key |
| Chrome Tabs API | 86–258 | `fetchOpenTabs()`, `closeTabsByUrls()`, `focusTab()`, `closeDuplicateTabs()` |
| Saved for Later | 281–344 | CRUD for deferred tabs in `deferred` storage key |
| UI Helpers | 351–552 | Sound (Web Audio API), confetti particles, toast, time formatting |
| Title Cleanup | 714–886 | `FRIENDLY_DOMAINS` map + `cleanTitle()`/`smartTitle()` to strip site suffixes |
| Domain Card Renderer | 1042–1148 | Builds HTML for domain group cards with overflow chips at 8 tabs |
| Dashboard Renderer | 1388–1552 | `renderStaticDashboard()` — main render: fetch, group, sort, render, stats |
| Event Handlers | 1563–1854 | Single delegation listener for all user actions |
| Night Mode | 565–586 | Auto-activates 23:00–05:00 |
| Health Reminders | 2121–2257 | 30-minute cycle timer, persists across sessions |
| Weather | 679–708 | Fetches Shanghai weather from wttr.in (configured in manifest host_permissions) |

### Key Design Decisions

- **No framework**: vanilla JS, CSS columns for card grid, event delegation for all interactions
- **No iframe**: the dashboard IS the extension page (not embedded), so it calls `chrome.tabs` directly
- **Flat card design**: CSS custom properties for theming, no 3D shadows
- **Favicon fallback chain**: Google s2 → DuckDuckGo → hidden
- **Landing page detection**: defined via `LANDING_PAGE_PATTERNS` with overridable `LOCAL_LANDING_PAGE_PATTERNS` in config.local.js
- **Custom group rules**: `LOCAL_CUSTOM_GROUPS` in config.local.js lets users merge subdomains or split by path
- **Cross-tab sync**: `chrome.storage.onChanged` listener keeps dashboard in sync across multiple Tab Out tabs
