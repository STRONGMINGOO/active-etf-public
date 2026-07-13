// Active ETF — dashboard v2 frontend
// Pure vanilla ES module; talks to /api/v2/* only.

import { createStaticDataClient } from "./static_data.js";
import {
  AGGREGATE_PROVIDER_ID,
  LINEUP_PAGE_SIZE,
  OVERVIEW_CACHE_TTL_MS,
  RECENT_PAGE_SIZE,
  RECENT_WINDOW_DEFAULT,
  state,
} from "./state.js";
import { changesRowsHtml, holdingsRowsHtml, manifestRowsHtml } from "./views/detail.js";
import { lineupRowsHtml } from "./views/overview.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const bind = (key, root = document) => root.querySelector(`[data-bind="${key}"]`);

const nf = new Intl.NumberFormat("ko-KR");
const nfc = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

const wt = (value) => `${Number(value || 0).toFixed(2)}%`;
const fmtMoney = (value) => nfc.format(Math.round(Number(value || 0)));
const STATIC_DATA_BASE = String(globalThis.ACTIVE_ETF_STATIC_DATA_BASE || "").replace(/\/+$/, "");

function isStaticMode() {
  return STATIC_DATA_BASE.length > 0;
}

// Korean unit formatter: 1,234억 / 1.23조 / 123.4만 — meant for AUM-style
// numbers where exact won is noise. Returns '-' for null/0 so missing-data
// cells stay distinguishable from genuine zero.
function fmtKrUnit(value) {
  if (value == null || value === "") return "-";
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "-";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}조`;
  if (abs >= 1e8) return `${sign}${nf.format(Math.round(abs / 1e8))}억`;
  if (abs >= 1e4) return `${sign}${nf.format(Math.round(abs / 1e4))}만`;
  return `${sign}${nf.format(Math.round(abs))}`;
}

// Favorites are per-PC: localStorage keeps reader PCs from racing the Owner
// snapshot writes, and each user gets their own picks.
const FAVORITES_KEY_PREFIX = "active-etf:favorites:";

function favoritesKey(pid) {
  return `${FAVORITES_KEY_PREFIX}${pid}`;
}
function readFavorites(pid) {
  if (!pid) return new Set();
  try {
    const raw = localStorage.getItem(favoritesKey(pid));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}
function writeFavorites(pid, set) {
  if (!pid) return;
  try {
    localStorage.setItem(favoritesKey(pid), JSON.stringify([...set]));
  } catch (err) {
    toast(`즐겨찾기 저장 실패: ${err.message}`, { error: true });
  }
}
function toggleFavorite(pid, ticker) {
  const set = readFavorites(pid);
  if (set.has(ticker)) set.delete(ticker);
  else set.add(ticker);
  writeFavorites(pid, set);
  return set;
}

function isAggregateMode() {
  return state.providerId === AGGREGATE_PROVIDER_ID;
}

function realProviderIds() {
  return (state.bootstrap?.providers || []).map((p) => p.provider_id);
}

function defaultRealProviderId() {
  return realProviderIds()[0] || "";
}

function providerLabel(pid) {
  if (pid === AGGREGATE_PROVIDER_ID) return "전체";
  const p = (state.bootstrap?.providers || []).find((x) => x.provider_id === pid);
  return p ? (p.brand_name || p.display_name || pid) : pid;
}

function readAllFavorites() {
  const out = new Map();
  for (const pid of realProviderIds()) out.set(pid, readFavorites(pid));
  return out;
}

// Same-document navigation keeps browser Back/Forward inside the dashboard.
// Query parameters are used instead of path segments so GitHub Pages keeps
// resolving the existing relative assets and static data directory unchanged.
const NAVIGATION_STATE_KEY = "activeEtfDashboard";
const NAVIGATION_VIEWS = new Set(["overview", "detail", "ops"]);
const DETAIL_SUBTABS = new Set(["holdings", "changes", "timeline", "manifest"]);
let navigationEpoch = 0;
let providerSwitchRequestId = 0;
let overviewLoadGeneration = 0;
let aggregateLoadGeneration = 0;

function beginNavigation() {
  navigationEpoch += 1;
  return navigationEpoch;
}

function navigationStateFromApp() {
  const nav = {
    [NAVIGATION_STATE_KEY]: true,
    providerId: state.providerId || state.bootstrap?.default_provider || "",
    view: state.view || "overview",
  };
  if (nav.view === "detail") {
    nav.ticker = state.detail.ticker || "";
    nav.subtab = state.subtab || "holdings";
  }
  return nav;
}

function navigationSignature(nav) {
  return [nav?.providerId || "", nav?.view || "overview", nav?.ticker || "", nav?.subtab || ""].join("|");
}

function navigationUrl(nav) {
  const url = new URL(window.location.href);
  url.searchParams.set("provider", nav.providerId);
  url.searchParams.set("view", nav.view);
  if (nav.view === "detail" && nav.ticker) url.searchParams.set("ticker", nav.ticker);
  else url.searchParams.delete("ticker");
  if (nav.view === "detail" && nav.subtab && nav.subtab !== "holdings") {
    url.searchParams.set("subtab", nav.subtab);
  } else {
    url.searchParams.delete("subtab");
  }
  url.hash = "";
  return `${url.pathname}${url.search}`;
}

function commitNavigation(mode = "push") {
  if (!window.history?.pushState) return;
  const nav = navigationStateFromApp();
  const current = window.history.state;
  if (mode === "push" && current?.[NAVIGATION_STATE_KEY]
      && navigationSignature(current) === navigationSignature(nav)) return;
  const method = mode === "replace" ? "replaceState" : "pushState";
  window.history[method](nav, "", navigationUrl(nav));
}

function navigationTargetFromLocation(historyState = null) {
  const params = new URL(window.location.href).searchParams;
  const saved = historyState?.[NAVIGATION_STATE_KEY] ? historyState : {};
  return {
    providerId: saved.providerId || params.get("provider") || "",
    view: saved.view || params.get("view") || "overview",
    ticker: saved.ticker || params.get("ticker") || "",
    subtab: saved.subtab || params.get("subtab") || "holdings",
  };
}

function normalizeNavigationTarget(raw = {}) {
  const providerIds = new Set([...realProviderIds(), AGGREGATE_PROVIDER_ID]);
  let providerId = providerIds.has(raw.providerId)
    ? raw.providerId
    : (state.bootstrap?.default_provider || realProviderIds()[0] || "");
  let view = NAVIGATION_VIEWS.has(raw.view) ? raw.view : "overview";
  if (isStaticMode() && view === "ops") view = "overview";
  if (providerId === AGGREGATE_PROVIDER_ID && view !== "overview") {
    providerId = defaultRealProviderId() || providerId;
  }
  return {
    providerId,
    view,
    ticker: String(raw.ticker || ""),
    subtab: DETAIL_SUBTABS.has(raw.subtab) ? raw.subtab : "holdings",
  };
}

// ---- api ------------------------------------------------------------------

async function apiGet(path) {
  const r = await fetch(path);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${path}: ${r.status}`);
  return body;
}
async function apiSend(path, method, payload) {
  const headers = { "Content-Type": "application/json" };
  if (state.bootstrap?.request_token) headers["X-Active-ETF-Request"] = state.bootstrap.request_token;
  const r = await fetch(path, {
    method,
    headers,
    body: JSON.stringify(payload || {}),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${path}: ${r.status}`);
  return body;
}
const apiPost = (path, payload) => apiSend(path, "POST", payload);
const apiPut = (path, payload) => apiSend(path, "PUT", payload);

const enc = encodeURIComponent;
const staticClient = createStaticDataClient({
  base: STATIC_DATA_BASE,
  recentWindowDefault: RECENT_WINDOW_DEFAULT,
});

function filterStaticChanges(rows, params = {}) {
  let result = Array.isArray(rows) ? rows.slice() : [];
  const dateFrom = String(params.from || "");
  const dateTo = String(params.to || "");
  const typeFilter = String(params.type || "all");
  const q = String(params.q || "").trim().toLowerCase();
  if (dateFrom) result = result.filter((r) => String(r.snapshot_date || "") >= dateFrom);
  if (dateTo) result = result.filter((r) => String(r.snapshot_date || "") <= dateTo);
  if (typeFilter && typeFilter !== "all") result = result.filter((r) => r.change_type === typeFilter);
  if (q) {
    result = result.filter((r) =>
      `${r.constituent_code || ""} ${r.constituent_name || ""}`.toLowerCase().includes(q)
    );
  }
  result.sort((a, b) => {
    const dateCompare = String(b.snapshot_date || "").localeCompare(String(a.snapshot_date || ""));
    if (dateCompare) return dateCompare;
    return Math.abs(Number(b.weight_delta || 0)) - Math.abs(Number(a.weight_delta || 0));
  });
  return result;
}

function groupStaticTimeline(ticker, params, changes) {
  const grouped = new Map();
  for (const row of changes) {
    const date = row.snapshot_date || "";
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(row);
  }
  return {
    ticker,
    from: params.from || "",
    to: params.to || "",
    type: params.type || "all",
    grouped: [...grouped.entries()]
      .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
      .map(([snapshot_date, items]) => ({ snapshot_date, items })),
  };
}

function staticReadOnlyError() {
  return new Error("공개용 정적판에서는 업데이트 기능을 사용할 수 없습니다.");
}

const v2 = {
  bootstrap: () => isStaticMode() ? staticClient.json("bootstrap.json") : apiGet("/api/v2/bootstrap"),
  overview: (pid, params) => {
    if (isStaticMode()) {
      return staticClient.overview(pid, params);
    }
    const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
    return apiGet(`/api/v2/providers/${enc(pid)}/overview${qs}`);
  },
  snapshot: (pid, ticker, date) => {
    if (isStaticMode()) {
      return staticClient.snapshot(pid, ticker, date);
    }
    const q = date ? `?date=${enc(date)}` : "";
    return apiGet(`/api/v2/providers/${enc(pid)}/etfs/${enc(ticker)}/snapshot${q}`);
  },
  dates: (pid, ticker) =>
    isStaticMode()
      ? staticClient.dates(pid, ticker)
      : apiGet(`/api/v2/providers/${enc(pid)}/etfs/${enc(ticker)}/dates`),
  changes: (pid, ticker, params) => {
    if (isStaticMode()) {
      return staticClient.changes(pid, ticker).then((changes) => ({
        ticker,
        from: params.from || "",
        to: params.to || "",
        type: params.type || "all",
        q: params.q || "",
        changes: filterStaticChanges(changes, params),
      }));
    }
    const qs = new URLSearchParams(params).toString();
    return apiGet(`/api/v2/providers/${enc(pid)}/etfs/${enc(ticker)}/changes?${qs}`);
  },
  timeline: (pid, ticker, params) => {
    if (isStaticMode()) {
      return staticClient.changes(pid, ticker).then((changes) =>
        groupStaticTimeline(ticker, params, filterStaticChanges(changes, params))
      );
    }
    const qs = new URLSearchParams(params).toString();
    return apiGet(`/api/v2/providers/${enc(pid)}/etfs/${enc(ticker)}/timeline?${qs}`);
  },
  manifest: (pid, ticker) =>
    isStaticMode()
      ? staticClient.manifest(pid, ticker).then((manifest) => ({ ticker, manifest }))
      : apiGet(`/api/v2/providers/${enc(pid)}/etfs/${enc(ticker)}/manifest`),
  search: (pid, q, scope = "all") =>
    isStaticMode()
      ? staticClient.search(pid, q, scope)
      : apiGet(`/api/v2/providers/${enc(pid)}/search?q=${enc(q)}&scope=${enc(scope)}`),
  scheduler: (pid) => isStaticMode()
    ? Promise.resolve({
        running: false,
        is_owner: false,
        current_machine_allowed: false,
        current_machine: state.bootstrap?.current_machine || {},
        owner: null,
        settings: { enabled: false, update_time: "18:30", tickers: [], allowed_machine_ids: [], known_machines: {}, last_status: "read-only" },
        provider_id: pid,
      })
    : apiGet(`/api/v2/providers/${enc(pid)}/scheduler`),
  saveScheduler: (pid, settings) =>
    isStaticMode() ? Promise.reject(staticReadOnlyError()) : apiPut(`/api/v2/providers/${enc(pid)}/scheduler/settings`, settings),
  runScheduler: (pid) => isStaticMode() ? Promise.reject(staticReadOnlyError()) : apiPost(`/api/v2/providers/${enc(pid)}/scheduler/run`),
	  claimOwner: () => isStaticMode() ? Promise.reject(staticReadOnlyError()) : apiPost("/api/v2/operations/owner"),
	  exportSnapshot: (providers) => isStaticMode() ? Promise.reject(staticReadOnlyError()) : apiPost("/api/v2/operations/export", { providers }),
	  importSnapshot: (providers) => isStaticMode() ? Promise.reject(staticReadOnlyError()) : apiPost("/api/v2/operations/import", { providers }),
	};

// ---- toast ----------------------------------------------------------------

let toastTimer = null;
function toast(message, { error = false } = {}) {
  const el = bind("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---- change-type helpers --------------------------------------------------

function changeClass(type) {
  if (type === "신규 편입" || type === "비중확대") return "positive";
  if (type === "편출" || type === "비중축소") return "negative";
  return "neutral";
}

// Effective row classification: prefer the shares-outstanding-normalized active
// signal when available, otherwise fall back to the raw weight-delta type.
function effectiveChangeType(row) {
  const ct = row.change_type;
  if (ct === "신규 편입" || ct === "편출") return ct;
  if (row.active_change_type === "active_buy") return "액티브 매수";
  if (row.active_change_type === "active_sell") return "액티브 매도";
  return ct;   // raw 비중확대/축소 (drift, pre-backfill, or other)
}

function effectiveChangeClass(row) {
  const eff = effectiveChangeType(row);
  if (eff === "신규 편입" || eff === "액티브 매수") return "positive";
  if (eff === "편출" || eff === "액티브 매도") return "negative";
  return "neutral";
}

const NON_COMMON_STOCK_CODES = new Set(["CASH", "KRW", "USD", "JPY", "CNY", "HKD", "EUR"]);
const NON_COMMON_STOCK_NAME_SUBSTRINGS = [
  "현금", "예금", "미수금", "미지급", "스왑",
  "채권", "국고", "국채", "통안", "회사채", "금융채", "산금채", "특수채",
  "전자단기사채", "단기사채", "기업어음", "(단)", "(CP)", "(CD)", "선물", "옵션", "위클리", "만기",
  "외국환포워드", "펀드",
];
const NON_COMMON_STOCK_NAME_KEYWORDS = [
  "SWAP", "TRS", "FLOAT", "FRN", "TREASURY", "BOND", "NOTE", "T-BILL",
  "BILL", "KTB", "KORGAS", "FUT", "FUTR", "FUTURE", "FUTURES", "IDX", "INDX",
  "CALL", "PUT", "INDEX", "FXFWD", "COMEX", "NYMX", "CBOT", "CBT",
  "RTS", "RIGHT", "RIGHTS", "WARRANT", "WARRANTS", "WTS",
  "ETF", "ETN", "FUND", "ISHARES", "PROSHARES", "PROSHRE", "SPDR",
  "DIREXION", "GLOBAL X", "ARK", "VANGUARD", "WISDOMTREE", "VANECK",
  "ULTRASHORT",
];
const NON_COMMON_STOCK_NAME_KEYWORD_PATTERNS = NON_COMMON_STOCK_NAME_KEYWORDS.map((keyword) => {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`);
});
const NON_COMMON_STOCK_PREFIXES = ["KODEX ", "TIGER ", "RISE ", "SOL ", "PLUS ", "ACE ", "TIME ", "TIMEFOLIO ", "KOACT "];
const NON_COMMON_STOCK_PATTERNS = [
  /\b[A-Z]{2,}\b.*\b\d+(?:\s+\d+\/\d+)?\s+\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\bT\s+\d+(?:\.\d+)?\s+\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\b[A-Z]{1,8}\s+(?:FLOAT\s+)?\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\bT\s+\d+(?:\s+\d+\/\d+)?\s+\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\bB\s+\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\b[A-Z]{1,8}\s+US\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s+[CP]\d/,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\s+[CP]\d/,
  /\bB\s+\d+(?:\.\d+)?\s+\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /20\d{6}-\d+-\d+\(단\)/,
  /\b[CP]\s*20\d{4}\b/,
  /\b[CP]\d{3,}\b/,
  /\bFUT\d{4,}\b/,
  /\bKR4[A-Z0-9]{9}\b/,
  /\bKR6[A-Z0-9]{9,}\b/,
  /\bKRZ[A-Z0-9]{9,}\b/,
  /\b(?:EFV|IGF|XLY|XLF|SCO|SLV)\s+US(?:\s+EQUITY)?\b/,
  /(?:[A-Z가-힣]+)\s*\d{1,4}-\d{1,4}(?:-\d{1,4})?\b/,
];
const NON_COMMON_STOCK_NAME_PATTERNS = [
  /(?:\d*우B?|우선주)(?:\(전환\))?$/,
  /PREF(?:ERRED)?(?:SHARES?)?$/,
  /STATE STREET.*\bSECT\b/,
  /(?:INVESCO\s+)?QQQ\s+TRUST/,
  /BLOOMBERG CRUDE OIL/,
  /SILVER TRUST/,
];

