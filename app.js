/* ═══════════════════════════════════════════════════
   SCOTUS Scoragami — app.js
   Loads data/decisions.json and renders the UI.
   ═══════════════════════════════════════════════════ */

"use strict";

// ── Helpers ──────────────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function fmtDate(iso) {
  if (!iso) return "unknown date";
  try {
    return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", {
      year: "numeric", month: "long", day: "numeric",
    });
  } catch {
    return iso;
  }
}

/**
 * Return a background colour for an agreement percentage value.
 * Gradient: red (0%) → amber (50%) → green (100%)
 */
function agreementColor(pct) {
  if (pct === null || pct === undefined) return null;
  const t = Math.max(0, Math.min(100, pct)) / 100;

  let r, g, b;
  if (t < 0.5) {
    // red (#da3633) → amber (#d4af37)
    const s = t / 0.5;
    r = Math.round(218 + s * (212 - 218));
    g = Math.round(54  + s * (175 - 54));
    b = Math.round(51  + s * (55  - 51));
  } else {
    // amber (#d4af37) → green (#2ea043)
    const s = (t - 0.5) / 0.5;
    r = Math.round(212 + s * (46  - 212));
    g = Math.round(175 + s * (160 - 175));
    b = Math.round(55  + s * (67  - 55));
  }
  const alpha = 0.18 + 0.55 * t;          // low agreement = more transparent
  return `rgba(${r},${g},${b},${alpha})`;
}

function textColorForPct(pct) {
  if (pct === null || pct === undefined) return "var(--text-muted)";
  if (pct >= 80) return "#7ce09a";
  if (pct >= 65) return "#d4c97a";
  if (pct >= 50) return "#e09050";
  return "#f07070";
}

// ── Badge helpers ─────────────────────────────────────────────────────────────

const BADGE_CONFIG = {
  first_pair_dissent: { cls: "badge-pair",     label: "First pair dissent" },
  sole_dissent:       { cls: "badge-sole",     label: "Sole dissenter" },
  most_agree:         { cls: "badge-agree",    label: "Most agreeable" },
  most_disagree:      { cls: "badge-disagree", label: "Least agreeable" },
};

function badgeHTML(type) {
  const cfg = BADGE_CONFIG[type] || { cls: "badge-pair", label: type };
  return `<span class="fact-badge ${cfg.cls}">${cfg.label}</span>`;
}

// ── Render: Stats Bar ─────────────────────────────────────────────────────────

function renderStats(data) {
  const s = data.stats || {};
  $("#stat-cases").textContent       = (s.total_cases       ?? "—").toLocaleString();
  $("#stat-coalitions").textContent  = (s.unique_dissent_coalitions ?? "—").toLocaleString();
  $("#stat-unanimous").textContent   = (s.unanimous_cases    ?? "—").toLocaleString();

  if (s.most_common_dissent) {
    const names = s.most_common_dissent.dissenters.join(" + ");
    const count = s.most_common_dissent.count;
    $("#stat-common").textContent    = `${names} (${count}×)`;
  }

  if (data.last_updated) {
    const d = new Date(data.last_updated);
    $("#last-updated").textContent =
      "Updated " + d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }
}

// ── Render: Scoragami / Facts Cards ──────────────────────────────────────────

function renderFacts(facts, filter = "all") {
  const grid = $("#facts-grid");
  if (!facts || facts.length === 0) {
    grid.innerHTML = `<p class="error-state">No facts available yet. Run the scraper to populate data.</p>`;
    return;
  }

  const filtered = filter === "all" ? facts : facts.filter(f => f.type === filter);

  if (filtered.length === 0) {
    grid.innerHTML = `<p style="color:var(--text-muted);font-size:.9rem;">No facts match this filter.</p>`;
    return;
  }

  grid.innerHTML = filtered.map(fact => {
    const isNew = fact.is_new ? "is-new" : "";
    const meta = fact.date ? `<div class="fact-meta">${fmtDate(fact.date)}${fact.case ? ` — ${fact.case}` : ""}</div>` : "";
    return `
      <div class="fact-card ${isNew}">
        ${badgeHTML(fact.type)}
        <p class="fact-text">${escHtml(fact.text)}</p>
        ${meta}
      </div>`;
  }).join("");
}

// ── Render: Agreement Matrix ──────────────────────────────────────────────────

