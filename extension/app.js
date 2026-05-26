/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   RECENTLY CLOSED — chrome.storage.local

   Stores the last N closed tabs so users can reopen them.
   Data shape stored under the "closedHistory" key:
   [
     {
       id: "1712345678901",
       url: "https://example.com",
       title: "Example Page",
       closedAt: "2026-04-04T10:00:00.000Z",
     },
     ...
   ]
   ---------------------------------------------------------------- */

const CLOSED_HISTORY_KEY = 'closedHistory';
const MAX_CLOSED_HISTORY = 50;

async function addToClosedHistory(tab) {
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) return;
  const { [CLOSED_HISTORY_KEY]: history = [] } = await chrome.storage.local.get(CLOSED_HISTORY_KEY);
  history.unshift({
    id: Date.now().toString(),
    url: tab.url,
    title: tab.title || tab.url,
    closedAt: new Date().toISOString(),
  });
  // Keep only the last MAX_CLOSED_HISTORY entries
  if (history.length > MAX_CLOSED_HISTORY) history.length = MAX_CLOSED_HISTORY;
  await chrome.storage.local.set({ [CLOSED_HISTORY_KEY]: history });
}

async function getClosedHistory() {
  const { [CLOSED_HISTORY_KEY]: history = [] } = await chrome.storage.local.get(CLOSED_HISTORY_KEY);
  return history;
}

async function removeFromClosedHistory(id) {
  const { [CLOSED_HISTORY_KEY]: history = [] } = await chrome.storage.local.get(CLOSED_HISTORY_KEY);
  const filtered = history.filter(h => h.id !== id);
  await chrome.storage.local.set({ [CLOSED_HISTORY_KEY]: filtered });
}

async function clearClosedHistory() {
  await chrome.storage.local.set({ [CLOSED_HISTORY_KEY]: [] });
}

async function reopenClosedTab(id) {
  const history = await getClosedHistory();
  const item = history.find(h => h.id === id);
  if (!item) return;
  await chrome.tabs.create({ url: item.url, active: false });
  await removeFromClosedHistory(id);
  showToast('Tab reopened');
  renderRecentlyClosedColumn();
}


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:          t.id,
      url:         t.url,
      title:       t.title,
      windowId:    t.windowId,
      active:      t.active,
      lastAccessed: t.lastAccessed || 0,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut:    t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hour' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour >= 23 || hour < 5) return '';
  return 'Good evening';
}

const NIGHT_PHRASES = [
  '还不睡吗 🌙',
  '在等谁的消息吗 💫',
  '我陪你一会儿 ✨',
  '夜深了 🌃',
  '还在忙呢 🍵',
  '夜猫子 🦉',
  '该睡了哦 🌜',
  '晚安前再看一眼 🌛',
];

function updateNightMode() {
  const hour = new Date().getHours();
  const isNight = hour >= 23 || hour < 5;
  document.body.classList.toggle('night-mode', isNight);

  const greetingEl = document.getElementById('greeting');
  if (isNight && greetingEl) {
    const phrase = NIGHT_PHRASES[Math.floor(Math.random() * NIGHT_PHRASES.length)];
    greetingEl.innerHTML = `${phrase} <span class="weather-icon" id="weatherIcon"></span><span class="weather-temp" id="weatherTemp"></span>`;
  }
}

/**
 * Lunar Calendar Calculator
 * Simplified Chinese lunar calendar — no external dependencies
 */

function getLunarDateString() {
  if (typeof lunisolar === 'undefined') return '';
  try {
    const now = new Date();
    const ds = `${now.getFullYear()}/${now.getMonth()+1}/${now.getDate()}`;
    return lunisolar(ds).format('lY年 lMlD');
  } catch {
    return '';
  }
}

/**
 * getDateDisplay() — "2026年1月25日 星期四"
 */
function getDateDisplay() {
  const now = new Date();
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const gregorian = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const weekday = weekdays[now.getDay()];
  const lunar = getLunarDateString();
  return { gregorian, weekday, lunar };
}

/**
 * renderDateDisplay()
 *
 * Updates the date header with Gregorian, weekday, and lunar calendar info.
 */
function renderDateDisplay() {
  const dateEl = document.getElementById('dateDisplay');
  if (!dateEl) return;

  const { gregorian, weekday, lunar } = getDateDisplay();
  dateEl.innerHTML = `
    <span class="date-gregorian">${gregorian}</span>
    <span class="date-weekday">${weekday}</span>
    <span class="date-lunar">${lunar}</span>
  `;
}

const WEATHER_TYPES = {
  sunny:     [113],
  cloudy:    [116, 119, 122],
  foggy:     [143, 248, 260],
  rainy:     [176, 182, 185, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 317, 350, 353, 356, 359, 362, 365, 374, 377],
  snowy:     [179, 227, 230, 320, 323, 326, 329, 332, 335, 338, 368, 371, 395],
  thundery:  [200, 386, 389, 392],
};

function weatherCodeToType(code) {
  for (const [type, codes] of Object.entries(WEATHER_TYPES)) {
    if (codes.includes(code)) return type;
  }
  return 'cloudy';
}