function isCommonStockConstituent(row) {
  const code = String(row?.constituent_code || "").trim().toUpperCase();
  const name = String(row?.constituent_name || "").trim().toUpperCase();
  if (!code && !name) return false;
  const combined = `${name} ${code}`.trim();
  if (NON_COMMON_STOCK_CODES.has(code)) return false;
  if (NON_COMMON_STOCK_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  if (NON_COMMON_STOCK_NAME_SUBSTRINGS.some((keyword) => combined.includes(keyword))) return false;
  if (NON_COMMON_STOCK_NAME_KEYWORD_PATTERNS.some((pattern) => pattern.test(name))) return false;
  if (NON_COMMON_STOCK_NAME_PATTERNS.some((pattern) => pattern.test(name.replace(/\s+/g, "")))) return false;
  if (NON_COMMON_STOCK_PATTERNS.some((pattern) => pattern.test(combined))) return false;
  return true;
}

function deltaClass(value) {
  const n = Number(value || 0);
  if (n > 0) return "delta-positive";
  if (n < 0) return "delta-negative";
  return "delta-neutral";
}

// ---- bootstrap & provider tabs --------------------------------------------

// Launch overlay — shown statically from HTML at page-parse time so a user sees
// _something_ instantly. We tear it down here once the first overview renders.
const launchOverlay = {
  el: () => document.querySelector("[data-launch-overlay]"),
  setStatus(text) { const el = document.querySelector("[data-launch-status]"); if (el) el.textContent = text; },
  setHint(text)   { const el = document.querySelector("[data-launch-hint]");   if (el) el.textContent = text; },
  showError(err) {
    const root = this.el(); if (!root) return;
    root.classList.add("error");
    this.setStatus("로딩 실패");
    this.setHint(err?.message || String(err) || "알 수 없는 오류");
    const retry = document.querySelector("[data-launch-retry]");
    if (retry) {
      retry.hidden = false;
      retry.onclick = () => location.reload();
    }
  },
  dismiss() {
    const root = this.el(); if (!root) return;
    root.classList.add("fade-out");
    setTimeout(() => root.remove(), 260);
  },
};

async function start() {
  try {
    launchOverlay.setStatus(isStaticMode() ? "공개 데이터 여는 중…" : "서버 연결 중…");
    state.bootstrap = await v2.bootstrap();
    const initialNavigation = normalizeNavigationTarget(navigationTargetFromLocation(window.history.state));
    state.providerId = initialNavigation.providerId;
    state.view = initialNavigation.view;
    state.subtab = initialNavigation.subtab;
    state.detail.ticker = initialNavigation.ticker;
    renderProviderTabs();
    renderViewTabs();
    renderOwnerBadge();
    applyStaticModeUi();
    wireGlobalControls();
    wireDetailControls();
    wireOpsControls();
    wireSubtabs();
    wireLineupSort();
    wireNavigationHistory();
    commitNavigation("replace");
    const providerName = providerLabel(state.providerId) || state.providerId || "기본 펀드";
    launchOverlay.setStatus(`${providerName} 데이터 불러오는 중…`);
    launchOverlay.setHint("ETF 수가 많은 펀드(TIGER 등)는 첫 로딩이 최대 1~2분 걸릴 수 있습니다.");
    await restoreNavigation(initialNavigation, { replace: true, forceProviderLoad: true });
    launchOverlay.dismiss();
  } catch (err) {
    launchOverlay.showError(err);
    toast(err.message, { error: true });
  }
}

function applyStaticModeUi() {
  if (!isStaticMode()) return;
  document.body.classList.add("static-mode");
	  $$("[data-format='xlsx']").forEach((btn) => { btn.hidden = true; });
	  $$("[data-view='ops']").forEach((btn) => { btn.hidden = true; });
	}

function renderProviderTabs() {
  const host = bind("provider_tabs");
  const tabs = [
    `<button class="aggregate-tab" data-pid="${AGGREGATE_PROVIDER_ID}" title="모든 브랜드의 ETF를 한 번에 모아보기">전체</button>`,
  ];
  tabs.push(...state.bootstrap.providers.map((p) =>
    `<button data-pid="${escape(p.provider_id)}">${escape(p.brand_name || p.display_name)}</button>`
  ));
  host.innerHTML = tabs.join("");
  $$("[data-pid]", host).forEach((btn) => {
    btn.setAttribute("aria-current", String(btn.dataset.pid === state.providerId));
    btn.classList.toggle("is-loading", btn.dataset.pid === state.loadingProvider);
    btn.onclick = () => { switchProvider(btn.dataset.pid).catch(() => {}); };
  });
  // 상단 메타 텍스트도 동기화 — 로딩 중이면 어느 provider인지 즉시 인지 가능.
  const metaEl = bind("bootstrap_meta");
  if (metaEl && state.loadingProvider) {
    const label = providerLabel(state.loadingProvider);
    metaEl.textContent = `${label} 데이터 불러오는 중…`;
  }
}

function renderViewTabs() {
  $$(".view-tab").forEach((btn) => {
    if (isStaticMode() && btn.dataset.view === "ops") {
      btn.hidden = true;
      return;
    }
    btn.setAttribute("aria-current", String(btn.dataset.view === state.view));
    btn.onclick = () => { switchView(btn.dataset.view).catch(() => {}); };
  });
  $$("[data-view-pane]").forEach((pane) => {
    pane.hidden = pane.dataset.viewPane !== state.view;
  });
}

function resetLineupVisible() {
  state.lineup.visible = LINEUP_PAGE_SIZE;
}

function overviewStatusData(pid, dataState, error = "") {
  return {
    lineup: [],
    etfSummaryRows: [],
    recent_changes_feed: [],
    recent_changes_window: state.recent.window,
    summary: {
      provider_id: pid,
      provider_label: providerLabel(pid),
      data_state: dataState,
      load_error: error,
      etf_count: 0,
      latest_snapshot_date: "-",
      snapshot_count: 0,
      change_row_count: 0,
    },
  };
}

async function switchView(view, { historyMode = "push", navEpoch = null } = {}) {
  if (view === state.view && historyMode === "push") return;
  const epoch = navEpoch ?? (historyMode === "none" ? navigationEpoch : beginNavigation());
  if (isStaticMode() && view === "ops") {
    state.view = "overview";
    renderViewTabs();
    toast("공개판은 읽기 전용입니다.");
    return;
  }
  // Detail and Ops are provider-scoped; in aggregate mode the user must pick a
  // real provider first. Auto-switch to the default provider rather than show
  // a broken pane.
  if ((view === "ops" || view === "detail") && isAggregateMode()) {
    const fallback = defaultRealProviderId();
    if (fallback) {
      await switchProvider(fallback, { historyMode: "none", navEpoch: epoch });
      if (epoch !== navigationEpoch) return;
      toast(`${providerLabel(fallback)} 펀드로 전환되었습니다.`);
    }
  }
  state.view = view;
  renderViewTabs();
  if (historyMode !== "none") commitNavigation(historyMode);
  if (view === "detail") refreshDetailPane();
  if (view === "ops") loadScheduler();
}

async function switchProvider(pid, { historyMode = "push", navEpoch = null, force = false } = {}) {
  const epoch = navEpoch ?? (historyMode === "none" ? navigationEpoch : beginNavigation());
  if (!pid) return;
  if (!force && pid === state.providerId && state.overview && !state.loadingProvider) {
    if (historyMode !== "none") commitNavigation(historyMode);
    return;
  }
  const previousPid = state.providerId;
  const requestId = ++providerSwitchRequestId;
  state.providerId = pid;
  state.loadingProvider = pid;   // 클릭한 탭에 spinner + topbar 상태 표시
  resetLineupVisible();
  resetLineupHoldingSearchResults();
  if (previousPid && previousPid !== pid) {
    state.detail.ticker = "";
    state.overview = overviewStatusData(pid, "loading");
    renderOverview();
    initDetailControls();
  }
  if (pid === AGGREGATE_PROVIDER_ID) {
    state.favorites = new Set();   // aggregate mode reads each provider's saved set directly
    renderProviderTabs();
    // Ops/Detail views don't have cross-provider semantics yet — snap back to
    // overview so the user lands on the place the aggregate mode actually fills.
    if (state.view !== "overview") {
      state.view = "overview";
      renderViewTabs();
    }
    if (historyMode !== "none") commitNavigation(historyMode);
    try {
      await loadAggregate();
    } finally {
      if (requestId === providerSwitchRequestId) {
        state.loadingProvider = null;
        renderProviderTabs();
      }
    }
    if (epoch === navigationEpoch && historyMode !== "none") commitNavigation("replace");
    if (epoch === navigationEpoch) queueLineupHoldingSearch({ immediate: true });
    return;
  }
  state.favorites = readFavorites(pid);
  renderProviderTabs();
  if (historyMode !== "none") commitNavigation(historyMode);
  try {
    // Only refresh the scheduler if the user is actually viewing it — every other
    // tab click would otherwise wait on an Ops-only network round trip.
    if (state.view === "ops") await Promise.all([loadOverview(), loadScheduler()]);
    else await loadOverview();
  } finally {
    if (requestId === providerSwitchRequestId) {
      state.loadingProvider = null;
      renderProviderTabs();
    }
  }
  if (epoch === navigationEpoch && historyMode !== "none") commitNavigation("replace");
  if (epoch === navigationEpoch) queueLineupHoldingSearch({ immediate: true });
}

async function restoreNavigation(rawTarget, { replace = false, forceProviderLoad = false } = {}) {
  const target = normalizeNavigationTarget(rawTarget);
  const epoch = beginNavigation();
  const providerChanged = target.providerId !== state.providerId;
  state.view = target.view;
  state.subtab = target.subtab;
  renderViewTabs();
  renderSubtabs();

  if (providerChanged || forceProviderLoad || !state.overview) {
    await switchProvider(target.providerId, {
      historyMode: "none",
      navEpoch: epoch,
      force: forceProviderLoad || !state.overview,
    });
    if (epoch !== navigationEpoch) return;
  }

  state.view = target.view;
  state.subtab = target.subtab;
  if (target.view === "detail") {
    const select = $("[data-control='etf']");
    const hasRequestedTicker = Boolean(target.ticker && select
      && Array.from(select.options).some((option) => option.value === target.ticker));
    if (hasRequestedTicker) {
      state.detail.ticker = target.ticker;
      select.value = target.ticker;
    } else if (select?.value) {
      state.detail.ticker = select.value;
    }
    await refreshDatesForTicker();
    if (epoch !== navigationEpoch) return;
  }

  renderViewTabs();
  switchSubtab(target.subtab, { historyMode: "none", navEpoch: epoch, refresh: false });
  if (target.view === "detail") await refreshDetailPane();
  else if (target.view === "ops" && !providerChanged) await loadScheduler();
  if (epoch !== navigationEpoch) return;
  if (replace) commitNavigation("replace");
}

function wireNavigationHistory() {
  window.addEventListener("popstate", (event) => {
    const target = navigationTargetFromLocation(event.state);
    restoreNavigation(target).catch((err) => toast(err.message, { error: true }));
  });
}

async function loadAggregate({ force = false } = {}) {
  const generation = ++aggregateLoadGeneration;
  const requestedPid = state.providerId;
  if (requestedPid !== AGGREGATE_PROVIDER_ID) return;
  const window = state.recent.window;
  const isCurrent = () => (
    generation === aggregateLoadGeneration
    && state.providerId === requestedPid
    && state.recent.window === window
  );
  if (!force) {
    const cached = state.aggregateCache;
    if (cached && cached.window === window && (Date.now() - cached.fetchedAt) < OVERVIEW_CACHE_TTL_MS) {
      if (!isCurrent()) return;
      state.recent.visible = RECENT_PAGE_SIZE;
      resetLineupVisible();
      state.aggregate = cached.data;
      state.overview = cached.data;
      renderOverview();
      return;
    }
  }
  try {
    state.recent.visible = RECENT_PAGE_SIZE;
    resetLineupVisible();
    const pids = realProviderIds();
    if (pids.length === 0) {
      if (!isCurrent()) return;
      state.aggregate = overviewStatusData(requestedPid, "ready");
      state.overview = state.aggregate;
      renderOverview();
      return;
    }
    // Reuse per-provider overview cache where possible — each entry in the aggregate
    // fan-out is just a per-provider overview call, so a fresh hit avoids the round trip.
    const overviews = await Promise.all(
      pids.map(async (pid) => {
        const key = `${pid}|${window}`;
        const cached = state.overviewCache.get(key);
        if (cached && (Date.now() - cached.fetchedAt) < OVERVIEW_CACHE_TTL_MS) {
          return { pid, data: cached.data, cacheKey: key, shouldCache: false };
        }
        const data = await v2.overview(pid, { window });
        return { pid, data, cacheKey: key, shouldCache: true };
      })
    );
    if (!isCurrent()) return;
    for (const result of overviews) {
      if (result.shouldCache) {
        state.overviewCache.set(result.cacheKey, { data: result.data, fetchedAt: Date.now() });
      }
    }
    const etfRows = [];
    const feedRows = [];
    let etfTotal = 0;
    let changeRowTotal = 0;
    let latestDate = "";
    let truncated = false;
    let rowCap = 0;
    for (const { pid, data } of overviews) {
      const summary = data.summary || {};
      etfTotal += summary.etf_count || 0;
      changeRowTotal += summary.change_row_count || 0;
      if ((summary.latest_snapshot_date || "") > latestDate) latestDate = summary.latest_snapshot_date || latestDate;
      truncated = truncated || !!data.recent_changes_truncated;
      rowCap = Math.max(rowCap, data.recent_changes_row_cap || 0);
      const label = providerLabel(pid);
      for (const r of (data.etfSummaryRows || [])) {
        etfRows.push({ ...r, provider_id: pid, provider_label: label });
      }
      const feedSource = data.recent_changes_feed || data.recent_changes_top || [];
      for (const r of feedSource) {
        feedRows.push({ ...r, provider_id: pid, provider_label: label });
      }
    }
    feedRows.sort((a, b) => (b.snapshot_date || "").localeCompare(a.snapshot_date || ""));
    const aggregateData = {
      lineup: etfRows,
      etfSummaryRows: etfRows,
      recent_changes_feed: feedRows,
      recent_changes_window: window,
      recent_changes_truncated: truncated,
      recent_changes_row_cap: rowCap,
      summary: {
        etf_count: etfTotal,
        latest_snapshot_date: latestDate || "-",
        snapshot_count: 0,
        change_row_count: changeRowTotal,
      },
    };
    if (!isCurrent()) return;
    state.aggregateCache = { data: aggregateData, fetchedAt: Date.now(), window };
    state.aggregate = aggregateData;
    state.overview = aggregateData;
    renderOverview();
    // Detail view is provider-scoped; we re-init the ETF dropdown when the user
    // clicks a row (switchProvider then runs initDetailControls in loadOverview).
  } catch (err) {
    if (!isCurrent()) return;
    const errorData = overviewStatusData(requestedPid, "load_error", err?.message || String(err));
    state.aggregate = errorData;
    state.overview = errorData;
    renderOverview();
    toast(err.message, { error: true });
    throw err;
  }
}

function renderOwnerBadge() {
  if (isStaticMode()) {
    const el = bind("owner_badge");
    el.className = "pill neutral";
    el.textContent = "공개 조회 전용";
    return;
  }
  const owner = state.bootstrap.owner;
  const current = state.bootstrap.current_machine;
  let label = "담당 PC 미지정";
  let cls = "pill warn";
  if (owner) {
    const isOwner = owner.machine_id && owner.machine_id === current.machine_id;
    label = isOwner ? "담당 PC" : "조회 PC";
    cls = isOwner ? "pill positive" : "pill neutral";
  }
  const el = bind("owner_badge");
  el.className = cls;
  el.textContent = label;
}

function overviewBuildMeta(summary = {}) {
  const staticMeta = state.bootstrap?.static_site || {};
  const version = staticMeta.build_version
    || state.bootstrap?.build_version
    || state.bootstrap?.app_version
    || "-";
  const generatedAt = staticMeta.generated_at
    || state.bootstrap?.generated_at
    || summary.generated_at
    || summary.latest_snapshot_date
    || "-";
  return {
    version,
    generatedAt: String(generatedAt).replace("T", " ").slice(0, 16),
  };
}

function overviewEmptyHtml() {
  const summary = state.overview?.summary || {};
  const dataState = summary.data_state || "not_generated";
  const { version, generatedAt } = overviewBuildMeta(summary);
  let title = "아직 ETF 데이터가 생성되지 않았습니다.";
  let detail = "Operations에서 업데이트 상태를 확인하고 데이터를 생성하세요.";
  if (dataState === "loading") {
    title = `${summary.provider_label || "펀드"} 데이터를 불러오는 중입니다.`;
    detail = "잠시만 기다려 주세요.";
  } else if (dataState === "load_error") {
    title = `${summary.provider_label || "펀드"} 데이터를 불러오지 못했습니다.`;
    detail = summary.load_error || "연결 상태를 확인한 뒤 다시 시도하세요.";
  } else if (dataState === "generated_empty") {
    title = "데이터 생성은 완료됐지만 ETF가 0건입니다.";
    detail = isStaticMode()
      ? "이번 공개 생성 결과가 정상 0건입니다. 다음 생성 뒤 다시 확인하세요."
      : "Operations에서 공급사 응답과 실행 결과를 확인하세요.";
  } else if (dataState === "ready") {
    title = "현재 표시할 ETF가 없습니다.";
    detail = "현재 선택 조건을 확인하세요.";
  } else if (isStaticMode()) {
    title = "이번 공개 스냅샷에는 ETF 데이터가 없습니다.";
    detail = "다음 공개 데이터 생성 뒤 다시 확인하세요.";
  } else if (!state.bootstrap?.owner) {
    detail = "먼저 Operations에서 이 PC를 담당 PC로 지정한 뒤 업데이트를 실행하세요.";
  }
  let action = "";
  if (dataState === "load_error") {
    action = '<button class="btn-ghost btn-sm" data-action="retry-overview">다시 시도</button>';
  } else if (dataState !== "loading" && !isStaticMode()) {
    action = '<button class="btn-ghost btn-sm" data-action="open-operations">Operations로 이동</button>';
  }
  return `<div class="empty-state">
    <strong>${escape(title)}</strong>
    <span>${escape(detail)}</span>
    <small>앱 ${escape(version)} · 생성 ${escape(generatedAt)}</small>
    ${action}
  </div>`;
}

function wireOverviewEmptyAction(root) {
  const operationsButton = root?.querySelector?.("[data-action='open-operations']");
  if (operationsButton) operationsButton.onclick = () => switchView("ops").catch(() => {});
  const retryButton = root?.querySelector?.("[data-action='retry-overview']");
  if (retryButton) {
    retryButton.onclick = () => {
      state.overview = overviewStatusData(state.providerId, "loading");
      renderOverview();
      switchProvider(state.providerId, {
        historyMode: "none",
        navEpoch: navigationEpoch,
        force: true,
      }).catch(() => {});
    };
  }
}

let lineupHoldingSearchTimer = null;

function normalizeLineupSearchQuery(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}

function normalizeLineupSearchText(value) {
  return normalizeLineupSearchQuery(value).toLocaleLowerCase("ko-KR");
}

function lineupSearchKey(pid, ticker) {
  return `${pid || ""}::${ticker || ""}`;
}

function providerIdForLineupRow(row) {
  return isAggregateMode() ? row.provider_id : state.providerId;
}

function rowMatchesLineupProduct(row, query) {
  const needle = normalizeLineupSearchText(query);
  if (!needle) return true;
  return normalizeLineupSearchText(`${row?.name || ""} ${row?.ticker || ""}`).includes(needle);
}

function resetLineupHoldingSearchResults() {
  clearTimeout(lineupHoldingSearchTimer);
  state.lineup.holdingSearchRequestId += 1;
  state.lineup.holdingSearchMatches = new Set();
  state.lineup.holdingSearchLoading = Boolean(state.lineup.holdingQuery);
  state.lineup.holdingSearchError = "";
}

function lineupSearchProviderIds() {
  if (!isAggregateMode()) return state.providerId ? [state.providerId] : [];
  const represented = (state.overview?.etfSummaryRows || [])
    .map((row) => row.provider_id)
    .filter((pid) => pid && pid !== AGGREGATE_PROVIDER_ID);
  return [...new Set(represented)];
}

async function runLineupHoldingSearch(query, requestId) {
  const providerIds = lineupSearchProviderIds();
  if (providerIds.length === 0) {
    if (requestId !== state.lineup.holdingSearchRequestId) return;
    state.lineup.holdingSearchLoading = false;
    renderLineup();
    return;
  }
  const results = await Promise.allSettled(
    providerIds.map(async (pid) => ({ pid, response: await v2.search(pid, query, "holdings") }))
  );
  if (requestId !== state.lineup.holdingSearchRequestId
      || query !== normalizeLineupSearchQuery(state.lineup.holdingQuery)) return;
  const matches = new Set();
  let failures = 0;
  for (const result of results) {
    if (result.status !== "fulfilled") {
      failures += 1;
      continue;
    }
    const { pid, response } = result.value;
    for (const match of (response?.matches || [])) {
      matches.add(lineupSearchKey(response?.provider_id || pid, match?.ticker));
    }
  }
  state.lineup.holdingSearchMatches = matches;
  state.lineup.holdingSearchLoading = false;
  state.lineup.holdingSearchError = failures
    ? (failures === results.length ? "구성종목 검색에 실패했습니다." : "일부 펀드의 구성종목 검색에 실패했습니다.")
    : "";
  renderLineup();
}

function queueLineupHoldingSearch({ immediate = false } = {}) {
  clearTimeout(lineupHoldingSearchTimer);
  const query = normalizeLineupSearchQuery(state.lineup.holdingQuery);
  if (!query) {
    state.lineup.holdingSearchLoading = false;
    state.lineup.holdingSearchError = "";
    state.lineup.holdingSearchMatches = new Set();
    return;
  }
  const requestId = ++state.lineup.holdingSearchRequestId;
  state.lineup.holdingSearchLoading = true;
  const run = () => runLineupHoldingSearch(query, requestId).catch((err) => {
    if (requestId !== state.lineup.holdingSearchRequestId) return;
    state.lineup.holdingSearchLoading = false;
    state.lineup.holdingSearchError = err?.message || "구성종목 검색에 실패했습니다.";
    renderLineup();
  });
  if (immediate) run();
  else lineupHoldingSearchTimer = setTimeout(run, 220);
}

function wireLineupSearch() {
  const productInput = $("[data-control='lineup_product_search']");
  if (productInput) {
    productInput.value = state.lineup.productQuery;
    productInput.addEventListener("input", () => {
      state.lineup.productQuery = normalizeLineupSearchQuery(productInput.value);
      resetLineupVisible();
      renderLineup();
    });
  }

  const holdingInput = $("[data-control='lineup_holding_search']");
  if (holdingInput) {
    holdingInput.value = state.lineup.holdingQuery;
    holdingInput.addEventListener("input", () => {
      state.lineup.holdingQuery = normalizeLineupSearchQuery(holdingInput.value);
      resetLineupVisible();
      resetLineupHoldingSearchResults();
      renderLineup();
      queueLineupHoldingSearch();
    });
  }
}

function wireGlobalControls() {
  wireLineupSearch();
  const windowSelect = $("[data-control='recent_window']");
  if (windowSelect) {
    windowSelect.value = String(state.recent.window);
    windowSelect.addEventListener("change", async () => {
      const next = Number(windowSelect.value) || RECENT_WINDOW_DEFAULT;
      if (next === state.recent.window) return;
      state.recent.window = next;
      try {
        if (isAggregateMode()) await loadAggregate();
        else await loadOverview();
      } catch {
        // The loader has already rendered a truthful error state and toast.
      }
    });
  }
  const moreBtn = document.querySelector("[data-action='recent_changes_more']");
  if (moreBtn) {
    moreBtn.addEventListener("click", () => {
      state.recent.visible += RECENT_PAGE_SIZE;
      renderRecentChanges();
    });
  }
  const lineupFavToggle = $("[data-control='lineup_favorites_only']");
  if (lineupFavToggle) {
    lineupFavToggle.addEventListener("change", () => {
      state.lineup.favoritesOnly = lineupFavToggle.checked;
      resetLineupVisible();
      renderLineup();
    });
  }
  const lineupMoreBtn = document.querySelector("[data-action='lineup_more']");
  if (lineupMoreBtn) {
    lineupMoreBtn.addEventListener("click", () => {
      state.lineup.visible += LINEUP_PAGE_SIZE;
      renderLineup();
    });
  }
  const recentFavToggle = $("[data-control='recent_favorites_only']");
  if (recentFavToggle) {
    recentFavToggle.addEventListener("change", () => {
      state.recent.favoritesOnly = recentFavToggle.checked;
      state.recent.visible = RECENT_PAGE_SIZE;
      renderRecentChanges();
    });
  }
  // 유형 체크박스 — 4개 중 어떤 조합이든 자유롭게.
  $$("[data-signal-type]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const t = cb.dataset.signalType;
      if (cb.checked) state.recent.signalTypes.add(t);
      else state.recent.signalTypes.delete(t);
      state.recent.visible = RECENT_PAGE_SIZE;
      renderRecentChanges();
    });
  });
}

