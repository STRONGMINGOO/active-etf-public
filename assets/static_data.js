const enc = encodeURIComponent;

function compactNfcText(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}

function normalizeSearchText(value) {
  return compactNfcText(value).toLocaleLowerCase("ko-KR");
}

export function createStaticDataClient({ base, recentWindowDefault }) {
  const dataBase = String(base || "").replace(/\/+$/, "");
  const cache = new Map();

  const path = (value) => `${dataBase}/${String(value || "").replace(/^\/+/, "")}`;

  async function json(value) {
    const url = path(value);
    if (cache.has(url)) return cache.get(url);
    const promise = fetch(url).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `${url}: ${response.status}`);
      return body;
    });
    cache.set(url, promise);
    return promise;
  }

  async function jsonOptional(value) {
    const url = path(value);
    if (cache.has(url)) return cache.get(url);
    const promise = fetch(url).then(async (response) => {
      if (!response.ok) return null;
      return response.json().catch(() => null);
    });
    cache.set(url, promise);
    return promise;
  }

  async function legacyEtfBundle(pid, ticker) {
    return json(`providers/${enc(pid)}/etfs/${enc(ticker)}.json`);
  }

  async function overview(pid, params = {}) {
    const window = Number(params?.window || recentWindowDefault);
    const baseOverview = await jsonOptional(`providers/${enc(pid)}/overview.json`);
    if (!baseOverview) return json(`providers/${enc(pid)}/overview-${window}.json`);
    const signals = await jsonOptional(`providers/${enc(pid)}/signals-${window}.json`);
    return { ...baseOverview, ...(signals || {}) };
  }

  async function dates(pid, ticker) {
    const payload = await jsonOptional(`providers/${enc(pid)}/etfs/${enc(ticker)}/meta.json`);
    if (payload) return { ticker, dates: payload.dates || [] };
    const datesPayload = await jsonOptional(`providers/${enc(pid)}/etfs/${enc(ticker)}/dates.json`);
    if (datesPayload) return datesPayload;
    return legacyEtfBundle(pid, ticker).then((bundle) => ({ ticker, dates: bundle.dates || [] }));
  }

  async function snapshots(pid, ticker) {
    const payload = await jsonOptional(`providers/${enc(pid)}/etfs/${enc(ticker)}/snapshots.json`);
    if (payload) return payload;
    const legacy = await jsonOptional(`providers/${enc(pid)}/etfs/${enc(ticker)}.json`);
    if (!legacy) return null;
    return {
      ticker,
      dates: legacy.dates || [],
      snapshots: legacy.snapshots || {},
    };
  }

  async function snapshot(pid, ticker, date) {
    const datesPayload = await dates(pid, ticker);
    const allDates = datesPayload.dates || [];
    const latest = allDates[allDates.length - 1] || "";
    const selected = date || latest;
    const bundle = await snapshots(pid, ticker);
    const bundledSnapshot = bundle?.snapshots?.[selected] || bundle?.snapshots?.[latest];
    if (bundledSnapshot) return bundledSnapshot;
    const payload = selected
      ? await jsonOptional(`providers/${enc(pid)}/etfs/${enc(ticker)}/snapshots/${enc(selected)}.json`)
      : null;
    if (payload) return payload;
    return {
      ticker,
      snapshot_date: selected,
      kpis: {},
      holdings: [],
      top_changes: { additions: [], removals: [], weight_changes: [] },
    };
  }

  async function changes(pid, ticker) {
    const payload = await jsonOptional(`providers/${enc(pid)}/etfs/${enc(ticker)}/changes.json`);
    if (payload) return payload.changes || [];
    return legacyEtfBundle(pid, ticker).then((bundle) => bundle.changes || []);
  }

  async function manifest(pid, ticker) {
    const payload = await jsonOptional(`providers/${enc(pid)}/etfs/${enc(ticker)}/meta.json`);
    if (payload) return payload.manifest || [];
    const manifestPayload = await jsonOptional(`providers/${enc(pid)}/etfs/${enc(ticker)}/manifest.json`);
    if (manifestPayload) return manifestPayload.manifest || [];
    return legacyEtfBundle(pid, ticker).then((bundle) => bundle.manifest || []);
  }

  async function search(pid, q, scope = "all") {
    const query = compactNfcText(q);
    if (!query) return { provider_id: pid, query, matches: [] };
    const needle = normalizeSearchText(query);
    const searchScope = ["all", "product", "holdings"].includes(scope) ? scope : "all";
    const index = await json("search-index.json");
    const rows = Array.isArray(index?.providers?.[pid]) ? index.providers[pid] : [];
    const seen = new Set();
    const matches = [];
    for (const row of rows) {
      const ticker = String(row?.ticker || "");
      const productTerms = row?.product_terms ?? `${ticker} ${row?.name || ""}`;
      const holdingTerms = row?.holding_terms ?? row?.terms ?? "";
      const terms = searchScope === "product"
        ? productTerms
        : (searchScope === "holdings" ? holdingTerms : row?.terms ?? `${productTerms} ${holdingTerms}`);
      const haystack = normalizeSearchText(Array.isArray(terms) ? terms.join(" ") : terms);
      if (!ticker || seen.has(ticker) || !haystack.includes(needle)) continue;
      seen.add(ticker);
      matches.push({ ticker, name: String(row?.name || "") });
    }
    return { provider_id: pid, query, matches };
  }

  return { json, overview, dates, snapshot, changes, manifest, search };
}