function renderWeatherIcon(type) {
  const el = document.getElementById('weatherIcon');
  if (!el) return;
  // Build CSS-animated weather icon
  let inner = '';
  if (type === 'sunny') {
    inner = `<div class="wi-sun"><div class="wi-sun-ray"></div></div>`;
  } else if (type === 'cloudy') {
    inner = `<div class="wi-cloud"></div>`;
  } else if (type === 'foggy') {
    inner = `<div class="wi-fog"><div class="wi-fog-line"></div><div class="wi-fog-line"></div><div class="wi-fog-line"></div></div>`;
  } else if (type === 'rainy') {
    inner = `<div class="wi-rain">
      <div class="wi-cloud"></div>
      <div class="wi-drop"></div><div class="wi-drop"></div><div class="wi-drop"></div>
    </div>`;
  } else if (type === 'snowy') {
    inner = `<div class="wi-snow">
      <div class="wi-cloud"></div>
      <div class="wi-flake"></div><div class="wi-flake"></div><div class="wi-flake"></div>
    </div>`;
  } else if (type === 'thundery') {
    inner = `<div class="wi-thunder">
      <div class="wi-cloud"></div>
      <div class="wi-bolt"></div>
    </div>`;
  }
  el.innerHTML = inner;
}

async function updateWeather() {
  const iconEl = document.getElementById('weatherIcon');
  const tempEl = document.getElementById('weatherTemp');
  if (!iconEl || !tempEl) return;

  // Try multiple weather endpoints
  const urls = [
    'https://wttr.in/Shanghai?format=j1&lang=zh',
    'https://wttr.in/上海?format=j1&lang=zh',
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      const c = data.current_condition[0];
      if (!c) continue;
      const code = parseInt(c.weatherCode);
      const loc = (data.nearest_area?.[0]?.areaName?.[0]?.value) || '';
      renderWeatherIcon(weatherCodeToType(code));
      tempEl.textContent = `${c.temp_C}°`;
      iconEl.title = loc ? `${loc} · ${c.weatherDesc[0].value}` : c.weatherDesc[0].value;
      return; // success
    } catch {}
  }

  // All endpoints failed
  iconEl.style.display = 'none';
  tempEl.style.display = 'none';
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   FAVICON — 多 CDN 缓存
   ---------------------------------------------------------------- */

const faviconCache = new Map(); // domain -> data URL or verified URL string
const FAVICON_CDNS = [
  (d) => `https://www.google.com/s2/favicons?domain=${d}&sz=16`,
  (d) => `https://icons.duckduckgo.com/ip3/${d}.ico`,
  (d) => `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://www.google.com/s2/favicons?domain=${d}&sz=16`)}`,
];

function getFaviconSrc(domain) {
  if (!domain) return '';
  if (faviconCache.has(domain)) return faviconCache.get(domain);
  return FAVICON_CDNS[0](domain);
}

function faviconOnError(img, domain) {
  // Try next CDN in chain
  const current = img.src;
  const cdnIndex = FAVICON_CDNS.findIndex(fn => fn(domain) === current);
  if (cdnIndex >= 0 && cdnIndex < FAVICON_CDNS.length - 1) {
    const nextUrl = FAVICON_CDNS[cdnIndex + 1](domain);
    faviconCache.set(domain, nextUrl);
    img.src = nextUrl;
  } else {
    // All CDNs failed — hide and cache empty
    faviconCache.set(domain, '');
    img.style.display = 'none';
  }
}


/* Global favicon retry: on image error, try next CDN */
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG' || !img.dataset.domain) return;
  const domain = img.dataset.domain;
  if (!domain) return;

  const current = img.src;
  if (current.includes('google.com/s2/favicons')) {
    const fallback = `https://icons.duckduckgo.com/ip3/${domain}.ico`;
    faviconCache.set(domain, fallback);
    img.src = fallback;
  } else if (current.includes('duckduckgo.com')) {
    // Both failed — hide
    faviconCache.set(domain, '');
    img.style.display = 'none';
  }
}, true);


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? getFaviconSrc(domain) : '';
    const lastAccessStr = tab.lastAccessed ? timeAgo(new Date(tab.lastAccessed).toISOString()) : '';
    const chipTitle = lastAccessStr ? `${safeTitle} · 上次访问 ${lastAccessStr}` : safeTitle;
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="${chipTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" data-domain="${domain}" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? getFaviconSrc(domain) : '';
    const lastAccessStr = tab.lastAccessed ? timeAgo(new Date(tab.lastAccessed).toISOString()) : '';
    const chipTitle = lastAccessStr ? `${safeTitle} · 上次访问 ${lastAccessStr}` : safeTitle;
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="${chipTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" data-domain="${domain}" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.classList.remove('has-data');
      return;
    }

    column.classList.add('has-data');

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.classList.remove('has-data');
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" data-domain="${domain}" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   RECENTLY CLOSED — Render Sidebar Section
   ---------------------------------------------------------------- */