function wireSubtabs() {
  $$(".tab[data-subtab]").forEach((btn) => {
    btn.onclick = () => switchSubtab(btn.dataset.subtab);
  });
  renderSubtabs();
}

function renderSubtabs() {
  $$(".tab[data-subtab]").forEach((btn) => {
    btn.setAttribute("aria-current", String(btn.dataset.subtab === state.subtab));
  });
  $$("[data-subpane]").forEach((pane) => {
    pane.hidden = pane.dataset.subpane !== state.subtab;
  });
}

function switchSubtab(name, { historyMode = "push", navEpoch = null, refresh = true } = {}) {
  if (!DETAIL_SUBTABS.has(name)) name = "holdings";
  if (navEpoch == null && historyMode !== "none") beginNavigation();
  state.subtab = name;
  renderSubtabs();
  if (historyMode !== "none" && state.view === "detail") commitNavigation(historyMode);
  if (refresh) refreshDetailPane();
}

// ---- Overview view --------------------------------------------------------

async function loadOverview({ force = false } = {}) {
  const generation = ++overviewLoadGeneration;
  const pid = state.providerId;
  const window = state.recent.window;
  const cacheKey = `${pid}|${window}`;
  const isCurrent = () => (
    generation === overviewLoadGeneration
    && state.providerId === pid
    && state.recent.window === window
  );
  if (!force) {
    const cached = state.overviewCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < OVERVIEW_CACHE_TTL_MS) {
      if (!isCurrent()) return;
      state.recent.visible = RECENT_PAGE_SIZE;
      resetLineupVisible();
      state.overview = cached.data;
      renderOverview();
      initDetailControls();
      return;
    }
  }
  try {
    state.recent.visible = RECENT_PAGE_SIZE;
    resetLineupVisible();
    const data = await v2.overview(pid, { window });
    if (!isCurrent()) return;
    state.overviewCache.set(cacheKey, { data, fetchedAt: Date.now() });
    state.overview = data;
    renderOverview();
    initDetailControls();
  } catch (err) {
    if (!isCurrent()) return;
    state.overview = overviewStatusData(pid, "load_error", err?.message || String(err));
    renderOverview();
    initDetailControls();
    toast(err.message, { error: true });
    throw err;
  }
}

