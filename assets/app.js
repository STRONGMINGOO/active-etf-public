// Active ETF — dashboard v2 frontend
// Pure vanilla ES module; talks to /api/v2/* only.

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

// ---- state ----------------------------------------------------------------

const RECENT_PAGE_SIZE = 20;
const RECENT_WINDOW_DEFAULT = 5;
const OVERVIEW_CACHE_TTL_MS = 60_000;   // tab-click cache: re-clicks within 60s reuse data

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

// Sentinel provider id for the cross-provider aggregate view. Real provider ids
// come from the bootstrap payload (timefolio/tiger/koact), so this prefix can't
// collide with a real id.
const AGGREGATE_PROVIDER_ID = "__favorites__";

function isAggregateMode() {
  return state.providerId === AGGREGATE_PROVIDER_ID;
}

function realProviderIds() {
  return (state.bootstrap?.providers || []).map((p) => p.provider_id);
}

function providerLabel(pid) {
  const p = (state.bootstrap?.providers || []).find((x) => x.provider_id === pid);
  return p ? (p.brand_name || p.display_name || pid) : pid;
}

function readAllFavorites() {
  const out = new Map();
  for (const pid of realProviderIds()) out.set(pid, readFavorites(pid));
  return out;
}

const state = {
  bootstrap: null,
  providerId: null,
  view: "overview",
  subtab: "holdings",
  overview: null,
  // Aggregate-mode payload: { etfSummaryRows: [...], recent_changes_feed: [...] }
  // — each row tagged with provider_id / provider_label. Built client-side from
  // all per-provider overviews.
  aggregate: null,
  recent: {
    window: RECENT_WINDOW_DEFAULT,
    visible: RECENT_PAGE_SIZE,
    favoritesOnly: false,
    // 자유 조합 체크박스: 4개 effectiveChangeType 값 중 선택된 것만 표시. 기본 = 모두 켜짐(= 전체).
    signalTypes: new Set(["신규 편입", "편출", "액티브 매수", "액티브 매도"]),
  },
  overviewCache: new Map(),   // key = `${pid}|${window}` → { data, fetchedAt }
  aggregateCache: null,       // { data, fetchedAt, window }
  loadingProvider: null,      // 진행 중인 fetch의 provider id — 탭 spinner + topbar 상태 표시용
  dateCache: new Map(),       // key = `${pid}|${ticker}` → string[]  — Detail view 진입 시 lazy fetch
  lineup: {
    favoritesOnly: false,
    sortKey: null,             // "name" | "nav_total" | "market_cap" | null
    sortDir: "asc",            // "asc" | "desc"
  },
  favorites: new Set(),
	  detail: {
	    ticker: "",
    mode: "single",            // "single" | "range"
    date_single: "",
    date_from: "",
    date_to: "",
    q: "",
    type: "all",
    snapshot: null,            // /etfs/{ticker}/snapshot
    snapshotKey: "",
    changes: null,             // /etfs/{ticker}/changes
    changesKey: "",
    timeline: null,            // /etfs/{ticker}/timeline
    timelineKey: "",
    manifest: null,            // /etfs/{ticker}/manifest
	    manifestKey: "",
	  },
	  marketFlow: {
	    date: "latest",
	    resolvedDate: null,
	    manualDate: false,
	    limit: 5,
	    direction: "sell",
	    data: null,
	    combined: null,
	    status: null,
	    scheduler: null,
	    loading: false,
	  },
	  scheduler: null,             // /providers/{pid}/scheduler
	};

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
const staticCache = new Map();

function staticPath(path) {
  return `${STATIC_DATA_BASE}/${String(path || "").replace(/^\/+/, "")}`;
}

async function staticJson(path) {
  const url = staticPath(path);
  if (staticCache.has(url)) return staticCache.get(url);
  const promise = fetch(url).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `${url}: ${r.status}`);
    return body;
  });
  staticCache.set(url, promise);
  return promise;
}

