export function lineupRowsHtml({
  rows,
  aggregate,
  providerId,
  isRowFavorite,
  favoritePidForRow,
  escape,
  nf,
  fmtKrUnit,
}) {
  return rows.map((row) => {
    const isFav = isRowFavorite(row);
    const providerCell = aggregate
      ? `<td class="col-provider clickable"><span class="provider-badge">${escape(row.provider_label || row.provider_id || "")}</span></td>`
      : "";
    let navTotalTitle = "KRX 메타 미수집";
    if (row.aum_source === "holdings_valuation") {
      navTotalTitle = `${row.meta_snapshot_date || row.latest_snapshot_date || "-"} 기준 보유 평가금액 합계`;
    } else if (row.aum_source === "funetf_aum") {
      navTotalTitle = `${row.meta_snapshot_date || "-"} 기준 FUNETF 설정액`;
    } else if (row.meta_snapshot_date) {
      navTotalTitle = `${row.meta_snapshot_date} 기준 NAV × 좌수`;
    }
    const mktCapTitle = row.meta_snapshot_date ? `${row.meta_snapshot_date} 기준 종가 × 좌수` : "KRX 메타 미수집";
    return `
        <tr data-row-ticker="${escape(row.ticker)}" data-row-pid="${escape(row.provider_id || providerId || "")}">
          <td class="star-col">
            <button class="star-btn ${isFav ? "on" : ""}" data-fav-ticker="${escape(row.ticker)}" data-fav-pid="${escape(favoritePidForRow(row) || "")}" aria-pressed="${isFav}" title="${isFav ? "관심 해제" : "관심 ETF로 저장"}">${isFav ? "★" : "☆"}</button>
          </td>
          ${providerCell}
          <td class="col-name clickable">${escape(row.name)}</td>
          <td class="col-code clickable"><code>${escape(row.ticker)}</code></td>
          <td class="col-listing clickable">${escape(row.listing_date || "-")}</td>
          <td class="col-date clickable">${escape(row.latest_snapshot_date || "-")}</td>
          <td class="col-holdings num clickable">${nf.format(row.latest_holding_count || 0)}</td>
          <td class="col-nav num clickable" title="${escape(navTotalTitle)}">${fmtKrUnit(row.nav_total)}</td>
          <td class="col-market num clickable" title="${escape(mktCapTitle)}">${fmtKrUnit(row.market_cap)}</td>
          <td class="col-changes num clickable">${nf.format(row.change_row_count || 0)}</td>
        </tr>`;
  }).join("");
}