function renderOverview() {
  const o = state.overview;
  const summary = o.summary || {};
  const meta = bind("bootstrap_meta");
  const { version, generatedAt } = overviewBuildMeta(summary);
  meta.textContent = `${summary.etf_count || 0} ETFs · 기준 ${summary.latest_snapshot_date || "-"} · 앱 ${version} · 생성 ${generatedAt}`;

  const feedRowsRaw = o.recent_changes_feed || o.recent_changes_top || [];
  const feedRows = feedRowsRaw.filter(isCommonStockConstituent);
  const recentAdditions = feedRows.filter((r) => r.change_type === "신규 편입").length;
  const recentRemovals = feedRows.filter((r) => r.change_type === "편출").length;
  const recentActiveBuy = feedRows.filter((r) => r.active_change_type === "active_buy").length;
  const recentActiveSell = feedRows.filter((r) => r.active_change_type === "active_sell").length;
  const windowDays = o.recent_changes_window || state.recent.window;
  const windowLabel = `${windowDays}거래일`;
  const kpis = [
    { label: "ETF 수", value: nf.format(summary.etf_count || 0) },
    { label: "최신 기준일", value: summary.latest_snapshot_date || "-" },
    { label: `신규 편입 (${windowLabel})`, value: nf.format(recentAdditions) },
    { label: `편출 (${windowLabel})`, value: nf.format(recentRemovals) },
    { label: `액티브 매수 (${windowLabel})`, value: nf.format(recentActiveBuy) },
    { label: `액티브 매도 (${windowLabel})`, value: nf.format(recentActiveSell) },
  ];
  bind("overview_kpis").innerHTML = kpis.map((k) => (
    `<div class="kpi">
      <span class="kpi-label">${escape(k.label)}</span>
      <span class="kpi-value">${escape(k.value)}</span>
      ${k.sub ? `<span class="kpi-sub">${escape(k.sub)}</span>` : ""}
    </div>`
  )).join("");

  renderLineup();
  renderRecentChanges();
}