async function staticEtfData(pid, ticker) {
  return staticJson(`providers/${enc(pid)}/etfs/${enc(ticker)}.json`);
}

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
  bootstrap: () => isStaticMode() ? staticJson("bootstrap.json") : apiGet("/api/v2/bootstrap"),
  overview: (pid, params) => {
    if (isStaticMode()) {
      const window = Number(params?.window || RECENT_WINDOW_DEFAULT);
      return staticJson(`providers/${enc(pid)}/overview-${window}.json`);
    }
    const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
    return apiGet(`/api/v2/providers/${enc(pid)}/overview${qs}`);
  },
  snapshot: (pid, ticker, date) => {
    if (isStaticMode()) {
      return staticEtfData(pid, ticker).then((bundle) => {
        const latest = bundle.dates?.[bundle.dates.length - 1] || "";
        const selected = date || latest;
        return bundle.snapshots?.[selected] || bundle.snapshots?.[latest] || {
          ticker,
          snapshot_date: selected,
          kpis: {},
          holdings: [],
          top_changes: { additions: [], removals: [], weight_changes: [] },
        };
      });
    }
    const q = date ? `?date=${enc(date)}` : "";
    return apiGet(`/api/v2/providers/${enc(pid)}/etfs/${enc(ticker)}/snapshot${q}`);
  },
  dates: (pid, ticker) =>
    isStaticMode()
      ? staticEtfData(pid, ticker).then((bundle) => ({ dates: bundle.dates || [] }))
      : apiGet(`/api/v2/providers/${enc(pid)}/etfs/${enc(ticker)}/dates`),
  changes: (pid, ticker, params) => {
    if (isStaticMode()) {
      return staticEtfData(pid, ticker).then((bundle) => ({
        ticker,
        from: params.from || "",
        to: params.to || "",
        type: params.type || "all",
        q: params.q || "",
        changes: filterStaticChanges(bundle.changes || [], params),
      }));
    }
    const qs = new URLSearchParams(params).toString();
    return apiGet(`/api/v2/providers/${enc(pid)}/etfs/${enc(ticker)}/changes?${qs}`);
  },
  timeline: (pid, ticker, params) => {
    if (isStaticMode()) {
      return staticEtfData(pid, ticker).then((bundle) =>
        groupStaticTimeline(ticker, params, filterStaticChanges(bundle.changes || [], params))
      );
    }
    const qs = new URLSearchParams(params).toString();
    return apiGet(`/api/v2/providers/${enc(pid)}/etfs/${enc(ticker)}/timeline?${qs}`);
  },
  manifest: (pid, ticker) =>
    isStaticMode()
      ? staticEtfData(pid, ticker).then((bundle) => ({ ticker, manifest: bundle.manifest || [] }))
      : apiGet(`/api/v2/providers/${enc(pid)}/etfs/${enc(ticker)}/manifest`),
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
	  marketFlow: (params) => {
	    if (isStaticMode()) {
	      const direction = String(params?.direction || "sell") === "buy" ? "buy" : "sell";
	      return staticJson(`market/etf-retail-net-${direction}.json`).catch(() => ({
	        title: marketFlowTitle(direction),
	        trade_date: null,
	        limit: Number(params?.limit || 5),
	        direction,
	        status: "missing",
	        message: "정적판에 ETF 수급 캐시가 없습니다.",
	        rows: [],
	        text: "",
	      }));
	    }
	    const qs = new URLSearchParams(params || {}).toString();
	    return apiGet(`/api/v2/market/etf-retail-flow${qs ? `?${qs}` : ""}`);
	  },
	  refreshMarketFlow: (payload) =>
	    isStaticMode() ? Promise.reject(staticReadOnlyError()) : apiPost("/api/v2/market/etf-retail-flow/refresh", payload),
	  marketFlowCombined: (params) => {
	    if (isStaticMode()) {
	      return Promise.all([
	        staticJson("market/etf-retail-net-sell.json").catch(() => null),
	        staticJson("market/etf-retail-net-buy.json").catch(() => null),
	      ]).then(([sell, buy]) => ({
	        title: "일간 ETF 개인 순매도·순매수 상위(전일)",
	        trade_date: sell?.trade_date || buy?.trade_date || null,
	        sell,
	        buy,
	        text: [sell?.text || "", buy?.text || ""].filter((x) => x.trim()).join("\n\n"),
	      }));
	    }
	    const qs = new URLSearchParams(params || {}).toString();
	    return apiGet(`/api/v2/market/etf-retail-flow/combined${qs ? `?${qs}` : ""}`);
	  },
	  marketFlowStatus: () =>
	    isStaticMode() ? Promise.resolve({ running: false, job: { running: false, phase: "static" }, settings: {} }) : apiGet("/api/v2/market/etf-retail-flow/status"),
	  marketFlowScheduler: () =>
	    isStaticMode() ? Promise.resolve({ settings: { enabled: false, update_time: "18:30", allowed_machine_ids: [] }, status: {} }) : apiGet("/api/v2/market/etf-retail-flow/scheduler"),
	  saveMarketFlowScheduler: (settings) =>
	    isStaticMode() ? Promise.reject(staticReadOnlyError()) : apiPut("/api/v2/market/etf-retail-flow/scheduler", settings),
	};

// ---- toast ----------------------------------------------------------------

let toastTimer = null;
let marketFlowPollTimer = null;
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
const NON_COMMON_STOCK_KEYWORDS = [
  "현금", "예금", "미수금", "미지급", "스왑", "SWAP", "TRS",
  "채권", "국고", "국채", "통안", "회사채", "금융채", "산금채", "특수채",
  "전자단기사채", "단기사채", "기업어음", "(단)", "FLOAT", "FRN", "TREASURY", "BOND", "NOTE", "T-BILL",
  "BILL", "KTB", "KORGAS", "선물", "옵션", "위클리", "만기", "FUTR", "FUTURE", "FUTURES",
  "INDX", "CALL", "PUT", "INDEX", "외국환포워드", "FXFWD",
  "ETF", "ETN", "펀드", "FUND",
];
const NON_COMMON_STOCK_PREFIXES = ["KODEX ", "TIGER ", "RISE ", "SOL ", "PLUS ", "ACE ", "TIMEFOLIO ", "KOACT "];
const NON_COMMON_STOCK_PATTERNS = [
  /\b[A-Z]{2,}\b.*\b\d+(?:\s+\d+\/\d+)?\s+\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\bT\s+\d+(?:\.\d+)?\s+\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\b[A-Z]{1,8}\s+(?:FLOAT\s+)?\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\bT\s+\d+(?:\s+\d+\/\d+)?\s+\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\bB\s+\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\b[A-Z]{1,8}\s+US\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s+[CP]\d/,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\s+[CP]\d/,
  /20\d{6}-\d+-\d+\(단\)/,
  /\b[CP]\s*20\d{4}\b/,
  /\b[CP]\d{3,}\b/,
  /\bFUT\d{4,}\b/,
];