function renderMatrix(matrix, justices, cases) {
  const tbody = $("#matrix-table tbody");
  if (!matrix || justices.length === 0) {
    tbody.innerHTML = `<tr><td class="error-state">No matrix data</td></tr>`;
    return;
  }

  // Header row
  const headerCells = justices.map(
    j => `<th title="${j}">${j}</th>`
  ).join("");
  const headerRow = `<tr><th></th>${headerCells}</tr>`;

  // Data rows
  const rows = justices.map(j1 => {
    const cells = justices.map(j2 => {
      if (j1 === j2) {
        return `<td><div class="matrix-cell matrix-self" title="${j1}">—</div></td>`;
      }
      const pct = (matrix[j1] || {})[j2];
      if (pct === null || pct === undefined) {
        return `<td><div class="matrix-cell no-data" title="No data">?</div></td>`;
      }
      const bg    = agreementColor(pct);
      const color = textColorForPct(pct);
      const label = pct.toFixed(1) + "%";
      return `
        <td>
          <div class="matrix-cell"
               style="background:${bg};color:${color}"
               title="${j1} vs ${j2}: ${label}"
               data-j1="${escAttr(j1)}" data-j2="${escAttr(j2)}" data-pct="${pct}">
            ${label}
          </div>
        </td>`;
    }).join("");
    return `<tr><th style="text-align:right;padding-right:.6rem;">${j1}</th>${cells}</tr>`;
  }).join("");

  tbody.innerHTML = headerRow + rows;

  // Click handler — show cases where pair voted together
  tbody.addEventListener("click", e => {
    const cell = e.target.closest("[data-j1]");
    if (!cell) return;
    const j1  = cell.dataset.j1;
    const j2  = cell.dataset.j2;
    const pct = parseFloat(cell.dataset.pct).toFixed(1);
    openMatrixModal(j1, j2, pct, cases);
  });
}

function openMatrixModal(j1, j2, pct, cases) {
  const together = (cases || []).filter(c => {
    const v = c.votes || {};
    const all = [...(v.majority||[]), ...(v.dissent||[])];
    if (!all.includes(j1) || !all.includes(j2)) return false;
    const sameSide =
      ((v.majority||[]).includes(j1) && (v.majority||[]).includes(j2)) ||
      ((v.dissent||[]).includes(j1)  && (v.dissent||[]).includes(j2));
    return sameSide;
  });

  const total = (cases || []).filter(c => {
    const v = c.votes || {};
    const all = [...(v.majority||[]), ...(v.dissent||[])];
    return all.includes(j1) && all.includes(j2);
  }).length;

  const items = together.slice(0, 40).map(c => `
    <li>
      <span>${escHtml(c.name)}</span>
      <span class="case-date">${fmtDate(c.decided_date)}</span>
    </li>`).join("");

  openModal(`
    <h3>${j1} &amp; ${j2}</h3>
    <p style="margin-bottom:1rem;color:var(--text-muted);font-size:.9rem;">
      Agreed on <strong style="color:var(--gold)">${pct}%</strong> of
      ${total} cases they both participated in
      (${together.length} cases on the same side${together.length > 40 ? "; showing 40 most recent" : ""}).
    </p>
    <ul class="modal-cases">${items || '<li style="color:var(--text-muted)">No matching cases found.</li>'}</ul>
  `);
}

// ── Render: Coalition List ────────────────────────────────────────────────────

let _allCoalitions = [];