function isRowFavorite(row, aggregateFavorites = null) {
  if (isAggregateMode()) {
    return Boolean(aggregateFavorites?.get(row.provider_id)?.has(row.ticker));
  }
  return state.favorites.has(row.ticker);
}

function favoritePidForRow(row) {
  return isAggregateMode() ? row.provider_id : state.providerId;
}

function sortLineupRows(rows) {
  const { sortKey, sortDir } = state.lineup;
  if (!sortKey) return rows;
  const isNumeric = sortKey !== "name";
  const factor = sortDir === "desc" ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (isNumeric) {
      const an = av == null || Number.isNaN(Number(av)) ? null : Number(av);
      const bn = bv == null || Number.isNaN(Number(bv)) ? null : Number(bv);
      if (an == null && bn == null) return 0;
      if (an == null) return 1;            // missing → end regardless of direction
      if (bn == null) return -1;
      return (an - bn) * factor;
    }
    return String(av || "").localeCompare(String(bv || ""), "ko") * factor;
  });
}

function renderLineupSortIndicators() {
  document.querySelectorAll("th.sortable[data-sort-key]").forEach((th) => {
    const active = th.dataset.sortKey === state.lineup.sortKey;
    const indicator = th.querySelector(".sort-indicator");
    if (active) {
      th.setAttribute("aria-sort", state.lineup.sortDir === "desc" ? "descending" : "ascending");
      if (indicator) indicator.textContent = state.lineup.sortDir === "desc" ? "▼" : "▲";
    } else {
      th.removeAttribute("aria-sort");
      if (indicator) indicator.textContent = "";
    }
  });
}

function wireLineupSort() {
  document.querySelectorAll("th.sortable[data-sort-key]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      if (state.lineup.sortKey === key) {
        state.lineup.sortDir = state.lineup.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.lineup.sortKey = key;
        state.lineup.sortDir = key === "name" ? "asc" : "desc";
      }
      resetLineupVisible();
      renderLineup();
    });
  });
}

function renderLineup() {
  const o = state.overview;
  if (!o) return;
  const aggregate = isAggregateMode();
  const allRows = (o.etfSummaryRows || []);
  const favSet = state.favorites;
  const aggregateFavorites = aggregate ? readAllFavorites() : null;
  const rowIsFavorite = (row) => isRowFavorite(row, aggregateFavorites);
  const favoritesFiltered = state.lineup.favoritesOnly
    ? allRows.filter(rowIsFavorite)
    : allRows;
  const productQuery = normalizeLineupSearchQuery(state.lineup.productQuery);
  const holdingQuery = normalizeLineupSearchQuery(state.lineup.holdingQuery);
  const productFiltered = productQuery
    ? favoritesFiltered.filter((row) => rowMatchesLineupProduct(row, productQuery))
    : favoritesFiltered;
  const filtered = holdingQuery
    ? productFiltered.filter((row) => (
        state.lineup.holdingSearchMatches.has(lineupSearchKey(providerIdForLineupRow(row), row.ticker))
      ))
    : productFiltered;
  const rows = sortLineupRows(filtered);
  const visibleCount = Math.max(LINEUP_PAGE_SIZE, Math.min(state.lineup.visible, rows.length));
  const visibleRows = rows.slice(0, visibleCount);
  const overviewDataState = o.summary?.data_state || "";

  bind("lineup_count").textContent = rows.length > visibleRows.length
    ? `${nf.format(visibleRows.length)} / ${nf.format(rows.length)}`
    : nf.format(rows.length);
  const searchStatus = bind("lineup_search_status");
  if (searchStatus) {
    searchStatus.classList.toggle(
      "error",
      Boolean(state.lineup.holdingSearchError) || overviewDataState === "load_error",
    );
    if (overviewDataState === "loading") {
      searchStatus.textContent = "데이터를 불러오는 중입니다.";
    } else if (overviewDataState === "load_error") {
      searchStatus.textContent = "데이터를 불러오지 못해 검색할 수 없습니다.";
    } else if (!productQuery && !holdingQuery) {
      searchStatus.textContent = "상품명·코드와 최신 구성종목을 각각 검색할 수 있습니다.";
    } else if (state.lineup.holdingSearchLoading) {
      searchStatus.textContent = `${nf.format(rows.length)}건 · 최신 구성종목 검색 중…`;
    } else if (state.lineup.holdingSearchError) {
      searchStatus.textContent = `${nf.format(rows.length)}건 · ${state.lineup.holdingSearchError}`;
    } else if (productQuery && holdingQuery) {
      searchStatus.textContent = `${nf.format(rows.length)}건 · 두 조건을 모두 만족`;
    } else if (productQuery) {
      searchStatus.textContent = `${nf.format(rows.length)}건 · 상품명·코드 검색 결과`;
    } else {
      searchStatus.textContent = `${nf.format(rows.length)}건 · 구성종목 검색 결과`;
    }
  }
  const favCountEl = bind("favorites_count");
  if (favCountEl) {
    const total = aggregate
      ? [...readAllFavorites().values()].reduce((sum, s) => sum + s.size, 0)
      : favSet.size;
    favCountEl.textContent = `★ ${nf.format(total)}`;
  }

  const lineupToggle = $("[data-control='lineup_favorites_only']");
  const lineupToggleLabel = lineupToggle?.closest("label");
  if (lineupToggle) lineupToggle.checked = state.lineup.favoritesOnly;
  if (lineupToggleLabel) lineupToggleLabel.hidden = false;

  const lineupProviderTh = document.querySelector("[data-bind-th='lineup_provider']");
  if (lineupProviderTh) lineupProviderTh.hidden = !aggregate;

  const body = bind("lineup_body");
  const colspan = aggregate ? 10 : 9;
  let emptyMsg;
  if (overviewDataState === "loading" || overviewDataState === "load_error") {
    emptyMsg = overviewEmptyHtml();
  } else if (productQuery || holdingQuery) {
    if (state.lineup.holdingSearchLoading) {
      emptyMsg = "구성종목을 검색 중입니다.";
    } else if (productQuery && holdingQuery) {
      emptyMsg = `“${escape(productQuery)}” 상품명·코드 및 “${escape(holdingQuery)}” 구성종목 조건을 모두 만족하는 ETF가 없습니다.`;
    } else if (productQuery) {
      emptyMsg = `“${escape(productQuery)}” 상품명·코드 검색 결과가 없습니다.`;
    } else {
      emptyMsg = `“${escape(holdingQuery)}” 구성종목 검색 결과가 없습니다.`;
    }
  } else {
    emptyMsg = state.lineup.favoritesOnly ? "관심 ETF 없음 — 별을 눌러 추가하세요" : overviewEmptyHtml();
  }
  body.innerHTML = rows.length === 0
    ? `<tr><td colspan="${colspan}" class="empty">${emptyMsg}</td></tr>`
    : lineupRowsHtml({
        rows: visibleRows,
        aggregate,
        providerId: state.providerId,
        isRowFavorite: rowIsFavorite,
        favoritePidForRow,
        escape,
        nf,
        fmtKrUnit,
      });
  wireOverviewEmptyAction(body);

  const moreBtn = document.querySelector("[data-action='lineup_more']");
  if (moreBtn) {
    const remaining = Math.max(0, rows.length - visibleRows.length);
    const moreRow = moreBtn.closest("[data-role='lineup_more_row']");
    const showMore = remaining > 0;
    if (moreRow) moreRow.hidden = !showMore;
    moreBtn.hidden = !showMore;
    moreBtn.textContent = remaining > 0 ? `더보기 ${nf.format(remaining)}` : "더보기";
  }

  $$("[data-fav-ticker]", body).forEach((btn) => {
    btn.onclick = (event) => {
      event.stopPropagation();
      const pid = btn.dataset.favPid;
      if (!pid) return;
      toggleFavorite(pid, btn.dataset.favTicker);
      if (aggregate) {
        renderLineup();
        renderRecentChanges();
      } else {
        state.favorites = readFavorites(pid);
        renderLineup();
        renderRecentChanges();
      }
    };
  });

  $$("tr[data-row-ticker]", body).forEach((tr) => {
    const openDetail = async () => {
      const epoch = beginNavigation();
      const ticker = tr.dataset.rowTicker;
      const pid = tr.dataset.rowPid;
      if (aggregate && pid && pid !== state.providerId) {
        await switchProvider(pid, { historyMode: "none", navEpoch: epoch });
        if (epoch !== navigationEpoch) return;
      }
      state.detail.ticker = ticker;
      const select = $("[data-control='etf']");
      if (select) select.value = ticker;
      await refreshDatesForTicker();
      if (epoch !== navigationEpoch) return;
      await switchView("detail", { historyMode: "push", navEpoch: epoch });
      refreshDetailPane();
    };
    $$("td.clickable", tr).forEach((td) => {
      td.onclick = () => { openDetail().catch(() => {}); };
    });
  });

  renderLineupSortIndicators();
}