function isCommonStockConstituent(row) {
  const code = String(row?.constituent_code || "").trim().toUpperCase();
  const name = String(row?.constituent_name || "").trim().toUpperCase();
  if (!code && !name) return false;
  const combined = `${name} ${code}`.trim();
  if (NON_COMMON_STOCK_CODES.has(code)) return false;
  if (NON_COMMON_STOCK_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  if (NON_COMMON_STOCK_KEYWORDS.some((keyword) => combined.includes(keyword))) return false;
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
    state.providerId = state.bootstrap.default_provider;
    renderProviderTabs();
    renderViewTabs();
    renderOwnerBadge();
    applyStaticModeUi();
	    wireGlobalControls();
	    wireDetailControls();
	    wireMarketControls();
	    wireOpsControls();
    wireSubtabs();
    wireLineupSort();
    const providerName = providerLabel(state.providerId) || state.providerId || "기본 펀드";
    launchOverlay.setStatus(`${providerName} 데이터 불러오는 중…`);
    launchOverlay.setHint("ETF 수가 많은 펀드(TIGER 등)는 첫 로딩이 최대 1~2분 걸릴 수 있습니다.");
    await switchProvider(state.providerId);
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
	  $$("[data-action='market_flow_refresh']").forEach((btn) => { btn.hidden = true; });
	  document.querySelector(".market-scheduler-row")?.setAttribute("hidden", "");
	}

function renderProviderTabs() {
  const host = bind("provider_tabs");
  const tabs = state.bootstrap.providers.map((p) =>
    `<button data-pid="${escape(p.provider_id)}">${escape(p.brand_name || p.display_name)}</button>`
  );
  tabs.push(`<button class="favorites-tab" data-pid="${AGGREGATE_PROVIDER_ID}" title="모든 펀드의 관심 ETF 모아보기">★ 관심</button>`);
  host.innerHTML = tabs.join("");
  $$("[data-pid]", host).forEach((btn) => {
    btn.setAttribute("aria-current", String(btn.dataset.pid === state.providerId));
    btn.classList.toggle("is-loading", btn.dataset.pid === state.loadingProvider);
    btn.onclick = () => switchProvider(btn.dataset.pid);
  });
  // 상단 메타 텍스트도 동기화 — 로딩 중이면 어느 provider인지 즉시 인지 가능.
  const metaEl = bind("bootstrap_meta");
  if (metaEl && state.loadingProvider) {
    const label = state.loadingProvider === AGGREGATE_PROVIDER_ID ? "관심 ETF" : providerLabel(state.loadingProvider);
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
    btn.onclick = () => switchView(btn.dataset.view);
  });
  $$("[data-view-pane]").forEach((pane) => {
    pane.hidden = pane.dataset.viewPane !== state.view;
  });
}

async function switchView(view) {
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
    const fallback = state.bootstrap?.default_provider || realProviderIds()[0];
    if (fallback) {
      await switchProvider(fallback);
      toast(`${providerLabel(fallback)} 펀드로 전환되었습니다.`);
    }
  }
	  state.view = view;
	  renderViewTabs();
	  if (view === "market") {
	    loadMarketFlow();
	    loadMarketFlowScheduler();
	    pollMarketFlowStatus({ once: true });
	  }
	  if (view === "ops") loadScheduler();
	}

async function switchProvider(pid) {
  state.providerId = pid;
  state.loadingProvider = pid;   // 클릭한 탭에 spinner + topbar 상태 표시
  if (pid === AGGREGATE_PROVIDER_ID) {
    state.favorites = new Set();   // not meaningful in aggregate mode
    renderProviderTabs();
    // Ops/Detail views don't have cross-provider semantics yet — snap back to
    // overview so the user lands on the place the aggregate mode actually fills.
    if (state.view !== "overview") {
      state.view = "overview";
      renderViewTabs();
    }
    try {
      await loadAggregate();
    } finally {
      state.loadingProvider = null;
      renderProviderTabs();
    }
    return;
  }
  state.favorites = readFavorites(pid);
  renderProviderTabs();
  try {
    // Only refresh the scheduler if the user is actually viewing it — every other
    // tab click would otherwise wait on an Ops-only network round trip.
    if (state.view === "ops") await Promise.all([loadOverview(), loadScheduler()]);
    else await loadOverview();
  } finally {
    state.loadingProvider = null;
    renderProviderTabs();
  }
}

