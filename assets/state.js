export const RECENT_PAGE_SIZE = 20;
export const RECENT_WINDOW_DEFAULT = 5;
export const LINEUP_PAGE_SIZE = 10;
export const OVERVIEW_CACHE_TTL_MS = 60_000;
export const AGGREGATE_PROVIDER_ID = "__all__";

export const state = {
  bootstrap: null,
  providerId: null,
  view: "overview",
  subtab: "holdings",
  overview: null,
  aggregate: null,
  recent: {
    window: RECENT_WINDOW_DEFAULT,
    visible: RECENT_PAGE_SIZE,
    favoritesOnly: false,
    signalTypes: new Set(["신규 편입", "편출", "액티브 매수", "액티브 매도"]),
  },
  overviewCache: new Map(),
  aggregateCache: null,
  loadingProvider: null,
  dateCache: new Map(),
  lineup: {
    favoritesOnly: false,
    sortKey: "nav_total",
    sortDir: "desc",
    visible: LINEUP_PAGE_SIZE,
    productQuery: "",
    holdingQuery: "",
    holdingSearchMatches: new Set(),
    holdingSearchLoading: false,
    holdingSearchError: "",
    holdingSearchRequestId: 0,
  },
  favorites: new Set(),
  detail: {
    ticker: "",
    mode: "single",
    date_single: "",
    date_from: "",
    date_to: "",
    q: "",
    type: "all",
    snapshot: null,
    snapshotKey: "",
    changes: null,
    changesKey: "",
    timeline: null,
    timelineKey: "",
    manifest: null,
    manifestKey: "",
  },
  scheduler: null,
};