function renderRecentChanges() {
  const o = state.overview;
  if (!o) return;
  const feed = bind("recent_changes_feed");
  if (!feed) return;
  const aggregate = isAggregateMode();
  const items = o.recent_changes_feed || o.recent_changes_top || [];
  const favOnly = state.recent.favoritesOnly;
  const favSet = state.favorites;
  const aggregateFavorites = aggregate ? readAllFavorites() : null;
  const commonStockFiltered = items.filter(isCommonStockConstituent);
  const favFiltered = favOnly
    ? commonStockFiltered.filter((row) => (
        aggregate
          ? Boolean(aggregateFavorites?.get(row.provider_id)?.has(row.ticker))
          : favSet.has(row.ticker)
      ))
    : commonStockFiltered;
  // Multi-select 체크박스 — 선택된 effectiveChangeType만 통과. 4개 모두 켜져 있으면
  // 사실상 "전체"와 동일하지만 비교 비용은 무시 가능.
  const allowedTypes = state.recent.signalTypes;
  const filtered = favFiltered.filter((r) => allowedTypes.has(effectiveChangeType(r)));
  // Server already orders by snapshot_date DESC; re-sort defensively so a future
  // server tweak doesn't silently scramble the date-order contract.
  const sorted = filtered.slice().sort((a, b) => (b.snapshot_date || "").localeCompare(a.snapshot_date || ""));
  const total = sorted.length;
  const visible = Math.min(state.recent.visible, total);
  const shown = sorted.slice(0, visible);

  const recentToggle = $("[data-control='recent_favorites_only']");
  const recentToggleLabel = recentToggle?.closest("label");
  if (recentToggle) recentToggle.checked = favOnly;
  if (recentToggleLabel) recentToggleLabel.hidden = false;

  const windowSelect = $("[data-control='recent_window']");
  if (windowSelect && Number(windowSelect.value) !== state.recent.window) {
    windowSelect.value = String(state.recent.window);
  }

  // 유형 체크박스 그룹은 DOM 상태를 state.recent.signalTypes에 맞춰 동기화 — 외부에서
  // signalTypes를 바꾼 경우(예: 향후 preset 버튼)에도 UI가 따라오도록.
  $$("[data-signal-type]").forEach((cb) => {
    const t = cb.dataset.signalType;
    cb.checked = state.recent.signalTypes.has(t);
  });

  const countEl = bind("recent_changes_count");
  if (countEl) countEl.textContent = nf.format(total);

  const noRecentMessage = o.summary?.data_state === "loading" || o.summary?.data_state === "load_error"
    ? overviewEmptyHtml()
    : (favOnly
        ? "관심 ETF의 최근 변화가 없습니다."
        : (Number(o.summary?.etf_count || 0) === 0
            ? overviewEmptyHtml()
            : `최근 ${state.recent.window}거래일에 편입·편출·액티브 매매 변화가 없습니다.`));
  feed.innerHTML = total === 0
    ? `<div class="empty">${noRecentMessage}</div>`
    : (() => {
        let prevDate = "";
        return shown.map((r) => {
          const providerTag = aggregate && r.provider_label
            ? `<span class="provider-badge sm">${escape(r.provider_label)}</span>`
            : "";
          const effType = effectiveChangeType(r);
          const effCls = effectiveChangeClass(r);
          const ratioTitle = r.active_signal_ratio != null
            ? `정규화 비율 ${(Number(r.active_signal_ratio) * 100).toFixed(1)}% (등락의 +5%/-5% 초과 시 액티브 시그널)`
            : "";
          // Weight delta in percentage points (server emits `weight` and `previous_weight`
          // already as percent values, so `weight_delta` is also in pp).
          const wDelta = r.weight_delta;
          const hasW = wDelta != null && !Number.isNaN(Number(wDelta));
          const wNum = hasW ? Number(wDelta) : 0;
          const sign = wNum > 0 ? "+" : "";
          const retPct = hasW ? `${sign}${wNum.toFixed(2)}%p` : "—";
          const retCls = hasW ? deltaClass(wNum) : "delta-neutral";
          const prevW = Number(r.previous_weight || 0).toFixed(2);
          const newW = Number(r.weight || 0).toFixed(2);
          // Divergence: active signal direction (shares-normalized) disagrees with
          // raw weight-delta sign — manager bought while weight fell, or sold while
          // weight rose (price drift overwhelmed the trade). Flag visually.
          const divergent = hasW && (
            (r.active_change_type === "active_buy" && wNum < 0) ||
            (r.active_change_type === "active_sell" && wNum > 0)
          );
          const divergeMark = divergent ? `<span class="diverge-mark" title="액티브 시그널 방향(${effType})과 비중 변화 부호 불일치 — 가격 변동으로 비중이 매니저 의도와 반대로 움직임">⚡</span>` : "";
          const retTitle = hasW
            ? `포트폴리오 비중 ${prevW}% → ${newW}% (Δ ${sign}${wNum.toFixed(2)}%p)${divergent ? "\n⚡ 액티브 시그널과 비중 변화 부호 불일치" : ""}`
            : "비중 변화 데이터 없음";

          // Date grouping: blank the date cell for consecutive rows with the same
          // snapshot_date so the eye reads dates as natural group boundaries.
          const dateText = (r.snapshot_date && r.snapshot_date !== prevDate) ? r.snapshot_date : "";
          if (dateText) prevDate = r.snapshot_date;
          const dateClass = dateText ? "date" : "date date-empty";

          return `
        <div class="feed-row signal-row${aggregate ? " with-provider" : ""}${divergent ? " divergent" : ""}">
          <span class="${dateClass}">${escape(dateText)}</span>
          ${providerTag}
          <span class="name">${escape(r.constituent_name || "-")} <span class="code">${escape(r.constituent_code || "")}</span></span>
          <span class="pill ${effCls}" title="${escape(ratioTitle)}">${escape(effType)}</span>
          <span class="etf-name" title="${escape(r.etf_name || "")} (${escape(r.ticker || "")})">${escape(r.etf_name || r.ticker || "")}</span>
          <strong class="${retCls}" title="${escape(retTitle)}">${retPct}${divergeMark}</strong>
        </div>`;
        }).join("");
      })();
  wireOverviewEmptyAction(feed);

  const moreBtn = document.querySelector("[data-action='recent_changes_more']");
  if (moreBtn) moreBtn.hidden = visible >= total;

  const statusEl = bind("recent_changes_status");
  if (statusEl) {
    const parts = [];
    if (total > 0) parts.push(`${nf.format(visible)} / ${nf.format(total)}`);
    if (o.recent_changes_truncated) parts.push(`서버 상한(${nf.format(o.recent_changes_row_cap || 0)}) 초과 — 기간을 좁히세요`);
    statusEl.textContent = parts.join(" · ");
  }
}

// ---- Detail view ----------------------------------------------------------

function initDetailControls() {
  const select = $("[data-control='etf']");
  const lineup = state.overview.lineup || [];
  if (lineup.length === 0) {
    select.innerHTML = `<option value="">(no ETFs)</option>`;
    state.detail.ticker = "";
    return;
  }
  if (!state.detail.ticker || !lineup.find((e) => e.ticker === state.detail.ticker)) {
    state.detail.ticker = lineup[0].ticker;
  }
  select.innerHTML = lineup.map((etf) =>
    `<option value="${escape(etf.ticker)}" ${etf.ticker === state.detail.ticker ? "selected" : ""}>${escape(etf.name)} (${escape(etf.ticker)})</option>`
  ).join("");
  refreshDatesForTicker();
}