async function loadAggregate({ force = false } = {}) {
  const window = state.recent.window;
  if (!force) {
    const cached = state.aggregateCache;
    if (cached && cached.window === window && (Date.now() - cached.fetchedAt) < OVERVIEW_CACHE_TTL_MS) {
      state.recent.visible = RECENT_PAGE_SIZE;
      state.aggregate = cached.data;
      state.overview = cached.data;
      renderOverview();
      return;
    }
  }
  try {
    state.recent.visible = RECENT_PAGE_SIZE;
    const pids = realProviderIds();
    if (pids.length === 0) {
      state.aggregate = { etfSummaryRows: [], recent_changes_feed: [], summary: {} };
      renderOverview();
      return;
    }
    // Reuse per-provider overview cache where possible — each entry in the aggregate
    // fan-out is just a per-provider overview call, so a fresh hit avoids the round trip.
    const overviews = await Promise.all(
      pids.map(async (pid) => {
        const key = `${pid}|${window}`;
        const cached = state.overviewCache.get(key);
        if (cached && (Date.now() - cached.fetchedAt) < OVERVIEW_CACHE_TTL_MS) return { pid, data: cached.data };
        const data = await v2.overview(pid, { window });
        state.overviewCache.set(key, { data, fetchedAt: Date.now() });
        return { pid, data };
      })
    );
    const allFavs = readAllFavorites();
    const etfRows = [];
    const feedRows = [];
    let etfTotal = 0;
    let changeRowTotal = 0;
    let latestDate = "";
    let truncated = false;
    let rowCap = 0;
    for (const { pid, data } of overviews) {
      const favSet = allFavs.get(pid) || new Set();
      const summary = data.summary || {};
      etfTotal += summary.etf_count || 0;
      changeRowTotal += summary.change_row_count || 0;
      if ((summary.latest_snapshot_date || "") > latestDate) latestDate = summary.latest_snapshot_date || latestDate;
      truncated = truncated || !!data.recent_changes_truncated;
      rowCap = Math.max(rowCap, data.recent_changes_row_cap || 0);
      const label = providerLabel(pid);
      for (const r of (data.etfSummaryRows || [])) {
        if (favSet.has(r.ticker)) etfRows.push({ ...r, provider_id: pid, provider_label: label });
      }
      const feedSource = data.recent_changes_feed || data.recent_changes_top || [];
      for (const r of feedSource) {
        if (favSet.has(r.ticker)) feedRows.push({ ...r, provider_id: pid, provider_label: label });
      }
    }
    feedRows.sort((a, b) => (b.snapshot_date || "").localeCompare(a.snapshot_date || ""));
    state.aggregate = {
      etfSummaryRows: etfRows,
      recent_changes_feed: feedRows,
      recent_changes_window: state.recent.window,
      recent_changes_truncated: truncated,
      recent_changes_row_cap: rowCap,
      summary: {
        etf_count: etfTotal,
        latest_snapshot_date: latestDate || "-",
        snapshot_count: 0,
        change_row_count: changeRowTotal,
      },
    };
    state.aggregateCache = { data: state.aggregate, fetchedAt: Date.now(), window };
    state.overview = state.aggregate;
    renderOverview();
    // Detail view is provider-scoped; we re-init the ETF dropdown when the user
    // clicks a row (switchProvider then runs initDetailControls in loadOverview).
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function renderOwnerBadge() {
  if (isStaticMode()) {
    const el = bind("owner_badge");
    el.className = "pill neutral";
    el.textContent = "Public read-only";
    return;
  }
  const owner = state.bootstrap.owner;
  const current = state.bootstrap.current_machine;
  let label = "owner unset";
  let cls = "pill warn";
  if (owner) {
    const isOwner = owner.machine_id && owner.machine_id === current.machine_id;
    label = isOwner ? "Owner PC" : "Reader PC";
    cls = isOwner ? "pill positive" : "pill neutral";
  }
  const el = bind("owner_badge");
  el.className = cls;
  el.textContent = label;
}

function wireGlobalControls() {
  const windowSelect = $("[data-control='recent_window']");
  if (windowSelect) {
    windowSelect.value = String(state.recent.window);
    windowSelect.addEventListener("change", async () => {
      const next = Number(windowSelect.value) || RECENT_WINDOW_DEFAULT;
      if (next === state.recent.window) return;
      state.recent.window = next;
      if (isAggregateMode()) await loadAggregate();
      else await loadOverview();
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
    btn.setAttribute("aria-current", String(btn.dataset.subtab === state.subtab));
    btn.onclick = () => switchSubtab(btn.dataset.subtab);
  });
}

function switchSubtab(name) {
  state.subtab = name;
  $$(".tab[data-subtab]").forEach((btn) => {
    btn.setAttribute("aria-current", String(btn.dataset.subtab === name));
  });
  $$("[data-subpane]").forEach((pane) => {
    pane.hidden = pane.dataset.subpane !== name;
  });
  refreshDetailPane();
}

// ---- Overview view --------------------------------------------------------

async function loadOverview({ force = false } = {}) {
  const pid = state.providerId;
  const window = state.recent.window;
  const cacheKey = `${pid}|${window}`;
  if (!force) {
    const cached = state.overviewCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < OVERVIEW_CACHE_TTL_MS) {
      state.recent.visible = RECENT_PAGE_SIZE;
      state.overview = cached.data;
      renderOverview();
      initDetailControls();
      return;
    }
  }
  try {
    state.recent.visible = RECENT_PAGE_SIZE;
    const data = await v2.overview(pid, { window });
    state.overviewCache.set(cacheKey, { data, fetchedAt: Date.now() });
    if (state.providerId !== pid) return;   // user already switched away
    state.overview = data;
    renderOverview();
    initDetailControls();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function renderOverview() {
  const o = state.overview;
  const summary = o.summary || {};
  const meta = bind("bootstrap_meta");
  meta.textContent = `${summary.etf_count || 0} ETFs · ${summary.latest_snapshot_date || "-"}`;

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

function isRowFavorite(row) {
  if (isAggregateMode()) return true;
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
        state.lineup.sortDir = "asc";
      }
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
  const filtered = aggregate
    ? allRows
    : (state.lineup.favoritesOnly ? allRows.filter((r) => favSet.has(r.ticker)) : allRows);
  const rows = sortLineupRows(filtered);

  bind("lineup_count").textContent = nf.format(rows.length);
  const favCountEl = bind("favorites_count");
  if (favCountEl) {
    const total = aggregate
      ? [...readAllFavorites().values()].reduce((sum, s) => sum + s.size, 0)
      : favSet.size;
    favCountEl.textContent = `★ ${nf.format(total)}`;
  }

  const lineupToggle = $("[data-control='lineup_favorites_only']");
  const lineupToggleLabel = lineupToggle?.closest("label");
  if (lineupToggle) lineupToggle.checked = aggregate ? true : state.lineup.favoritesOnly;
  if (lineupToggleLabel) lineupToggleLabel.hidden = aggregate;

  const lineupProviderTh = document.querySelector("[data-bind-th='lineup_provider']");
  if (lineupProviderTh) lineupProviderTh.hidden = !aggregate;

  const body = bind("lineup_body");
  const colspan = aggregate ? 10 : 9;
  const emptyMsg = aggregate
    ? "관심 ETF 없음 — 펀드 탭에서 별을 눌러 추가하세요"
    : (state.lineup.favoritesOnly ? "관심 ETF 없음 — 별을 눌러 추가하세요" : "No ETFs");
  body.innerHTML = rows.length === 0
    ? `<tr><td colspan="${colspan}" class="empty">${emptyMsg}</td></tr>`
    : rows.map((r) => {
        const isFav = isRowFavorite(r);
        const providerCell = aggregate
          ? `<td class="clickable"><span class="provider-badge">${escape(r.provider_label || r.provider_id || "")}</span></td>`
          : "";
        const navTotalTitle = r.meta_snapshot_date ? `${r.meta_snapshot_date} 기준 NAV × 좌수` : "KRX 메타 미수집";
        const mktCapTitle = r.meta_snapshot_date ? `${r.meta_snapshot_date} 기준 종가 × 좌수` : "KRX 메타 미수집";
        return `
        <tr data-row-ticker="${escape(r.ticker)}" data-row-pid="${escape(r.provider_id || state.providerId || "")}">
          <td class="star-col">
            <button class="star-btn ${isFav ? "on" : ""}" data-fav-ticker="${escape(r.ticker)}" data-fav-pid="${escape(favoritePidForRow(r) || "")}" aria-pressed="${isFav}" title="${isFav ? "관심 해제" : "관심 ETF로 저장"}">${isFav ? "★" : "☆"}</button>
          </td>
          ${providerCell}
          <td class="clickable">${escape(r.name)}</td>
          <td class="clickable"><code>${escape(r.ticker)}</code></td>
          <td class="clickable">${escape(r.listing_date || "-")}</td>
          <td class="clickable">${escape(r.latest_snapshot_date || "-")}</td>
          <td class="num clickable">${nf.format(r.latest_holding_count || 0)}</td>
          <td class="num clickable" title="${escape(navTotalTitle)}">${fmtKrUnit(r.nav_total)}</td>
          <td class="num clickable" title="${escape(mktCapTitle)}">${fmtKrUnit(r.market_cap)}</td>
          <td class="num clickable">${nf.format(r.change_row_count || 0)}</td>
        </tr>`;
      }).join("");

  $$("[data-fav-ticker]", body).forEach((btn) => {
    btn.onclick = (event) => {
      event.stopPropagation();
      const pid = btn.dataset.favPid;
      if (!pid) return;
      toggleFavorite(pid, btn.dataset.favTicker);
      if (aggregate) {
        // Aggregate slice depends on the favorites set we just mutated — bust its cache
        // so the next render reflects the toggle instead of showing the stale snapshot.
        state.aggregateCache = null;
        loadAggregate({ force: true });
      } else {
        state.favorites = readFavorites(pid);
        renderLineup();
        renderRecentChanges();
      }
    };
  });

  $$("tr[data-row-ticker]", body).forEach((tr) => {
    const openDetail = async () => {
      const ticker = tr.dataset.rowTicker;
      const pid = tr.dataset.rowPid;
      if (aggregate && pid && pid !== state.providerId) {
        await switchProvider(pid);
      }
      state.detail.ticker = ticker;
      const select = $("[data-control='etf']");
      if (select) select.value = ticker;
      await refreshDatesForTicker();
      switchView("detail");
      refreshDetailPane();
    };
    $$("td.clickable", tr).forEach((td) => { td.onclick = openDetail; });
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
  const favOnly = aggregate ? true : state.recent.favoritesOnly;
  const favSet = state.favorites;
  const commonStockFiltered = items.filter(isCommonStockConstituent);
  const favFiltered = aggregate
    ? commonStockFiltered                                // aggregate payload is already favorites-only
    : (favOnly ? commonStockFiltered.filter((r) => favSet.has(r.ticker)) : commonStockFiltered);
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
  if (recentToggleLabel) recentToggleLabel.hidden = aggregate;   // redundant in aggregate mode

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

  feed.innerHTML = total === 0
    ? `<div class="empty">${aggregate || favOnly ? "관심 ETF의 변화 없음" : "No recent changes"}</div>`
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
  const dates = await availableDates(state.detail.ticker);
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
}

let qDebounceTimer = null;

function wireDetailControls() {
  const controls = [
    "etf", "mode", "date_single", "date_from", "date_to", "change_type",
  ];
  controls.forEach((name) => {
    const el = $(`[data-control='${name}']`);
    if (!el) return;
    el.addEventListener("change", async () => {
      if (name === "etf") {
        state.detail.ticker = el.value;
        await refreshDatesForTicker();
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
  const pid = state.providerId;
  const ticker = state.detail.ticker;
  const d = state.detail;
  try {
    if (state.subtab === "holdings") {
      const date = d.mode === "single" ? d.date_single : d.date_to;
      const key = `${pid}|${ticker}|${date}`;
      if (d.snapshotKey !== key || !d.snapshot) {
        d.snapshot = await v2.snapshot(pid, ticker, date);
        d.snapshotKey = key;
      }
      renderDetailKpis(d.snapshot);
      renderHoldings(d.snapshot);
    } else if (state.subtab === "changes") {
      const params = buildChangesParams();
      const key = `${pid}|${ticker}|${new URLSearchParams(params).toString()}`;
      if (d.changesKey !== key || !d.changes) {
        d.changes = await v2.changes(pid, ticker, params);
        d.changesKey = key;
      }
      renderChanges(d.changes);
      // KPI strip uses snapshot data; populate lazily so we don't refetch when cached.
      const snapDate = params.to || d.date_single;
      const snapKey = `${pid}|${ticker}|${snapDate}`;
      if (d.snapshotKey !== snapKey || !d.snapshot) {
        d.snapshot = await v2.snapshot(pid, ticker, snapDate);
        d.snapshotKey = snapKey;
      }
      renderDetailKpis(d.snapshot);
    } else if (state.subtab === "timeline") {
      const params = buildChangesParams();
      const key = `${pid}|${ticker}|${new URLSearchParams(params).toString()}`;
      if (d.timelineKey !== key || !d.timeline) {
        d.timeline = await v2.timeline(pid, ticker, params);
        d.timelineKey = key;
      }
      renderTimeline(d.timeline);
    } else if (state.subtab === "manifest") {
      const key = `${pid}|${ticker}`;
      if (d.manifestKey !== key || !d.manifest) {
        d.manifest = await v2.manifest(pid, ticker);
        d.manifestKey = key;
      }
      renderManifest(d.manifest);
    }
  } catch (err) {
    toast(err.message, { error: true });
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
  const maxWeight = rows[0]?.weight || 1;
  bind("holdings_body").innerHTML = rows.length === 0
    ? `<tr><td colspan="6" class="empty">No holdings</td></tr>`
    : rows.map((r, idx) => `
        <tr>
          <td class="num">${idx + 1}</td>
          <td>${escape(r.constituent_name || "-")}</td>
          <td><code>${escape(r.constituent_code || "")}</code></td>
          <td class="num">${nf.format(r.quantity || 0)}</td>
          <td class="num">${fmtMoney(r.valuation)}</td>
          <td class="num">
            <span class="weight-bar"><span style="width:${Math.min(100, ((r.weight || 0) / (maxWeight || 1)) * 100)}%"></span></span>
            ${wt(r.weight)}
          </td>
        </tr>`).join("");

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
    : rows.map((r) => `
        <tr>
          <td>${escape(r.snapshot_date)}</td>
          <td>${escape(r.previous_snapshot_date || "-")}</td>
          <td><span class="pill ${changeClass(r.change_type)}">${escape(r.change_type)}</span></td>
          <td>${escape(r.constituent_name || "-")}</td>
          <td><code>${escape(r.constituent_code || "")}</code></td>
          <td class="num">${wt(r.previous_weight)}</td>
          <td class="num">${wt(r.weight)}</td>
          <td class="num ${deltaClass(r.weight_delta)}">${wt(r.weight_delta)}</td>
        </tr>`).join("");
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
    : rows.map((r) => `
        <tr>
          <td>${escape(r.snapshot_date)}</td>
          <td><span class="pill ${r.manifest_status === "ok" ? "positive" : "warn"}">${escape(r.manifest_status)}</span></td>
          <td>${escape(r.reason || "-")}</td>
          <td class="num">${nf.format(r.holding_count || 0)}</td>
        </tr>`).join("");
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

// ---- Market ETF retail flow -------------------------------------------------

function marketFlowTitle(direction) {
  return `일간 ETF 개인 ${direction === "buy" ? "순매수" : "순매도"} 상위(전일)`;
}

function marketStatusClass(status) {
  if (status === "complete" || status === "cached") return "pill positive";
  if (status === "partial" || status === "running") return "pill warn";
  if (status === "failed") return "pill negative";
  return "pill neutral";
}

function renderMarketFlow() {
  const data = state.marketFlow.data;
  const statusData = state.marketFlow.status || {};
  const job = statusData.job || {};
  const statusEl = bind("market_flow_status");
  const countEl = bind("market_flow_count");
  const dateEl = $("[data-control='market_flow_date']");
  const limitEl = $("[data-control='market_flow_limit']");
  const directionEl = $("[data-control='market_flow_direction']");
  const direction = data?.direction || state.marketFlow.direction || "sell";
  if (dateEl && data?.trade_date) dateEl.value = data.trade_date;
  if (limitEl) limitEl.value = String(state.marketFlow.limit);
  if (directionEl) directionEl.value = direction;
  const titleEl = bind("market_flow_title");
  if (titleEl) titleEl.textContent = data?.title || marketFlowTitle(direction);
  const valueHeader = bind("market_flow_value_header");
  if (valueHeader) valueHeader.textContent = `개인 ${direction === "buy" ? "순매수" : "순매도"}`;

  const status = (state.marketFlow.loading || job.running) ? "running" : (data?.status || "missing");
  if (statusEl) {
    statusEl.className = marketStatusClass(status);
    statusEl.textContent = (state.marketFlow.loading || job.running) ? (job.phase || "running") : status;
  }
  const progressEl = bind("market_flow_progress");
  if (progressEl) {
    const total = Number(job.total || 0);
    const attempted = Number(job.attempted || 0);
    const progress = job.running && total > 0 ? `${job.phase || "수집"} ${nf.format(attempted)}/${nf.format(total)}` : "";
    progressEl.textContent = progress || (job.message || "");
  }

  const rows = data?.rows || [];
  if (countEl) countEl.textContent = nf.format(rows.length);
  const run = data?.run || {};
  const kpis = [
    { label: "기준일", value: data?.trade_date || "-" },
    { label: "상태", value: state.marketFlow.loading ? "loading" : (data?.status || "-") },
    { label: "성공", value: run.succeeded != null ? nf.format(run.succeeded) : "-" },
    { label: "실패", value: run.failed != null ? nf.format(run.failed) : "-" },
    { label: "갱신", value: data?.updated_at ? String(data.updated_at).replace("T", " ") : "-" },
  ];
  const kpiHost = bind("market_flow_kpis");
  if (kpiHost) {
    kpiHost.innerHTML = kpis.map((k) => (
      `<div class="kpi">
        <span class="kpi-label">${escape(k.label)}</span>
        <span class="kpi-value">${escape(k.value)}</span>
      </div>`
    )).join("");
  }

  const body = bind("market_flow_body");
  if (body) {
    const valueClass = direction === "buy" ? "delta-positive" : "delta-negative";
    body.innerHTML = rows.length === 0
      ? `<tr><td colspan="5" class="empty">${escape(data?.message || "수집 데이터 없음")}</td></tr>`
      : rows.map((r) => `
          <tr>
            <td class="num">${nf.format(r.rank || 0)}</td>
            <td>${escape(r.name || "-")}</td>
            <td><code>${escape(r.ticker || "-")}</code></td>
            <td class="num ${valueClass}">${escape(r.net_buy_value_uk || fmtKrUnit(r.net_buy_value))}</td>
            <td class="market-components">${escape(r.holding_summary || "PDF 구성종목 확인 불가")}</td>
          </tr>
        `).join("");
  }
  const textEl = bind("market_flow_text");
  if (textEl) {
    textEl.textContent = data?.text || data?.message || "수집 데이터 없음";
  }
  renderMarketFlowDiagnostics(data?.diagnostics || {});
  renderMarketFlowScheduler();
}

async function loadMarketFlow({ refresh = false, force = false } = {}) {
  if (!force && !refresh && state.marketFlow.data) {
    renderMarketFlow();
    return;
  }
  state.marketFlow.loading = true;
  renderMarketFlow();
  try {
    const payload = {
      date: refresh && !state.marketFlow.manualDate ? "latest" : state.marketFlow.date || "latest",
      limit: state.marketFlow.limit,
      direction: state.marketFlow.direction || "sell",
    };
    if (refresh) {
      state.marketFlow.status = await v2.refreshMarketFlow(payload);
      startMarketFlowPolling();
    } else {
      state.marketFlow.data = await v2.marketFlow(payload);
      if (state.marketFlow.data?.trade_date) {
        state.marketFlow.resolvedDate = state.marketFlow.data.trade_date;
        if (state.marketFlow.manualDate) state.marketFlow.date = state.marketFlow.data.trade_date;
      }
      if (state.marketFlow.data?.direction) state.marketFlow.direction = state.marketFlow.data.direction;
    }
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    state.marketFlow.loading = false;
    renderMarketFlow();
  }
}

async function pollMarketFlowStatus({ once = false } = {}) {
  try {
    state.marketFlow.status = await v2.marketFlowStatus();
    renderMarketFlow();
    if (state.marketFlow.status?.running || state.marketFlow.status?.job?.running) {
      if (!once) startMarketFlowPolling();
      return;
    }
    if (!once && state.view === "market") {
      await loadMarketFlow({ force: true });
    }
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function startMarketFlowPolling() {
  clearTimeout(marketFlowPollTimer);
  marketFlowPollTimer = setTimeout(async () => {
    await pollMarketFlowStatus();
  }, 1500);
}

async function loadMarketFlowScheduler() {
  try {
    state.marketFlow.scheduler = await v2.marketFlowScheduler();
    renderMarketFlowScheduler();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function renderMarketFlowScheduler() {
  const settings = state.marketFlow.scheduler?.settings || state.marketFlow.status?.settings || {};
  const current = state.bootstrap?.current_machine || {};
  const allowed = new Set(settings.allowed_machine_ids || []);
  const enabledEl = $("[data-control='market_sched_enabled']");
  const timeEl = $("[data-control='market_sched_time']");
  const allowedEl = $("[data-control='market_sched_current_allowed']");
  if (enabledEl) enabledEl.checked = !!settings.enabled;
  if (timeEl) timeEl.value = settings.update_time || "18:30";
  if (allowedEl) allowedEl.checked = current.machine_id ? allowed.has(current.machine_id) : false;
  const statusEl = bind("market_sched_status");
  if (statusEl) {
    const status = settings.last_status || "ready";
    statusEl.className = marketStatusClass(status === "success" ? "complete" : status);
    statusEl.textContent = status;
  }
}

function collectMarketFlowSchedulerSettings() {
  const base = state.marketFlow.scheduler?.settings || state.marketFlow.status?.settings || {};
  const current = state.bootstrap?.current_machine || {};
  const machines = new Set(base.allowed_machine_ids || []);
  if ($("[data-control='market_sched_current_allowed']")?.checked && current.machine_id) machines.add(current.machine_id);
  if (!$("[data-control='market_sched_current_allowed']")?.checked && current.machine_id) machines.delete(current.machine_id);
  return {
    ...base,
    enabled: !!$("[data-control='market_sched_enabled']")?.checked,
    update_time: $("[data-control='market_sched_time']")?.value || "18:30",
    allowed_machine_ids: [...machines],
  };
}

function renderMarketFlowDiagnostics(diagnostics) {
  const errors = diagnostics.errors || [];
  const gaps = diagnostics.holding_gaps || [];
  const total = Number(diagnostics.error_count || errors.length || 0) + Number(diagnostics.holding_gap_count || gaps.length || 0);
  const countEl = bind("market_flow_diagnostics_count");
  if (countEl) countEl.textContent = nf.format(total);
  const host = bind("market_flow_diagnostics");
  if (!host) return;
  const rows = [
    ...errors.map((row) => ({ type: "수집 실패", ...row })),
    ...gaps.map((row) => ({ type: "PDF 누락", ...row })),
  ];
  host.innerHTML = rows.length === 0
    ? `<div class="empty">진단 항목 없음</div>`
    : rows.slice(0, 80).map((row) => `
        <div class="feed-row with-date">
          <span class="date">${escape(row.trade_date || "")}</span>
          <span class="etf-tag">${escape(row.ticker || "")}</span>
          <span class="name">${escape(row.name || row.type || "")}</span>
          <span class="pill warn">${escape(row.type || row.status || "")}</span>
          <span class="etf-name">${escape(row.message || "")}</span>
        </div>
      `).join("");
}

async function copyMarketFlowText() {
  const text = state.marketFlow.data?.text || "";
  if (!text.trim()) {
    toast("복사할 본문이 없습니다.", { error: true });
    return;
  }
  await writeClipboard(text);
  toast("ETF 수급 본문이 복사되었습니다.");
}

async function copyBothMarketFlowText() {
  try {
    const payload = await v2.marketFlowCombined({
      date: state.marketFlow.date || "latest",
      limit: state.marketFlow.limit,
    });
    state.marketFlow.combined = payload;
    const text = payload?.text || "";
    if (!text.trim()) {
      toast("복사할 통합 본문이 없습니다.", { error: true });
      return;
    }
    await writeClipboard(text);
    toast("순매도·순매수 본문이 함께 복사되었습니다.");
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function syncMarketFlowDateInput(dateEl) {
  if (!dateEl) return;
  const value = dateEl.value || "";
  if (!value) {
    state.marketFlow.manualDate = false;
    state.marketFlow.date = "latest";
    return;
  }
  if (state.marketFlow.manualDate || value !== state.marketFlow.resolvedDate) {
    state.marketFlow.manualDate = true;
    state.marketFlow.date = value;
    return;
  }
  state.marketFlow.date = "latest";
}

function wireMarketControls() {
  const dateEl = $("[data-control='market_flow_date']");
  if (dateEl) {
    dateEl.addEventListener("change", () => {
      state.marketFlow.date = dateEl.value || "latest";
      state.marketFlow.manualDate = Boolean(dateEl.value);
    });
  }
  const limitEl = $("[data-control='market_flow_limit']");
  if (limitEl) {
    limitEl.value = String(state.marketFlow.limit);
    limitEl.addEventListener("change", () => {
      state.marketFlow.limit = Number(limitEl.value) || 5;
    });
  }
  const directionEl = $("[data-control='market_flow_direction']");
  if (directionEl) {
    directionEl.value = state.marketFlow.direction;
    directionEl.addEventListener("change", () => {
      state.marketFlow.direction = directionEl.value || "sell";
    });
  }
  document.querySelector("[data-action='market_flow_load']")?.addEventListener("click", () => {
    syncMarketFlowDateInput(dateEl);
    if (limitEl) state.marketFlow.limit = Number(limitEl.value) || 5;
    if (directionEl) state.marketFlow.direction = directionEl.value || "sell";
    loadMarketFlow({ force: true });
  });
  document.querySelector("[data-action='market_flow_refresh']")?.addEventListener("click", () => {
    syncMarketFlowDateInput(dateEl);
    if (limitEl) state.marketFlow.limit = Number(limitEl.value) || 5;
    if (directionEl) state.marketFlow.direction = directionEl.value || "sell";
    loadMarketFlow({ refresh: true, force: true });
  });
  document.querySelector("[data-action='market_flow_copy_both']")?.addEventListener("click", copyBothMarketFlowText);
  document.querySelector("[data-action='market_sched_save']")?.addEventListener("click", async () => {
    try {
      state.marketFlow.scheduler = await v2.saveMarketFlowScheduler(collectMarketFlowSchedulerSettings());
      renderMarketFlowScheduler();
      toast("ETF 수급 자동 수집 설정 저장.");
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  $$("[data-action='market_flow_copy'], [data-action='market_flow_copy_secondary']").forEach((btn) => {
    btn.addEventListener("click", copyMarketFlowText);
  });
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