function renderCoalitions(coalitions, search = "", sort = "count") {
  const list = $("#coalition-list");
  if (!coalitions || Object.keys(coalitions).length === 0) {
    list.innerHTML = `<p class="error-state">No coalition data available.</p>`;
    return;
  }

  let items = Object.entries(coalitions).map(([key, col]) => ({ key, ...col }));

  // Filter
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    items = items.filter(item =>
      item.dissenters.some(j => j.toLowerCase().includes(q))
    );
  }

  // Sort
  switch (sort) {
    case "count":    items.sort((a, b) => b.count - a.count);                   break;
    case "rare":     items.sort((a, b) => a.count - b.count);                   break;
    case "recent":   items.sort((a, b) => (b.first_date||"").localeCompare(a.first_date||"")); break;
    case "date_asc": items.sort((a, b) => (a.first_date||"").localeCompare(b.first_date||"")); break;
  }

  if (items.length === 0) {
    list.innerHTML = `<p style="color:var(--text-muted);padding:.5rem;">No coalitions match your search.</p>`;
    return;
  }

  list.innerHTML = items.map(item => {
    const chips = item.dissenters.map(j => `<span class="justice-chip">${escHtml(j)}</span>`).join("");
    const dateStr = item.first_date ? fmtDate(item.first_date) : "unknown date";
    const newBadge = item.is_new ? `<span class="fact-badge badge-pair" style="margin-left:.3rem">NEW</span>` : "";
    return `
      <div class="coalition-item ${item.is_new ? "is-new" : ""}"
           data-key="${escAttr(item.key)}" role="button" tabindex="0">
        <div class="coalition-count">${item.count}</div>
        <div class="coalition-body">
          <div class="coalition-names">${chips}${newBadge}</div>
          <div class="coalition-meta">
            First occurrence: <em>${escHtml(item.first_case)}</em> · ${dateStr}
          </div>
        </div>
      </div>`;
  }).join("");

  // Click → show modal with matching cases
  list.addEventListener("click", e => {
    const row = e.target.closest("[data-key]");
    if (!row) return;
    const key = row.dataset.key;
    const col = coalitions[key];
    if (col) openCoalitionModal(col, _allCoalitions);
  });
}

function openCoalitionModal(col, cases) {
  const dissenters = col.dissenters;
  const matching = (cases || []).filter(c => {
    const d = (c.votes || {}).dissent || [];
    return dissenters.every(j => d.includes(j)) && d.length === dissenters.length;
  });

  const items = matching.slice(0, 50).map(c => `
    <li>
      <span>${escHtml(c.name)}</span>
      <span class="case-date">${fmtDate(c.decided_date)}</span>
    </li>`).join("");

  const chips = dissenters.map(j => `<span class="justice-chip">${escHtml(j)}</span>`).join(" ");
  openModal(`
    <h3>Dissent Coalition: ${chips}</h3>
    <p style="margin-bottom:1rem;color:var(--text-muted);font-size:.9rem;">
      Appeared <strong style="color:var(--gold)">${col.count}</strong> time(s).
      First: <em>${escHtml(col.first_case)}</em> (${fmtDate(col.first_date)}).
      ${matching.length > 50 ? "Showing 50 most recent." : ""}
    </p>
    <ul class="modal-cases">${items || '<li style="color:var(--text-muted)">No cases found.</li>'}</ul>
  `);
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

function openModal(html) {
  $("#modal-content").innerHTML = html;
  $("#modal-backdrop").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  $("#modal-backdrop").hidden = true;
  document.body.style.overflow = "";
}

// ── Security: escape HTML/attributes ─────────────────────────────────────────

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escAttr(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Event Wiring ──────────────────────────────────────────────────────────────

function wireEvents(data) {
  // Fact filter
  $("#fact-filter").addEventListener("change", e => {
    renderFacts(data.interesting_facts, e.target.value);
  });

  // Coalition filter + sort
  const searchBox  = $("#coalition-search");
  const sortSelect = $("#coalition-sort");

  function rerenderCoalitions() {
    renderCoalitions(data.coalitions, searchBox.value, sortSelect.value);
  }

  searchBox.addEventListener("input",  rerenderCoalitions);
  sortSelect.addEventListener("change", rerenderCoalitions);

  // Modal close
  $("#modal-close").addEventListener("click", closeModal);
  $("#modal-backdrop").addEventListener("click", e => {
    if (e.target === $("#modal-backdrop")) closeModal();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeModal();
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  try {
    const resp = await fetch("data/decisions.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    _allCoalitions = data.cases || [];

    renderStats(data);

    const justices = Object.keys(data.agreement_matrix || {});
    renderMatrix(data.agreement_matrix, justices, data.cases);

    renderFacts(data.interesting_facts);
    renderCoalitions(data.coalitions);

    wireEvents(data);

  } catch (err) {
    console.error("Failed to load SCOTUS data:", err);
    ["facts-grid", "coalition-list"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `
        <div class="error-state">
          <strong>Could not load data</strong>
          ${escHtml(err.message)}.<br>
          If you are running this locally, serve the files via a local server
          (e.g. <code>python -m http.server</code>).
        </div>`;
    });
  }
}

document.addEventListener("DOMContentLoaded", init);