async function availableDates(ticker) {
  // Lazy per-ticker fetch — overview no longer ships dateAvailability (그 한 필드가
  // TIGER overview를 4.6MB 무겁게 만들었음). 한 번 가져온 결과는 state.dateCache에
  // 보관해서 같은 (pid, ticker) 재방문은 즉시 응답.
  if (!ticker) return [];
  const pid = state.providerId;
  if (!pid || pid === AGGREGATE_PROVIDER_ID) return [];
  const key = `${pid}|${ticker}`;
  if (state.dateCache.has(key)) return state.dateCache.get(key);
  try {
    const resp = await v2.dates(pid, ticker);
    const dates = Array.isArray(resp?.dates) ? resp.dates : [];
    state.dateCache.set(key, dates);
    return dates;
  } catch (err) {
    toast(err.message, { error: true });
    return [];
  }
}

async function refreshDatesForTicker() {
  const pid = state.providerId;
  const ticker = state.detail.ticker;
  const dates = await availableDates(ticker);
  if (state.providerId !== pid || state.detail.ticker !== ticker) return false;
  const latest = dates[dates.length - 1] || "";
  const first = dates[0] || "";
  const setOptions = (el, selected) => {
    if (!el) return;
    el.innerHTML = dates.length === 0
      ? `<option value="">-</option>`
      : dates.map((d) => `<option value="${escape(d)}" ${d === selected ? "selected" : ""}>${escape(d)}</option>`).join("");
  };
  setOptions($("[data-control='date_single']"), latest);
  setOptions($("[data-control='date_from']"), first);
  setOptions($("[data-control='date_to']"), latest);
  state.detail.date_single = latest;
  state.detail.date_from = first;
  state.detail.date_to = latest;
  return true;
}

let qDebounceTimer = null;
let detailRefreshRequestId = 0;

function wireDetailControls() {
  const controls = [
    "etf", "mode", "date_single", "date_from", "date_to", "change_type",
  ];
  controls.forEach((name) => {
    const el = $(`[data-control='${name}']`);
    if (!el) return;
    el.addEventListener("change", async () => {
      if (name === "etf") {
        const epoch = beginNavigation();
        state.detail.ticker = el.value;
        await refreshDatesForTicker();
        if (epoch !== navigationEpoch) return;
        if (state.view === "detail") commitNavigation("replace");
      } else if (name === "mode") {
        state.detail.mode = el.value;
        applyModeVisibility();
      } else if (name === "change_type") {
        state.detail.type = el.value;
      } else {
        state.detail[name] = el.value;
      }
      refreshDetailPane();
    });
  });
  const qEl = $("[data-control='q']");
  if (qEl) {
    qEl.addEventListener("input", () => {
      state.detail.q = qEl.value;
      // Holdings filtering is purely client-side via matchQuery → cheap re-render, no fetch.
      if (state.subtab === "holdings") {
        if (state.detail.snapshot) renderHoldings(state.detail.snapshot);
        return;
      }
      // Changes / Timeline use q on the server → debounce keystrokes.
      clearTimeout(qDebounceTimer);
      qDebounceTimer = setTimeout(refreshDetailPane, 220);
    });
  }
  $$(".btn-ghost[data-export]").forEach((btn) => {
    btn.onclick = () => handleExport(btn.dataset.export, btn.dataset.format);
  });
  applyModeVisibility();
}

function applyModeVisibility() {
  $$("[data-when-mode]").forEach((el) => {
    el.hidden = el.dataset.whenMode !== state.detail.mode;
  });
}

async function refreshDetailPane() {
  if (state.view !== "detail") return;
  if (!state.detail.ticker) return;
  const requestId = ++detailRefreshRequestId;
  const pid = state.providerId;
  const ticker = state.detail.ticker;
  const subtab = state.subtab;
  const d = state.detail;
  const stillCurrent = () => (
    requestId === detailRefreshRequestId
    && state.view === "detail"
    && state.providerId === pid
    && state.detail.ticker === ticker
    && state.subtab === subtab
  );
  try {
    if (subtab === "holdings") {
      const date = d.mode === "single" ? d.date_single : d.date_to;
      const key = `${pid}|${ticker}|${date}`;
      if (d.snapshotKey !== key || !d.snapshot) {
        const snapshot = await v2.snapshot(pid, ticker, date);
        if (!stillCurrent()) return;
        d.snapshot = snapshot;
        d.snapshotKey = key;
      }
      if (!stillCurrent()) return;
      renderDetailKpis(d.snapshot);
      renderHoldings(d.snapshot);
    } else if (subtab === "changes") {
      const params = buildChangesParams();
      const key = `${pid}|${ticker}|${new URLSearchParams(params).toString()}`;
      if (d.changesKey !== key || !d.changes) {
        const changes = await v2.changes(pid, ticker, params);
        if (!stillCurrent()) return;
        d.changes = changes;
        d.changesKey = key;
      }
      if (!stillCurrent()) return;
      renderChanges(d.changes);
      // KPI strip uses snapshot data; populate lazily so we don't refetch when cached.
      const snapDate = params.to || d.date_single;
      const snapKey = `${pid}|${ticker}|${snapDate}`;
      if (d.snapshotKey !== snapKey || !d.snapshot) {
        const snapshot = await v2.snapshot(pid, ticker, snapDate);
        if (!stillCurrent()) return;
        d.snapshot = snapshot;
        d.snapshotKey = snapKey;
      }
      if (!stillCurrent()) return;
      renderDetailKpis(d.snapshot);
    } else if (subtab === "timeline") {
      const params = buildChangesParams();
      const key = `${pid}|${ticker}|${new URLSearchParams(params).toString()}`;
      if (d.timelineKey !== key || !d.timeline) {
        const timeline = await v2.timeline(pid, ticker, params);
        if (!stillCurrent()) return;
        d.timeline = timeline;
        d.timelineKey = key;
      }
      if (!stillCurrent()) return;
      renderTimeline(d.timeline);
    } else if (subtab === "manifest") {
      const key = `${pid}|${ticker}`;
      if (d.manifestKey !== key || !d.manifest) {
        const manifest = await v2.manifest(pid, ticker);
        if (!stillCurrent()) return;
        d.manifest = manifest;
        d.manifestKey = key;
      }
      if (!stillCurrent()) return;
      renderManifest(d.manifest);
    }
  } catch (err) {
    if (stillCurrent()) toast(err.message, { error: true });
  }
}

function buildChangesParams() {
  const d = state.detail;
  const params = {};
  if (d.mode === "single") {
    if (d.date_single) { params.from = d.date_single; params.to = d.date_single; }
  } else {
    if (d.date_from) params.from = d.date_from;
    if (d.date_to) params.to = d.date_to;
  }
  if (d.type && d.type !== "all") params.type = d.type;
  if (d.q) params.q = d.q;
  return params;
}

function renderDetailKpis(snapshot) {
  if (!snapshot) return;
  const k = snapshot.kpis || {};
  const top = k.top_holding;
  const cards = [
    { label: "기준일", value: k.snapshot_date || "-" },
    { label: "편입 종목 수", value: nf.format(k.holding_count || 0) },
    { label: "총 평가금액", value: fmtMoney(k.total_valuation) },
    { label: "총 비중", value: wt(k.total_weight) },
    { label: "최대 비중", value: top ? `${top.constituent_name} ${wt(top.weight)}` : "-" },
  ];
  bind("detail_kpis").innerHTML = cards.map((c) => (
    `<div class="kpi">
      <span class="kpi-label">${escape(c.label)}</span>
      <span class="kpi-value">${escape(c.value)}</span>
    </div>`
  )).join("");
}

function renderHoldings(snapshot) {
  if (!snapshot) return;
  const rows = (snapshot.holdings || []).filter((r) => matchQuery(r));
  bind("holdings_count").textContent = nf.format(rows.length);
  bind("holdings_body").innerHTML = rows.length === 0
    ? `<tr><td colspan="6" class="empty">No holdings</td></tr>`
    : holdingsRowsHtml({ rows, escape, nf, fmtMoney, wt });

  const tc = snapshot.top_changes || {};
  renderFeed(bind("top_additions"), tc.additions || [], "additions");
  renderFeed(bind("top_removals"), tc.removals || [], "removals");
  renderFeed(bind("top_weight_changes"), tc.weight_changes || [], "weight");
}

function matchQuery(row) {
  const q = (state.detail.q || "").trim().toLowerCase();
  if (!q) return true;
  return `${row.constituent_code || ""} ${row.constituent_name || ""}`.toLowerCase().includes(q);
}

function renderFeed(host, rows, kind) {
  if (!host) return;
  host.innerHTML = rows.length === 0
    ? `<div class="empty">No rows</div>`
    : rows.map((r) => `
        <div class="feed-row">
          <span class="pill ${changeClass(r.change_type)}">${escape(r.change_type || kind)}</span>
          <span class="name">${escape(r.constituent_name || "-")} <span class="code">${escape(r.constituent_code || "")}</span></span>
          <strong class="${deltaClass(r.weight_delta || r.weight)}">${wt(r.weight_delta ?? r.weight)}</strong>
        </div>`).join("");
}

function renderChanges(result) {
  const rows = result?.changes || [];
  bind("changes_count").textContent = nf.format(rows.length);
  bind("changes_body").innerHTML = rows.length === 0
    ? `<tr><td colspan="8" class="empty">No changes</td></tr>`
    : changesRowsHtml({ rows, escape, wt, changeClass, deltaClass });
}

function renderTimeline(result) {
  const groups = result?.grouped || [];
  const flatCount = groups.reduce((sum, g) => sum + g.items.length, 0);
  bind("timeline_count").textContent = nf.format(flatCount);
  bind("timeline_body").innerHTML = groups.length === 0
    ? `<div class="empty">No timeline rows</div>`
    : groups.map((g) => `
        <div class="timeline-group">
          <h4>${escape(g.snapshot_date)} · ${nf.format(g.items.length)} rows</h4>
          ${g.items.slice(0, 60).map((r) => `
            <div class="feed-row">
              <span class="pill ${changeClass(r.change_type)}">${escape(r.change_type)}</span>
              <span class="name">${escape(r.constituent_name || "-")} <span class="code">${escape(r.constituent_code || "")}</span></span>
              <strong class="${deltaClass(r.weight_delta)}">${wt(r.weight_delta)}</strong>
            </div>`).join("")}
        </div>`).join("");
}

