/**
 * /stats command — comprehensive stats report for Telegram.
 * Pulls from decision-log.json, state.json, daily-pnl.json, pool-memory.json.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadJson(file) {
  const p = path.join(__dirname, file);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return "?";
  return (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2);
}

export function generateStatsReport() {
  const pnlData = loadJson("daily-pnl.json");
  const stateData = loadJson("state.json");
  const decisionData = loadJson("decision-log.json");
  const poolMemory = loadJson("pool-memory.json");

  const L = [];
  L.push("━━━ 📊 STATS REPORT ━━━");
  L.push("Period: last 7 days");
  L.push("");

  // ── DAILY BREAKDOWN ─────────────────────────────────────────────
  L.push("📈 DAILY BREAKDOWN");

  const snapshots = pnlData?.snapshots || [];
  const last7 = snapshots.slice(-7);

  if (last7.length === 0) {
    L.push("insufficient data");
  } else {
    L.push("Day        | Trades | WR%  | Avg Win  | Avg Loss");
    for (const day of last7) {
      const trades = day.realized?.trades_closed ?? 0;
      const wr = day.realized?.win_rate_pct != null ? `${day.realized.win_rate_pct}%` : "—";
      const closed = day.closed_positions || [];
      const wins = closed.filter(t => (t.pnl_usd || 0) > 0);
      const losses = closed.filter(t => (t.pnl_usd || 0) < 0);
      const avgWin = wins.length > 0
        ? fmtUsd(wins.reduce((s, t) => s + t.pnl_usd, 0) / wins.length)
        : "—";
      const avgLoss = losses.length > 0
        ? fmtUsd(losses.reduce((s, t) => s + t.pnl_usd, 0) / losses.length)
        : "—";
      L.push(`${day.date} | ${String(trades).padStart(6)} | ${wr.padStart(4)} | ${avgWin.padStart(8)} | ${avgLoss.padStart(8)}`);
    }
  }
  L.push("");

  // ── SCREENING (last 48h) ────────────────────────────────────────
  L.push("🔍 SCREENING (last 48h)");

  const decisions = decisionData?.decisions || [];
  const now = Date.now();
  const h48 = 48 * 60 * 60 * 1000;
  const recent48h = decisions.filter(d => d.ts && (now - new Date(d.ts).getTime()) < h48);
  // Screening cycles = decisions by SCREENER actor
  const screenCycles = recent48h.filter(d => d.actor === "SCREENER");

  if (screenCycles.length === 0) {
    L.push("insufficient data");
  } else {
    const withCandidate = screenCycles.filter(d => d.type === "deploy" || (d.type === "no_deploy" && d.summary?.includes("Single candidate")));
    const empty = screenCycles.filter(d => d.type === "no_deploy" && !d.summary?.includes("Single candidate") || d.type === "skip");
    const foundCount = screenCycles.length - empty.length;
    const emptyCount = empty.length;
    const foundPct = screenCycles.length > 0 ? Math.round((foundCount / screenCycles.length) * 100) : 0;
    const emptyPct = screenCycles.length > 0 ? Math.round((emptyCount / screenCycles.length) * 100) : 0;

    L.push(`Total cycles: ${screenCycles.length}`);
    L.push(`Found candidate: ${foundCount} (${foundPct}%)`);
    L.push(`Returned empty: ${emptyCount} (${emptyPct}%)`);
    L.push("");

    // Top rejection reasons from rejected arrays
    const reasonCounts = {};
    for (const d of screenCycles) {
      const rejected = d.rejected || [];
      for (const r of rejected) {
        // Extract reason category from strings like "TOKENNAME: volatility 0.8 below minVolatility 1.5"
        const reasonPart = r.includes(":") ? r.split(":").slice(1).join(":").trim() : r;
        const category = categorizeRejection(reasonPart);
        reasonCounts[category] = (reasonCounts[category] || 0) + 1;
      }
      // Also count from the reason field for no_deploy decisions
      if (d.type === "no_deploy" && d.reason && !d.rejected?.length) {
        const category = categorizeRejection(d.reason);
        reasonCounts[category] = (reasonCounts[category] || 0) + 1;
      }
    }

    const sorted = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (sorted.length > 0) {
      L.push("Top rejection reasons:");
      sorted.forEach(([reason, count], i) => {
        L.push(`${i + 1}. ${reason} — ${count} pools`);
      });
    }
  }
  L.push("");

  // ── LOSING TRADES (last 24h) ────────────────────────────────────
  L.push("❌ LOSING TRADES (last 24h)");

  const h24 = 24 * 60 * 60 * 1000;
  // Get losing trades from state.json closedPaperPositions + positions
  const closedPaper = (stateData?.closedPaperPositions || []).filter(
    p => p.closed_at && (now - new Date(p.closed_at).getTime()) < h24 && (p.pnl_usd || p.total_return_usd || 0) < 0
  );
  const closedLive = Object.values(stateData?.positions || {}).filter(
    p => p.closed && p.closed_at && (now - new Date(p.closed_at).getTime()) < h24 && (p.pnl_usd || p.total_return_usd || 0) < 0
  );
  const losers = [...closedPaper, ...closedLive];

  if (losers.length === 0) {
    L.push("No losing trades in last 24h");
  } else {
    L.push("Token       | Hold   | Exit reason      | PnL%");
    for (const t of losers) {
      const pair = (t.pair || t.pool_name || "?").split("-")[0].slice(0, 11);
      const hold = t.minutes_held != null ? `${t.minutes_held}m` : "?";
      const reason = (t.close_reason || "unknown").slice(0, 16);
      const pnlPct = (t.pnl_pct || t.total_return_pct || 0).toFixed(1) + "%";
      L.push(`${pair.padEnd(11)} | ${hold.padStart(6)} | ${reason.padEnd(16)} | ${pnlPct}`);
    }
  }
  L.push("");

  // ── ACTIVE BANS ─────────────────────────────────────────────────
  L.push("🚫 ACTIVE BANS (cooldown list)");

  const bans = [];
  if (poolMemory) {
    const seen = new Set();
    for (const [addr, entry] of Object.entries(poolMemory)) {
      const name = entry.name || addr.slice(0, 8);
      // Pool-level cooldown
      if (entry.cooldown_until && new Date(entry.cooldown_until) > new Date()) {
        if (!seen.has(name)) {
          seen.add(name);
          bans.push({
            name,
            reason: entry.cooldown_reason || "unknown",
            expires: entry.cooldown_until,
          });
        }
      }
      // Base mint cooldown
      if (entry.base_mint_cooldown_until && new Date(entry.base_mint_cooldown_until) > new Date()) {
        if (!seen.has(name)) {
          seen.add(name);
          bans.push({
            name,
            reason: entry.base_mint_cooldown_reason || "unknown",
            expires: entry.base_mint_cooldown_until,
          });
        }
      }
    }
  }

  if (bans.length === 0) {
    L.push("No active bans");
  } else {
    L.push("Token       | Reason              | Ban expires");
    for (const b of bans) {
      const name = b.name.slice(0, 11);
      const reason = b.reason.slice(0, 19);
      const expires = b.expires.slice(0, 16).replace("T", " ");
      L.push(`${name.padEnd(11)} | ${reason.padEnd(19)} | ${expires}`);
    }
  }
  L.push("");
  L.push("━━━━━━━━━━━━━━━━━━━━━━");

  return L.join("\n");
}

function categorizeRejection(reason) {
  const r = reason.toLowerCase();
  if (r.includes("volatility") && (r.includes("below") || r.includes("low") || r.includes("unusable"))) return "low volatility";
  if (r.includes("volatility") && r.includes("above")) return "high volatility";
  if (r.includes("fee") && (r.includes("tvl") || r.includes("below"))) return "low fee/TVL";
  if (r.includes("cooldown") || r.includes("memory")) return "pool memory ban";
  if (r.includes("organic")) return "low organic score";
  if (r.includes("holder") && r.includes("below")) return "low holders";
  if (r.includes("bot") && r.includes("holder")) return "high bot holders";
  if (r.includes("mcap") && r.includes("below")) return "low mcap";
  if (r.includes("mcap") && r.includes("above")) return "high mcap";
  if (r.includes("tvl") && r.includes("below")) return "low TVL";
  if (r.includes("tvl") && r.includes("above")) return "high TVL";
  if (r.includes("blacklist")) return "blacklisted token";
  if (r.includes("launchpad")) return "blocked launchpad";
  if (r.includes("pvp")) return "PVP filter";
  if (r.includes("wash")) return "wash trading";
  if (r.includes("honeypot")) return "honeypot";
  if (r.includes("volume")) return "low volume";
  if (r.includes("position") || r.includes("already")) return "already deployed";
  if (r.includes("insufficient") || r.includes("sol")) return "insufficient SOL";
  if (r.includes("max position")) return "max positions reached";
  return reason.slice(0, 30);
}
