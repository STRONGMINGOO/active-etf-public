export function holdingsRowsHtml({ rows, escape, nf, fmtMoney, wt }) {
  const maxWeight = rows[0]?.weight || 1;
  return rows.map((row, index) => `
        <tr>
          <td class="num">${index + 1}</td>
          <td>${escape(row.constituent_name || "-")}</td>
          <td><code>${escape(row.constituent_code || "")}</code></td>
          <td class="num">${nf.format(row.quantity || 0)}</td>
          <td class="num">${fmtMoney(row.valuation)}</td>
          <td class="num">
            <span class="weight-bar"><span style="width:${Math.min(100, ((row.weight || 0) / (maxWeight || 1)) * 100)}%"></span></span>
            ${wt(row.weight)}
          </td>
        </tr>`).join("");
}

export function changesRowsHtml({ rows, escape, wt, changeClass, deltaClass }) {
  return rows.map((row) => `
        <tr>
          <td>${escape(row.snapshot_date)}</td>
          <td>${escape(row.previous_snapshot_date || "-")}</td>
          <td><span class="pill ${changeClass(row.change_type)}">${escape(row.change_type)}</span></td>
          <td>${escape(row.constituent_name || "-")}</td>
          <td><code>${escape(row.constituent_code || "")}</code></td>
          <td class="num">${wt(row.previous_weight)}</td>
          <td class="num">${wt(row.weight)}</td>
          <td class="num ${deltaClass(row.weight_delta)}">${wt(row.weight_delta)}</td>
        </tr>`).join("");
}

export function manifestRowsHtml({ rows, escape, nf }) {
  return rows.map((row) => `
        <tr>
          <td>${escape(row.snapshot_date)}</td>
          <td><span class="pill ${row.manifest_status === "ok" ? "positive" : "warn"}">${escape(row.manifest_status)}</span></td>
          <td>${escape(row.reason || "-")}</td>
          <td class="num">${nf.format(row.holding_count || 0)}</td>
        </tr>`).join("");
}