async function renderRecentlyClosedColumn() {
  const column = document.getElementById('recentlyClosedColumn');
  const list   = document.getElementById('recentlyClosedList');
  const empty  = document.getElementById('recentlyClosedEmpty');
  const countEl = document.getElementById('recentlyClosedCount');
  const footer = document.getElementById('recentlyClosedFooter');
  if (!column) return;

  try {
    const history = await getClosedHistory();

    if (history.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';
    countEl.textContent = `${history.length}`;
    empty.style.display = 'none';
    footer.style.display = 'flex';

    list.innerHTML = history.map(item => {
      let domain = '';
      try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
      const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
      const ago = timeAgo(item.closedAt);
      const safeUrl = item.url.replace(/"/g, '&quot;');
      const safeTitle = (item.title || '').replace(/"/g, '&quot;');
      return `
        <div class="closed-item" data-closed-id="${item.id}">
          <img class="closed-item-favicon" src="${faviconUrl}" alt="" data-domain="${domain}" onerror="this.style.display='none'">
          <div class="closed-item-info">
            <a href="${safeUrl}" target="_blank" rel="noopener" class="closed-item-title" title="${safeTitle}">${item.title || item.url}</a>
            <div class="closed-item-time">${domain} · ${ago}</div>
          </div>
          <div class="closed-item-actions">
            <button class="closed-action" data-action="reopen-closed-tab" data-closed-id="${item.id}" title="Reopen">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
            </button>
            <button class="closed-action dismiss" data-action="dismiss-closed-tab" data-closed-id="${item.id}" title="Remove from history">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    console.warn('[tab-out] Could not load closed history:', err);
    column.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   TAB SEARCH
   ---------------------------------------------------------------- */

let currentSearchQuery = '';

function filterTabsBySearch(query) {
  const q = query.trim().toLowerCase();
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const cards = missionsEl.querySelectorAll('.mission-card');
  let visibleCount = 0;

  cards.forEach(card => {
    const chips = card.querySelectorAll('.page-chip[data-action="focus-tab"]');
    let hasVisibleChip = false;

    chips.forEach(chip => {
      const title = chip.querySelector('.chip-text');
      const titleText = (title ? title.textContent : '').toLowerCase();
      const chipUrl = (chip.dataset.tabUrl || '').toLowerCase();
      const chipTitle = (chip.dataset.tabTitle || chip.title || '').toLowerCase();
      const matches = !q || titleText.includes(q) || chipUrl.includes(q) || chipTitle.includes(q);
      chip.style.display = matches ? '' : 'none';
      if (matches) hasVisibleChip = true;
    });

    // Also check the domain/label
    const missionName = card.querySelector('.mission-name');
    const missionText = (missionName ? missionName.textContent : '').toLowerCase();
    const domainMatches = !q || missionText.includes(q);

    if (hasVisibleChip && domainMatches) {
      card.classList.remove('search-hidden');
      visibleCount++;
    } else {
      card.classList.add('search-hidden');
    }
  });

  // Show no results message
  let noResults = missionsEl.querySelector('.search-no-results');
  if (visibleCount === 0 && q.length > 0) {
    if (!noResults) {
      noResults = document.createElement('div');
      noResults.className = 'search-no-results';
      noResults.innerHTML = `<div class="search-no-results-title">No tabs found</div><div style="font-size:13px">Try a different search term</div>`;
      missionsEl.appendChild(noResults);
    }
    noResults.style.display = '';
  } else if (noResults) {
    noResults.style.display = 'none';
  }

  return visibleCount;
}

/* ----------------------------------------------------------------
   SEARCH ENGINE CONFIG
   ---------------------------------------------------------------- */

const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=', icon: 'G', color: '#4285F4' },
  bing:   { name: 'Bing',   url: 'https://www.bing.com/search?q=',   icon: 'B', color: '#008373' },
  baidu:  { name: '百度',  url: 'https://www.baidu.com/s?wd=',       icon: '度', color: '#2932E1' },
  xhsc:   { name: '小红书', url: 'https://www.xiaohongshu.com/search_result?keyword=%s&source=web_explore_feed', icon: '红', color: '#FF2442' },
};

let currentEngine = localStorage.getItem('tabout_search_engine') || 'google';

function switchEngine(engineKey) {
  currentEngine = engineKey;
  localStorage.setItem('tabout_search_engine', engineKey);
  const eng = SEARCH_ENGINES[engineKey];
  const iconEl = document.getElementById('engineIcon');
  if (iconEl) {
    iconEl.textContent = eng.icon;
    iconEl.style.background = eng.color;
  }
  document.querySelectorAll('.engine-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.engine === engineKey);
  });
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  if (greetingEl) {
    greetingEl.innerHTML = `${getGreeting()} <span class="weather-icon" id="weatherIcon"></span><span class="weather-temp" id="weatherTemp"></span>`;
  }
  renderDateDisplay();
  updateWeather();
  updateNightMode();
  updateClock();
  updateHealthReminders();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    // Sort by most recently accessed tab (across all tabs in the group)
    const aRecent = Math.max(...a.tabs.map(t => t.lastAccessed || 0));
    const bRecent = Math.max(...b.tabs.map(t => t.lastAccessed || 0));
    return bRecent - aRecent;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    const hotItems = await fetchHotSearch();
    const hotSearchHtml = hotItems.length > 0 ? renderHotSearchCard(hotItems) : '';
    openTabsMissionsEl.innerHTML = hotSearchHtml + domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();

  // --- Render "Recently Closed" column ---
  await renderRecentlyClosedColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
  // Re-apply search filter if user has typed something
  if (currentSearchQuery) filterTabsBySearch(currentSearchQuery);
}

/* ----------------------------------------------------------------
   BOOKMARKS
   ---------------------------------------------------------------- */

async function renderBookmarks() {
  const bookmarksEl = document.getElementById('bookmarksMissions');
  const countEl = document.getElementById('bookmarksSectionCount');
  if (!bookmarksEl) return;

  // Walk the bookmark tree, collecting folders with their bookmarks
  const tree = await chrome.bookmarks.getTree();
  const folders = [];

  function walk(nodes) {
    for (const node of nodes) {
      if (!node.children) continue;
      // Collect URL children of this folder
      const bms = node.children.filter(c => c.url);
      if (bms.length > 0 && node.title) {
        folders.push({
          title: node.title,
          bookmarks: bms.map(c => ({ title: c.title || c.url, url: c.url, dateAdded: c.dateAdded })),
        });
      }
      // Recurse into sub-folders
      walk(node.children);
    }
  }
  walk(tree);

  const totalBookmarks = folders.reduce((s, f) => s + f.bookmarks.length, 0);

  // Update the banner with bookmark stats
  const banner = document.getElementById('tabOutDupeBanner');
  const bannerIcon = banner?.querySelector('.tab-cleanup-icon');
  const bannerText = banner?.querySelector('.tab-cleanup-text');
  const bannerBtn = banner?.querySelector('.tab-cleanup-btn');
  if (banner) {
    // Save original banner content on first call
    if (!banner.dataset.origHtml) {
      banner.dataset.origHtml = bannerIcon.innerHTML;
      banner.dataset.origText = bannerText.innerHTML;
    }
    bannerIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" /></svg>`;
    bannerText.textContent = `${totalBookmarks} bookmarks in ${folders.length} folder${folders.length !== 1 ? 's' : ''}`;
    bannerBtn.style.display = 'none';
    banner.style.display = 'flex';
  }

  if (folders.length > 0) {
    countEl.innerHTML = `${folders.length} folder${folders.length !== 1 ? 's' : ''}`;
    bookmarksEl.innerHTML = folders.map(g => renderBookmarkCard(g)).join('');
    bookmarksEl.parentElement.style.display = 'block';
  } else {
    bookmarksEl.parentElement.style.display = 'none';
  }
}

function renderBookmarkBmChip(bm) {
  const label = bm.title;
  const safeUrl = bm.url.replace(/"/g, '&quot;');
  const safeTitle = label.replace(/"/g, '&quot;');
  let domain = '';
  try { domain = new URL(bm.url).hostname; } catch {}
  const faviconUrl = domain ? getFaviconSrc(domain) : '';
  return `<div class="page-chip clickable" data-action="open-bookmark" data-bm-url="${safeUrl}" title="${safeTitle}">
    ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" data-domain="${domain}" onerror="this.style.display='none'">` : ''}
    <span class="chip-text">${label}</span>
  </div>`;
}

function renderBookmarkCard(folder) {
  const bms = folder.bookmarks || [];
  const pageChips = bms.map(bm => renderBookmarkBmChip(bm)).join('');

  return `
    <div class="mission-card domain-card has-neutral-bar">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${folder.title}</span>
          <span class="open-tabs-badge">${bms.length} saved</span>
        </div>
        <div class="mission-pages">${pageChips}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${bms.length}</div>
        <div class="mission-page-label">bookmarks</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   BAIDU HOT SEARCH
   ---------------------------------------------------------------- */

let hotSearchCache = null;
let hotSearchFetching = false;
let hotSearchTimer = null;

async function fetchHotSearch(noCache = false) {
  if (!noCache && hotSearchCache) return hotSearchCache;
  if (hotSearchFetching) return hotSearchCache || [];

  hotSearchFetching = true;
  try {
    const resp = await fetch('https://top.baidu.com/board?tab=realtime');
    const html = await resp.text();

    // Try to extract JSON from <!--s-data:...--> comment
    const sDataMatch = html.match(/<!--s-data:({.*?})-->/);
    if (sDataMatch) {
      const data = JSON.parse(sDataMatch[1]);
      const items = data?.data?.cards?.[0]?.content || data?.data?.cards || [];
      if (items.length > 0) {
        const result = items.map((item, i) => ({
          rank: i + 1,
          title: item.title || item.query || item.word || '',
          heat: item.hotScore || item.heat || item.hot || '',
        })).filter(item => item.title).slice(0, 30);
        if (result.length > 0) {
          hotSearchCache = result;
          return result;
        }
      }
    }

    // Fallback: parse from script tag with window.__INITIAL_STATE__
    const initMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});/s);
    if (initMatch) {
      const data = JSON.parse(initMatch[1]);
      const cards = data?.seoResult?.cards || data?.cards || [];
      const items = cards[0]?.content || cards[0]?.list || [];
      const result = items.map((item, i) => ({
        rank: i + 1,
        title: item.title || item.word || item.query || '',
        heat: item.hotScore || item.heatScore || item.heat || '',
      })).filter(item => item.title).slice(0, 30);
      if (result.length > 0) { hotSearchCache = result; return result; }
    }

    // Fallback: parse from script tag with window.data
    const scriptMatch = html.match(/window\.data\s*=\s*({.*?});/s);
    if (scriptMatch) {
      const data = JSON.parse(scriptMatch[1]);
      const cards = data?.cards || [];
      const result = cards.flatMap(card =>
        (card.content || []).map((item, i) => ({
          rank: i + 1,
          title: item.title || item.query || '',
          heat: item.hotScore || item.heat || '',
        }))
      ).filter(item => item.title).slice(0, 30);
      if (result.length > 0) { hotSearchCache = result; return result; }
    }

    // Last resort: parse raw HTML for hot search items
    const titleMatches = html.matchAll(/class="title[^"]*"[^>]*>([^<]+)</g);
    const heatMatches = html.matchAll(/class="hot[^"]*"[^>]*>([^<]+)</g);
    const results = [];
    let idx = 0;
    for (const m of titleMatches) {
      results.push({
        rank: idx + 1,
        title: m[1].trim(),
        heat: '',
      });
      idx++;
    }
    if (results.length > 0) {
      // Try to fill in heat numbers
      let hidx = 0;
      for (const h of heatMatches) {
        if (results[hidx]) results[hidx].heat = h[1].trim();
        hidx++;
      }
      hotSearchCache = results;
      return results;
    }
  } catch (err) {
    console.warn('[tab-out] Hot search fetch failed:', err);
  } finally {
    hotSearchFetching = false;
  }

  // Fallback: return empty so card shows nothing
  return [];
}

async function updateHotSearchCard() {
  const items = await fetchHotSearch(true);
  if (items.length === 0) return;
  const card = document.querySelector('#openTabsMissions .mission-card .mission-name');
  if (!card || !card.textContent.includes('Baidu hot')) return;
  const cardEl = card.closest('.mission-card');
  if (!cardEl) return;
  cardEl.outerHTML = renderHotSearchCard(items);
}

function startHotSearchRefresh() {
  // Refresh every 10 minutes
  hotSearchTimer = setInterval(updateHotSearchCard, 10 * 60 * 1000);
}

function formatHeat(val) {
  if (!val) return '';
  const n = typeof val === 'string' ? parseFloat(val.replace(/[^0-9.]/g, '')) : val;
  if (isNaN(n)) return String(val);
  if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '万';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function renderHotSearchCard(items) {
  const chips = items.map(item => {
    const safeTitle = item.title.replace(/"/g, '&quot;');
    const heat = formatHeat(item.heat);
    return `
    <div class="page-chip hot-chip" data-action="search-hot" data-query="${safeTitle}">
      <span class="hot-rank">${item.rank}</span>
      <span class="chip-text">${safeTitle}</span>
      ${heat ? `<span class="hot-heat">${heat}</span>` : ''}
    </div>`;
  }).join('');

  return `
    <div class="mission-card domain-card has-neutral-bar">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">🔥 Baidu hot</span>
          <span class="open-tabs-badge">breaking news</span>
        </div>
        <div class="mission-pages">${chips}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${items.length}</div>
        <div class="mission-page-label">hot</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Open a bookmark ----
  if (action === 'open-bookmark') {
    const bmUrl = actionEl.dataset.bmUrl;
    if (bmUrl) window.open(bmUrl, '_blank');
    return;
  }

  // ---- Search hot topic with current search engine ----
  if (action === 'search-hot') {
    const query = actionEl.dataset.query;
    if (!query) return;
    const engine = SEARCH_ENGINES[currentEngine];
    const searchUrl = engine.url.includes('%s') ? engine.url.replace('%s', encodeURIComponent(query)) : engine.url + encodeURIComponent(query);
    window.open(searchUrl, '_blank');
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Record in closed history before closing
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await addToClosedHistory({ url: match.url, title: match.title });

    // Close the tab in Chrome directly
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();
    await renderRecentlyClosedColumn();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    if (currentSearchQuery) setTimeout(() => filterTabsBySearch(currentSearchQuery), 250);
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    // Record all tabs in this group before closing
    for (const t of group.tabs) await addToClosedHistory(t);

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);
    await renderRecentlyClosedColumn();

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const tabsToRecord = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'));
    for (const t of tabsToRecord) await addToClosedHistory(t);

    const allUrls = tabsToRecord.map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }

  // ---- Reopen a recently closed tab ----
  if (action === 'reopen-closed-tab') {
    const id = actionEl.dataset.closedId;
    if (id) await reopenClosedTab(id);
    return;
  }

  // ---- Remove a single item from closed history ----
  if (action === 'dismiss-closed-tab') {
    const id = actionEl.dataset.closedId;
    if (!id) return;
    await removeFromClosedHistory(id);
    renderRecentlyClosedColumn();
    return;
  }

  // ---- Clear entire closed history ----
  if (action === 'clear-closed-history') {
    await clearClosedHistory();
    renderRecentlyClosedColumn();
    showToast('Closed history cleared');
    return;
  }

  // ---- Clear search ----
  if (action === 'clear-search') {
    const input = document.getElementById('webSearchInput');
    if (input) { input.value = ''; input.dispatchEvent(new Event('input')); }
    return;
  }

  // ---- Calendar: toggle popup ----
  if (action === 'cal-toggle') {
    const popup = document.getElementById('calendarPopup');
    if (!popup) return;
    const isOpen = popup.style.display !== 'none';
    popup.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
      const rect = document.getElementById('dateDisplay').getBoundingClientRect();
      popup.style.left = rect.left + 'px';
      popup.style.top = (rect.bottom + 8) + 'px';
      calYear = new Date().getFullYear();
      calMonth = new Date().getMonth() + 1;
      renderCalendar(calYear, calMonth);
    }
    return;
  }

  // ---- Calendar: nav month ----
  if (action === 'cal-prev') {
    calMonth--; if (calMonth < 1) { calMonth = 12; calYear--; }
    renderCalendar(calYear, calMonth);
    return;
  }
  if (action === 'cal-next') {
    calMonth++; if (calMonth > 12) { calMonth = 1; calYear++; }
    renderCalendar(calYear, calMonth);
    return;
  }

  // ---- Calendar: jump to today ----
  if (action === 'cal-today') {
    calYear = new Date().getFullYear();
    calMonth = new Date().getMonth() + 1;
    renderCalendar(calYear, calMonth);
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});

// ---- Web search input — show/hide clear button ----
document.addEventListener('input', (e) => {
  if (e.target.id !== 'webSearchInput') return;
  const q = e.target.value;
  const clearBtn = document.getElementById('searchClear');
  if (clearBtn) clearBtn.style.display = q.length > 0 ? 'flex' : 'none';
});


/* ----------------------------------------------------------------
   MASCOT CLICK INTERACTION
   ---------------------------------------------------------------- */

const MASCOT_PHRASES = [
  'Tab Out! 🦀',
  '标签清清清~',
  'Ctrl+W 快捷关标签',
  '点我干嘛~',
  '休息一下 ☕',
  '今天也加油鸭',
  '嗯？',
  '爬呀爬~',
  '别关我...',
  '给我点赞！',
  '快去摸鱼 🐟',
  '刷新试试',
  '看什么看~',
  '我很可爱',
  '摸我一下',
];

function triggerMascotBubble() {
  const bubble = document.getElementById('mascotBubble');
  if (!bubble) return;

  const phrase = MASCOT_PHRASES[Math.floor(Math.random() * MASCOT_PHRASES.length)];
  bubble.textContent = phrase;
  bubble.classList.add('visible');

  setTimeout(() => {
    bubble.classList.remove('visible');
  }, 2500);
}

/* ---- Lottie animation init ---- */
const animContainer = document.getElementById('mascotAnimation');
let lottieAnim = null;
if (animContainer && typeof lottie !== 'undefined') {
  lottieAnim = lottie.loadAnimation({
    container: animContainer,
    renderer: 'svg',
    loop: true,
    autoplay: true,
    path: 'crab_walk.json',
  });
}

const mascotEl = document.getElementById('mascot');
if (mascotEl) {
  // Manual click
  mascotEl.addEventListener('click', (e) => {
    e.stopPropagation();
    triggerMascotBubble();
    // Play a bounce on the lottie container
    if (animContainer) {
      animContainer.style.transform = 'scale(0.85) rotate(-8deg)';
      animContainer.style.transition = 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)';
      setTimeout(() => {
        animContainer.style.transform = 'scale(1) rotate(0deg)';
      }, 150);
    }
  });

  // Auto bubble every 15–30 seconds
  function scheduleAutoBubble() {
    const delay = 15000 + Math.random() * 15000;
    setTimeout(() => {
      triggerMascotBubble();
      scheduleAutoBubble();
    }, delay);
  }
  scheduleAutoBubble();
}


/* ----------------------------------------------------------------
   FLOATING CALENDAR — click date to toggle
   ---------------------------------------------------------------- */

function renderCalendar(year, month) {
  const grid = document.getElementById('calGrid');
  const title = document.getElementById('calTitle');
  const footer = document.getElementById('calFooter');
  if (!grid || !title) return;

  const headerRight = document.querySelector('.header-left');
  const now = new Date();
  const today = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };

  // Set title
  title.textContent = `${year}年${month}月`;

  // First day of month (0=Sun, 1=Mon...), adjust so Mon=0
  const firstDow = new Date(year, month - 1, 1).getDay();
  const startCol = (firstDow + 6) % 7;  // Mon=0..Sun=6

  const daysInMonth = new Date(year, month, 0).getDate();
  const daysPrev = new Date(year, month - 1, 0).getDate();

  const totalWeeks = Math.ceil((startCol + daysInMonth) / 7);
  const rows = [];
  for (let i = 0; i < totalWeeks; i++) {
    for (let j = 0; j < 7; j++) {
      const cellIdx = i * 7 + j;
      const dayOffset = cellIdx - startCol;
      let day = dayOffset;
      let cellMonth = month;
      let cellYear = year;
      let cls = '';

      if (dayOffset < 0 || dayOffset >= daysInMonth) {
        rows.push('<div class="cal-cell"></div>');
        continue;
      } else {
        day = dayOffset + 1;
      }

      if (day === today.d && cellMonth === today.m && cellYear === today.y) cls += ' today';

      // Lunar date
      let lunarDay = '';
      if (typeof lunisolar !== 'undefined') {
        try {
          const ds = `${cellYear}/${cellMonth}/${day}`;
          const f = lunisolar(ds).format('lD');
          lunarDay = f === '初一' ? lunisolar(ds).format('lM月lD') : f;
        } catch {}
      }

      rows.push(`<div class="cal-cell${cls}">
        <div class="cal-day">${day}</div>
        <div class="cal-lunar">${lunarDay}</div>
      </div>`);
    }
  }

  grid.innerHTML = rows.join('');

  // Footer shows today's lunar date
  if (footer && typeof lunisolar !== 'undefined') {
    try {
      const ds = `${today.y}/${today.m}/${today.d}`;
      footer.textContent = `今天 ${lunisolar(ds).format('lY年 lMlD')}`;
    } catch {}
  }
}

// Calendar state
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth() + 1;

// Close calendar when clicking outside
document.addEventListener('click', (e) => {
  const popup = document.getElementById('calendarPopup');
  if (!popup || popup.style.display === 'none') return;
  if (!e.target.closest('.calendar-popup') && !e.target.closest('[data-action="cal-toggle"]')) {
    popup.style.display = 'none';
  }
});


/* ----------------------------------------------------------------
   CLOCK — live time display
   ---------------------------------------------------------------- */

function updateClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const blink = now.getSeconds() % 2 === 0 ? 'blink' : '';
  el.innerHTML = `${h}<span class="colon ${blink}">:</span>${m}<span class="colon ${blink}">:</span>${s}`;
}

function updateWorkProgress() {
  const fill = document.getElementById('workProgressFill');
  const label = document.getElementById('workProgressLabel');
  if (!fill || !label) return;

  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();

  const START = 9 * 60 + 30;  // 9:30
  const END   = 18 * 60 + 30; // 18:30
  const TOTAL = END - START;

  let progress;
  if (mins < START)      progress = 0;
  else if (mins > END)   progress = 1;
  else                   progress = (mins - START) / TOTAL;

  const pct = Math.round(progress * 100);
  fill.style.width = `${pct}%`;
  label.textContent = `${pct}%`;
}

setInterval(updateClock, 1000);
setInterval(updateWorkProgress, 10000);
updateWorkProgress();


/* ----------------------------------------------------------------
   HEALTH REMINDERS — 30-min cycle timer
   ---------------------------------------------------------------- */

const HEALTH_TIPS = [
  ['💧', '喝口水吧'],
  ['🧘', '站起来伸个懒腰'],
  ['👀', '看看窗外，休息眼睛'],
  ['🚶', '起来走一走'],
  ['🫁', '深呼吸三次'],
  ['💦', '该喝水了'],
  ['🌿', '活动一下筋骨'],
  ['☕', '起来倒杯水'],
  ['🌅', '看远处 20 秒'],
  ['🧎', '换个姿势坐'],
];

let lastReminderTime = null;  // timestamp of last reminder (persisted)
let healthTipIndex = 0;
let healthTipInterval = null;
let healthLog = [];

function addHealthLog(icon, text) {
  const now = new Date();
  const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  healthLog.unshift({ id: Date.now().toString(), time: t, icon, text, done: false });
}

function updateHealthReminders() {
  const timerEl = document.getElementById('healthTimer');
  const tipEl = document.getElementById('healthTip');
  if (!timerEl || !tipEl) return;
  if (!lastReminderTime) { timerEl.textContent = '0:00'; tipEl.textContent = ''; return; }

  const elapsed = Math.floor((Date.now() - lastReminderTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  const blink = secs % 2 === 0 ? 'blink' : '';
  timerEl.innerHTML = `${mins}<span class="colon ${blink}">:</span>${String(secs).padStart(2, '0')}`;

  // 30 minutes → fire next reminder
  if (mins >= 30) {
    const tip = HEALTH_TIPS[healthTipIndex % HEALTH_TIPS.length];
    healthTipIndex++;
    tipEl.textContent = `${tip[0]} ${tip[1]}`;
    addHealthLog(tip[0], tip[1]);
    lastReminderTime = Date.now();
    chrome.storage.local.set({ healthLastReminder: lastReminderTime, healthTipIndex, healthLog });
  } else {
    // Show latest unfinished reminder, or idle message
    const latest = healthLog.find(item => !item.done);
    if (latest) {
      tipEl.textContent = `${latest.icon} ${latest.text}`;
    } else if (tipEl.textContent === '') {
      const idle = ['✨ 活力满满', '💪 状态不错', '🌟 今天很棒', '☀️ 精神饱满', '🎯 专注中'];
      tipEl.textContent = idle[Math.floor(Math.random() * idle.length)];
    }
  }
}

function renderHealthPopup() {
  const list = document.getElementById('healthPopupList');
  if (!list) return;
  if (healthLog.length === 0) {
    list.innerHTML = '<div class="health-popup-empty">暂无记录</div>';
  } else {
    list.innerHTML = healthLog.map(item =>
      `<div class="health-popup-item${item.done ? ' done' : ''}">
        <input type="checkbox" class="health-checkbox" data-log-id="${item.id}" ${item.done ? 'checked' : ''}>
        <span class="health-popup-time">${item.time}</span>
        <span>${item.icon} ${item.text}</span>
      </div>`
    ).join('');
  }
}

// Click badge → toggle popup, checkbox toggle done, click outside → close
document.addEventListener('click', (e) => {
  const popup = document.getElementById('healthPopup');
  if (!popup) return;

  if (!e.target.closest('#healthBadge')) {
    popup.style.display = 'none';
    return;
  }

  // Checkbox toggle
  const cb = e.target.closest('.health-checkbox');
  if (cb) {
    const logItem = healthLog.find(item => item.id === cb.dataset.logId);
    if (logItem) {
      logItem.done = cb.checked;
      chrome.storage.local.set({ healthLog });
      // Update badge text immediately
      const tipEl = document.getElementById('healthTip');
      if (tipEl) {
        const pending = healthLog.find(item => !item.done);
        tipEl.textContent = pending ? `${pending.icon} ${pending.text}` : (['✨ 活力满满', '💪 状态不错', '🌟 今天很棒', '☀️ 精神饱满', '🎯 专注中'])[Math.floor(Math.random() * 5)];
      }
    }
    e.stopPropagation();
    return;
  }

  if (e.target.closest('.health-popup')) return;

  const isOpen = popup.style.display !== 'none';
  popup.style.display = isOpen ? 'none' : 'block';

  if (!isOpen) renderHealthPopup();
});

// Init health timer from storage (persists across refreshes, resets daily)
(async function initHealthTimer() {
  const data = await chrome.storage.local.get(['healthLastReminder', 'healthTipIndex', 'healthLog', 'healthLogDate']);
  const now = Date.now();
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const todayStr = `${today.getFullYear()}-${today.getMonth()+1}-${today.getDate()}`;

  if (data.healthTipIndex) healthTipIndex = data.healthTipIndex;

  // Load today's log or start fresh for new day
  if (data.healthLogDate === todayStr && Array.isArray(data.healthLog)) {
    healthLog = data.healthLog;
  } else {
    healthLog = [];
    await chrome.storage.local.set({ healthLog: [], healthLogDate: todayStr });
  }

  if (data.healthLastReminder && data.healthLastReminder >= todayStart) {
    lastReminderTime = data.healthLastReminder;
  } else {
    lastReminderTime = now;
    await chrome.storage.local.set({ healthLastReminder: now, healthTipIndex });
  }

  updateHealthReminders();
  healthTipInterval = setInterval(updateHealthReminders, 1000);
})();


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
// Prevent Chrome from restoring scroll position on rapid refresh
history.scrollRestoration = 'manual';
window.scrollTo(0, 0);

// Cross-tab state sync — when another tab changes storage, update this tab's UI
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  // Health reminders
  if (changes.healthLastReminder) lastReminderTime = changes.healthLastReminder.newValue;
  if (changes.healthTipIndex) healthTipIndex = changes.healthTipIndex.newValue;
  if (changes.healthLog) healthLog = changes.healthLog.newValue;
  if (changes.healthLastReminder || changes.healthTipIndex || changes.healthLog) {
    updateHealthReminders();
  }

  // Saved tabs column
  if (changes.deferred) renderDeferredColumn();

  // Recently closed sidebar
  if (changes.closedHistory) renderRecentlyClosedColumn();
});


// Section search: filter tabs
document.getElementById('sectionSearchInput')?.addEventListener('input', (e) => {
  currentSearchQuery = e.target.value;
  filterTabsBySearch(currentSearchQuery);
});

// Web search: Enter → search with selected engine
document.getElementById('webSearchInput')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (!q) return;
  const engine = SEARCH_ENGINES[currentEngine];
  const searchUrl = engine.url.includes('%s') ? engine.url.replace('%s', encodeURIComponent(q)) : engine.url + encodeURIComponent(q);
  window.open(searchUrl, '_blank');
  e.target.value = '';
});

// ---- Engine selector dropdown ----
const engineBtn = document.getElementById('engineSelectorBtn');
const engineDropdown = document.getElementById('engineDropdown');

if (engineBtn && engineDropdown) {
  engineBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    engineDropdown.style.display = engineDropdown.style.display === 'block' ? 'none' : 'block';
  });

  document.querySelectorAll('.engine-option').forEach(opt => {
    opt.addEventListener('click', () => {
      switchEngine(opt.dataset.engine);
      engineDropdown.style.display = 'none';
      document.getElementById('webSearchInput')?.focus();
    });
  });

  document.addEventListener('click', () => {
    engineDropdown.style.display = 'none';
  });
}

// Init engine selector
switchEngine(currentEngine);

// ---- View toggle: Tabs / Bookmarks ----
let currentView = 'tabs';

document.getElementById('viewToggle')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.view-toggle-btn');
  if (!btn) return;
  const view = btn.dataset.view;
  if (view === currentView) return;

  currentView = view;
  document.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));

  const tabsSection = document.getElementById('openTabsSection');
  const bookmarksSection = document.getElementById('bookmarksSection');
  const searchBar = document.getElementById('searchBar');

  if (view === 'tabs') {
    tabsSection.style.display = 'block';
    bookmarksSection.style.display = 'none';
    // Re-trigger fade-up animations
    tabsSection.classList.remove('animate');
    void tabsSection.offsetHeight;
    tabsSection.classList.add('animate');
    // Restore normal dupe banner
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner && banner.dataset.origHtml) {
      const iconEl = banner.querySelector('.tab-cleanup-icon');
      const textEl = banner.querySelector('.tab-cleanup-text');
      const btnEl = banner.querySelector('.tab-cleanup-btn');
      if (iconEl) iconEl.innerHTML = banner.dataset.origHtml;
      if (textEl) textEl.innerHTML = banner.dataset.origText;
      if (btnEl) btnEl.style.display = '';
    }
    checkTabOutDupes();
  } else {
    tabsSection.style.display = 'none';
    bookmarksSection.style.display = 'block';
    renderBookmarks();
  }
});

renderDashboard().then(() => {
  document.getElementById('openTabsSection')?.classList.add('animate');
  startHotSearchRefresh();
});