function renderManifest(result) {
  const rows = result?.manifest || [];
  bind("manifest_body").innerHTML = rows.length === 0
    ? `<tr><td colspan="4" class="empty">No manifest</td></tr>`
    : manifestRowsHtml({ rows, escape, nf });
}

// ---- Exports (CSV / XLSX / copy) ------------------------------------------

function exportUrl(table, format) {
  const d = state.detail;
  const params = new URLSearchParams({
    provider: state.providerId,
    format,
    ticker: d.ticker,
    date_mode: d.mode === "single" ? "single-date" : "inclusive-range",
    selected_date: d.date_single,
    start_date: d.date_from,
    end_date: d.date_to,
    search: d.q,
    change_type: d.type,
    timeline_start_date: d.date_from,
    timeline_end_date: d.date_to,
    timeline_change_type: d.type,
  });
  return `/api/v2/exports/${encodeURIComponent(table)}?${params.toString()}`;
}

async function handleExport(table, format) {
  if (isStaticMode()) {
    await handleStaticExport(table, format);
    return;
  }
  if (format === "copy") {
    try {
      const r = await fetch(exportUrl(table, "csv"));
      if (!r.ok) throw new Error(`copy failed: ${r.status}`);
      const text = (await r.text()).replace(/^﻿/, "");
      await writeClipboard(text);
      toast("CSV가 클립보드에 복사되었습니다.");
    } catch (err) {
      toast(err.message, { error: true });
    }
    return;
  }
  const a = document.createElement("a");
  a.href = exportUrl(table, format);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(`${format.toUpperCase()} 다운로드 중`);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(headers, rows) {
  return "\ufeff" + [
    headers.map((h) => csvCell(h.label)).join(","),
    ...rows.map((row) => headers.map((h) => csvCell(row[h.key])).join(",")),
  ].join("\n");
}

function staticExportRows(table) {
  if (table === "holdings") {
    const rows = (state.detail.snapshot?.holdings || []).filter((r) => matchQuery(r));
    return {
      headers: [
        { key: "snapshot_date", label: "기준일" },
        { key: "constituent_name", label: "종목명" },
        { key: "constituent_code", label: "코드" },
        { key: "quantity", label: "수량" },
        { key: "valuation", label: "평가금액" },
        { key: "weight", label: "비중" },
      ],
      rows,
    };
  }
  if (table === "changes") {
    return {
      headers: [
        { key: "snapshot_date", label: "기준일" },
        { key: "previous_snapshot_date", label: "전일" },
        { key: "change_type", label: "유형" },
        { key: "constituent_name", label: "종목명" },
        { key: "constituent_code", label: "코드" },
        { key: "previous_weight", label: "전 비중" },
        { key: "weight", label: "비중" },
        { key: "weight_delta", label: "Δ" },
      ],
      rows: state.detail.changes?.changes || [],
    };
  }
  if (table === "timeline") {
    const rows = [];
    for (const group of state.detail.timeline?.grouped || []) {
      for (const item of group.items || []) rows.push(item);
    }
    return {
      headers: [
        { key: "snapshot_date", label: "기준일" },
        { key: "change_type", label: "유형" },
        { key: "constituent_name", label: "종목명" },
        { key: "constituent_code", label: "코드" },
        { key: "previous_weight", label: "전 비중" },
        { key: "weight", label: "비중" },
        { key: "weight_delta", label: "Δ" },
      ],
      rows,
    };
  }
  if (table === "manifest") {
    return {
      headers: [
        { key: "snapshot_date", label: "기준일" },
        { key: "manifest_status", label: "상태" },
        { key: "reason", label: "사유" },
        { key: "holding_count", label: "보유" },
      ],
      rows: state.detail.manifest?.manifest || [],
    };
  }
  return { headers: [], rows: [] };
}

async function handleStaticExport(table, format) {
  if (format === "xlsx") {
    toast("공개판은 CSV만 지원합니다.", { error: true });
    return;
  }
  const { headers, rows } = staticExportRows(table);
  const text = toCsv(headers, rows);
  if (format === "copy") {
    await writeClipboard(text.replace(/^\ufeff/, ""));
    toast("CSV가 클립보드에 복사되었습니다.");
    return;
  }
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const safeTicker = String(state.detail.ticker || "active-etf").replace(/[^\w.-]+/g, "_");
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeTicker}_${table}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("CSV 다운로드 중");
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

// ---- Operations view ------------------------------------------------------

async function loadScheduler() {
  try {
    state.scheduler = await v2.scheduler(state.providerId);
    renderOps();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function renderOps() {
  const s = state.scheduler;
  if (!s) return;
  const current = s.current_machine || state.bootstrap.current_machine || {};
  const owner = s.owner || state.bootstrap.owner || {};
  bind("ops_current_pc").textContent = current.label || "-";
  bind("ops_current_machine_id").textContent = current.machine_id || "-";
  bind("ops_owner_pc").textContent = owner.machine_name || "-";
  bind("ops_owner_machine_id").textContent = owner.machine_id || "-";
  bind("ops_snapshot_dir").textContent = state.bootstrap.snapshot_dir || "snapshot";

  const settings = s.settings || {};
  const allowed = new Set(settings.allowed_machine_ids || []);
  const selectedTickers = new Set(settings.tickers || []);
  const allTickers = selectedTickers.size === 0;

  $("[data-control='sched_enabled']").checked = !!settings.enabled;
  $("[data-control='sched_time']").value = settings.update_time || "18:30";
  $("[data-control='sched_current_allowed']").checked = allowed.has(current.machine_id);

  const tickerHost = bind("sched_ticker_list");
  const lineup = state.overview?.lineup || [];
  tickerHost.innerHTML = lineup.length === 0
    ? `<div class="empty">No ETFs</div>`
    : lineup.map((etf) => `
        <label>
          <input type="checkbox" data-sched-ticker="${escape(etf.ticker)}" ${allTickers || selectedTickers.has(etf.ticker) ? "checked" : ""}>
          <span>${escape(etf.name)}</span><code>${escape(etf.ticker)}</code>
        </label>`).join("");
  bind("sched_ticker_count").textContent = allTickers ? "all ETFs" : `${selectedTickers.size} selected`;

  const machines = Object.values(settings.known_machines || {});
  const machineHost = bind("sched_machine_list");
  machineHost.innerHTML = machines.length === 0
    ? `<div class="empty">No registered PCs</div>`
    : machines.map((m) => `
        <label>
          <input type="checkbox" data-sched-machine="${escape(m.machine_id)}" ${allowed.has(m.machine_id) ? "checked" : ""}>
          <span>${escape(m.label || m.machine_id)}</span>
        </label>`).join("");

  const mode = s.running ? "running" : settings.enabled ? "enabled" : "off";
  const authority = s.current_machine_allowed ? "allowed PC" : s.is_owner ? "owner blocked" : "reader";
  bind("ops_scheduler_status").textContent = `${mode} · ${authority}`;
  bind("ops_save_state").textContent = settings.last_status || "ready";
}

function collectSchedulerSettings() {
  const base = state.scheduler?.settings || {};
  let tickers = $$("[data-sched-ticker]:checked").map((el) => el.dataset.schedTicker);
  const machines = $$("[data-sched-machine]:checked").map((el) => el.dataset.schedMachine);
  const current = state.bootstrap.current_machine || {};
  const lineup = state.overview?.lineup || [];
  if ($("[data-control='sched_current_allowed']").checked && current.machine_id && !machines.includes(current.machine_id)) {
    machines.push(current.machine_id);
  }
  if (tickers.length === lineup.length) tickers = [];   // "all" sentinel
  return {
    ...base,
    enabled: $("[data-control='sched_enabled']").checked,
    update_time: $("[data-control='sched_time']").value || "18:30",
    tickers,
    allowed_machine_ids: machines,
  };
}

function wireOpsControls() {
  bind("toast")?.addEventListener("click", () => bind("toast").hidden = true);
  document.querySelector("[data-action='claim_owner']").onclick = async () => {
    bind("ops_save_state").textContent = "claiming";
    try {
      await v2.claimOwner();
      state.bootstrap = await v2.bootstrap();
      renderOwnerBadge();
      await loadScheduler();
      toast("이 PC가 Owner로 등록되었습니다.");
    } catch (err) { toast(err.message, { error: true }); }
  };
  document.querySelector("[data-action='export_snapshot']").onclick = async () => {
    bind("ops_snapshot_state").textContent = "exporting…";
    try {
      const providers = state.bootstrap.providers.map((p) => p.provider_id);
      await v2.exportSnapshot(providers);
      bind("ops_snapshot_state").textContent = "exported";
      toast("스냅샷 내보내기 완료.");
    } catch (err) {
      bind("ops_snapshot_state").textContent = "error";
      toast(err.message, { error: true });
    }
  };
  document.querySelector("[data-action='import_snapshot']").onclick = async () => {
    bind("ops_snapshot_state").textContent = "importing…";
    try {
      const providers = state.bootstrap.providers.map((p) => p.provider_id);
      await v2.importSnapshot(providers);
      bind("ops_snapshot_state").textContent = "imported";
      state.overviewCache.clear();
      state.aggregateCache = null;
      await loadOverview({ force: true });
      await loadScheduler();
      toast("스냅샷 가져오기 완료.");
    } catch (err) {
      bind("ops_snapshot_state").textContent = "error";
      toast(err.message, { error: true });
    }
  };
  document.querySelector("[data-action='save_scheduler']").onclick = async () => {
    bind("ops_save_state").textContent = "saving";
    try {
      const settings = collectSchedulerSettings();
      const response = await v2.saveScheduler(state.providerId, settings);
      state.scheduler = { ...(state.scheduler || {}), settings: response.settings };
      await loadScheduler();
      toast("스케줄러 설정 저장.");
    } catch (err) {
      bind("ops_save_state").textContent = "error";
      toast(err.message, { error: true });
    }
  };
  document.querySelector("[data-action='run_scheduler']").onclick = async () => {
    bind("ops_save_state").textContent = "starting";
    try {
      const settings = collectSchedulerSettings();
      await v2.saveScheduler(state.providerId, settings);
      const response = await v2.runScheduler(state.providerId);
      bind("ops_save_state").textContent = response.started ? "started" : "already running";
      await loadScheduler();
    } catch (err) {
      bind("ops_save_state").textContent = "error";
      toast(err.message, { error: true });
    }
  };
}

// ---- boot -----------------------------------------------------------------

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
