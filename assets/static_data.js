const enc = encodeURIComponent;

export function createStaticDataClient({ base, recentWindowDefault, marketFlowTitle }) {
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

  async function marketFlow(params = {}) {
    const direction = String(params?.direction || "sell") === "buy" ? "buy" : "sell";
    return json(`market/etf-retail-net-${direction}.json`).catch(() => ({
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

  async function marketCombined(params = {}) {
    return json("market/etf-retail-flow-combined.json").catch(async () => ({
      sell: await marketFlow({ ...params, direction: "sell" }),
      buy: await marketFlow({ ...params, direction: "buy" }),
    }));
  }

  return { json, overview, dates, snapshot, changes, manifest, marketFlow, marketCombined };
}
