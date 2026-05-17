/**
 * Daily PnL Tracker
 *
 * Snapshots the portfolio state every 24 hours and persists a daily log.
 * Each snapshot records:
 *   - Total portfolio value (open positions + closed PnL for the day)
 *   - Number of trades (opened / closed)
 *   - Realized PnL from closed positions
 *   - Unrealized PnL from open positions
 *   - Total fees earned
 *   - Win rate for the day
 *
 * Data is stored in daily-pnl.json as an append-only array of daily records.
 * A Telegram summary is sent after each snapshot.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PNL_FILE = path.join(__dirname, "daily-pnl.json");
const STATE_FILE = path.join(__dirname, "state.json");
const LESSONS_FILE = path.join(__dirname, "lessons.json");

// ─── Persistence ─────────────────────────────────────────────────

function loadPnlHistory() {
  if (!fs.existsSync(PNL_FILE)) return { snapshots: [] };
  try {
    return JSON.parse(fs.readFileSync(PNL_FILE, "utf8"));
  } catch {
    return { snapshots: [] };
  }
}

function savePnlHistory(data) {
  try {
    fs.writeFileSync(PNL_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log("daily_pnl_error", `Failed to write daily-pnl.json: ${err.message}`);
  }
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ─── Snapshot Logic ──────────────────────────────────────────────

/**
 * Take a daily PnL snapshot.
 * Captures all trading activity in the last 24 hours and appends to history.
 *
 * @returns {Object} The snapshot record
 */
export function takeDailySnapshot() {
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

  const state = loadJson(STATE_FILE) || {
    positions: {},
    paperPositions: {},
    closedPaperPositions: [],
  };
  const lessonsData = loadJson(LESSONS_FILE) || { performance: [] };

  // ── Closed positions in last 24h (realized PnL) ───────────────
  const closedPaper = (state.closedPaperPositions || []).filter(
    (p) => p.closed_at && new Date(p.closed_at) > last24h
  );
  const closedLive = Object.values(state.positions || {}).filter(
    (p) => p.closed && p.closed_at && new Date(p.closed_at) > last24h
  );
  const allClosed = [...closedPaper, ...closedLive];

  const realizedPnlUsd = allClosed.reduce(
    (s, p) => s + (p.pnl_usd || p.total_return_usd || 0),
    0
  );
  const realizedFeesUsd = allClosed.reduce(
    (s, p) => s + (p.simulated_fees_usd || p.fees_earned_usd || p.total_fees_claimed_usd || 0),
    0
  );
  const closedWins = allClosed.filter(
    (p) => (p.total_return_usd || p.pnl_usd || 0) > 0
  ).length;
  const closedWinRate =
    allClosed.length > 0
      ? Math.round((closedWins / allClosed.length) * 100)
      : null;

  // ── Open positions (unrealized PnL) ───────────────────────────
  const openPaper = Object.values(state.paperPositions || {}).filter(
    (p) => !p.closed
  );
  const openLive = Object.values(state.positions || {}).filter(
    (p) => !p.closed
  );
  const allOpen = [...openPaper, ...openLive];

  const unrealizedPnlUsd = openPaper.reduce(
    (s, p) => s + (p.pnl_usd || 0),
    0
  );
  const unrealizedFeesUsd = openPaper.reduce(
    (s, p) => s + (p.simulated_fees_usd || 0),
    0
  );
  const openValueUsd = openPaper.reduce(
    (s, p) => s + (p.initial_value_usd || 0) + (p.pnl_usd || 0),
    0
  );

  // Live position value (if available)
  const liveValueUsd = openLive.reduce(
    (s, p) => s + (p.total_value_usd || p.initial_value_usd || 0),
    0
  );
  const liveFeesUsd = openLive.reduce(
    (s, p) => s + (p.total_fees_claimed_usd || 0),
    0
  );

  // ── Deployed in last 24h ──────────────────────────────────────
  const deployedPaper = Object.values(state.paperPositions || {}).filter(
    (p) => new Date(p.deployed_at) > last24h
  );
  const deployedLive = Object.values(state.positions || {}).filter(
    (p) => new Date(p.deployed_at) > last24h
  );

  // ── Performance records from lessons.json (last 24h) ──────────
  const perfLast24h = (lessonsData.performance || []).filter(
    (p) => p.recorded_at && new Date(p.recorded_at) > last24h
  );
  const perfPnl = perfLast24h.reduce(
    (s, p) => s + (p.pnl_usd || 0),
    0
  );
  const perfFees = perfLast24h.reduce(
    (s, p) => s + (p.fees_earned_usd || 0),
    0
  );

  // ── Aggregate ─────────────────────────────────────────────────
  const totalPnlUsd = realizedPnlUsd + unrealizedPnlUsd;
  const totalFeesUsd = realizedFeesUsd + unrealizedFeesUsd + liveFeesUsd;
  const netPnlUsd = totalPnlUsd + totalFeesUsd;

  // ── Build closed position details ─────────────────────────────
  const closedDetails = allClosed.map((p) => ({
    pair: p.pair || p.pool_name || "?",
    pnl_usd: round(p.pnl_usd || p.total_return_usd || 0, 4),
    pnl_pct: round(p.pnl_pct || p.total_return_pct || 0, 2),
    fees_usd: round(
      p.simulated_fees_usd || p.fees_earned_usd || p.total_fees_claimed_usd || 0,
      4
    ),
    hold_minutes: p.minutes_held || 0,
    close_reason: p.close_reason || "unknown",
    paper: !!p.simulated_fees_usd || !!p.id?.startsWith?.("paper_"),
  }));

  const snapshot = {
    date: dateStr,
    snapshot_at: now.toISOString(),
    period_hours: 24,

    // Summary
    net_pnl_usd: round(netPnlUsd, 2),
    total_pnl_usd: round(totalPnlUsd, 2),
    total_fees_usd: round(totalFeesUsd, 2),

    // Realized (closed)
    realized: {
      pnl_usd: round(realizedPnlUsd, 2),
      fees_usd: round(realizedFeesUsd, 4),
      trades_closed: allClosed.length,
      wins: closedWins,
      losses: allClosed.length - closedWins,
      win_rate_pct: closedWinRate,
    },

    // Unrealized (open)
    unrealized: {
      pnl_usd: round(unrealizedPnlUsd, 2),
      fees_usd: round(unrealizedFeesUsd, 4),
      open_positions: allOpen.length,
      open_value_usd: round(openValueUsd + liveValueUsd, 2),
    },

    // Activity
    activity: {
      deployed: deployedPaper.length + deployedLive.length,
      closed: allClosed.length,
    },

    // Individual trades
    closed_positions: closedDetails,

    // Streak tracking
    is_green_day: netPnlUsd > 0,
  };

  // Append to history
  const history = loadPnlHistory();

  // Avoid duplicate snapshots for the same date — overwrite if same date exists
  const existingIdx = history.snapshots.findIndex((s) => s.date === dateStr);
  if (existingIdx >= 0) {
    history.snapshots[existingIdx] = snapshot;
    log("daily_pnl", `Updated existing snapshot for ${dateStr}`);
  } else {
    history.snapshots.push(snapshot);
    log("daily_pnl", `New daily snapshot for ${dateStr}`);
  }

  // Keep last 90 days max
  if (history.snapshots.length > 90) {
    history.snapshots = history.snapshots.slice(-90);
  }

  savePnlHistory(history);

  return snapshot;
}

// ─── Telegram Message Formatting ─────────────────────────────────

function fmtUsd(n) {
  if (n == null) return "?";
  return (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2);
}

function progressBar(pct, len = 10) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  const filled = Math.round(clamped / (100 / len));
  return "█".repeat(filled) + "░".repeat(len - filled);
}

function dayEmoji(netPnl) {
  if (netPnl > 5)   return "🔥";
  if (netPnl > 0)   return "📈";
  if (netPnl > -2)  return "😐";
  return "📉";
}

/**
 * Format a daily PnL snapshot as an HTML message for Telegram.
 *
 * @param {Object} snapshot - The snapshot record from takeDailySnapshot()
 * @returns {string} HTML-formatted Telegram message
 */
export function formatDailyPnlMessage(snapshot) {
  if (!snapshot) return "⚠️ No daily PnL data available.";

  const emoji = dayEmoji(snapshot.net_pnl_usd);
  const mode = process.env.DRY_RUN === "true" ? "📝 PAPER" : "🔴 LIVE";
  const L = [];

  L.push(`${emoji} <b>DAILY PnL REPORT</b>`);
  L.push(`<i>${snapshot.date}</i> • ${mode}`);
  L.push(``);

  // Net PnL headline
  const pnlSign = snapshot.net_pnl_usd >= 0 ? "+" : "-";
  L.push(`<b>Net PnL: ${pnlSign}$${Math.abs(snapshot.net_pnl_usd).toFixed(2)}</b>`);
  L.push(``);

  // Breakdown
  L.push(`━━━ 💰 <b>BREAKDOWN</b> ━━━`);
  L.push(``);
  L.push(`  Realized PnL:   ${fmtUsd(snapshot.realized.pnl_usd)}`);
  L.push(`  Unrealized PnL: ${fmtUsd(snapshot.unrealized.pnl_usd)}`);
  L.push(`  Fees Earned:    +$${snapshot.total_fees_usd.toFixed(2)}`);
  L.push(``);

  // Activity
  L.push(`━━━ 📊 <b>ACTIVITY</b> ━━━`);
  L.push(``);
  L.push(`  Deployed: ${snapshot.activity.deployed}`);
  L.push(`  Closed:   ${snapshot.activity.closed}`);

  if (snapshot.realized.win_rate_pct != null) {
    L.push(`  Win Rate: ${progressBar(snapshot.realized.win_rate_pct)} ${snapshot.realized.win_rate_pct}%`);
    L.push(`  W/L:      ${snapshot.realized.wins}/${snapshot.realized.losses}`);
  }
  L.push(``);

  // Open positions
  if (snapshot.unrealized.open_positions > 0) {
    L.push(`━━━ 💼 <b>OPEN</b> ━━━`);
    L.push(``);
    L.push(`  ${snapshot.unrealized.open_positions} position(s) | Value: $${snapshot.unrealized.open_value_usd.toFixed(2)}`);
    L.push(`  Unrealized: ${fmtUsd(snapshot.unrealized.pnl_usd)} | Fees: +$${snapshot.unrealized.fees_usd.toFixed(4)}`);
    L.push(``);
  }

  // Closed position details (top 5)
  if (snapshot.closed_positions && snapshot.closed_positions.length > 0) {
    L.push(`━━━ 📋 <b>TRADES</b> ━━━`);
    L.push(``);
    const sorted = [...snapshot.closed_positions].sort(
      (a, b) => (b.pnl_usd || 0) - (a.pnl_usd || 0)
    );
    for (const t of sorted) {
      const icon = t.pnl_usd >= 0 ? "🟢" : "🔴";
      const tag = t.paper ? " 📝" : "";
      L.push(`  ${icon} ${t.pair}${tag} | ${fmtUsd(t.pnl_usd)} (${t.pnl_pct}%) | ${t.hold_minutes}m`);
    }
    L.push(``);
  }

  // Streak
  const history = loadPnlHistory();
  const recentDays = history.snapshots.slice(-7);
  if (recentDays.length >= 2) {
    let streak = 0;
    const streakDir = snapshot.is_green_day ? "green" : "red";
    for (let i = recentDays.length - 1; i >= 0; i--) {
      if (recentDays[i].is_green_day === snapshot.is_green_day) streak++;
      else break;
    }
    if (streak > 1) {
      const icon = streakDir === "green" ? "🔥" : "❄️";
      L.push(`${icon} ${streak}-day ${streakDir} streak`);
      L.push(``);
    }

    // 7-day sparkline
    const sparkChars = recentDays.map((d) => (d.is_green_day ? "▲" : "▼"));
    L.push(`7d: ${sparkChars.join(" ")}`);
    const weekPnl = recentDays.reduce((s, d) => s + (d.net_pnl_usd || 0), 0);
    L.push(`7d PnL: ${fmtUsd(weekPnl)}`);
    L.push(``);
  }

  L.push(`<i>Meridian v1 • Daily snapshot</i>`);

  return L.join("\n");
}

// ─── Query Functions ─────────────────────────────────────────────

/**
 * Get the last N daily snapshots.
 */
export function getDailyPnlHistory(days = 7) {
  const history = loadPnlHistory();
  return history.snapshots.slice(-days);
}

/**
 * Get today's date string (YYYY-MM-DD UTC).
 */
export function getTodayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Check if a snapshot was already taken today.
 */
export function hasSnapshotToday() {
  const today = getTodayDateStr();
  const history = loadPnlHistory();
  return history.snapshots.some((s) => s.date === today);
}

/**
 * Get the date of the last snapshot.
 */
export function getLastSnapshotDate() {
  const history = loadPnlHistory();
  if (history.snapshots.length === 0) return null;
  return history.snapshots[history.snapshots.length - 1].date;
}

/**
 * Get cumulative PnL stats across all snapshots.
 */
export function getCumulativeStats() {
  const history = loadPnlHistory();
  const snaps = history.snapshots;
  if (snaps.length === 0) return null;

  const totalNetPnl = snaps.reduce((s, d) => s + (d.net_pnl_usd || 0), 0);
  const totalFees = snaps.reduce((s, d) => s + (d.total_fees_usd || 0), 0);
  const totalTrades = snaps.reduce((s, d) => s + (d.activity?.closed || 0), 0);
  const greenDays = snaps.filter((d) => d.is_green_day).length;
  const bestDay = snaps.reduce((best, d) =>
    (d.net_pnl_usd || 0) > (best?.net_pnl_usd || -Infinity) ? d : best
  , snaps[0]);
  const worstDay = snaps.reduce((worst, d) =>
    (d.net_pnl_usd || 0) < (worst?.net_pnl_usd || Infinity) ? d : worst
  , snaps[0]);

  return {
    total_days: snaps.length,
    total_net_pnl_usd: round(totalNetPnl, 2),
    total_fees_usd: round(totalFees, 2),
    total_trades: totalTrades,
    green_days: greenDays,
    red_days: snaps.length - greenDays,
    green_day_pct: Math.round((greenDays / snaps.length) * 100),
    avg_daily_pnl_usd: round(totalNetPnl / snaps.length, 2),
    best_day: bestDay ? { date: bestDay.date, pnl: bestDay.net_pnl_usd } : null,
    worst_day: worstDay ? { date: worstDay.date, pnl: worstDay.net_pnl_usd } : null,
  };
}

// ─── Daily Lessons ───────────────────────────────────────────────

/**
 * Generate a "lessons learned" summary from the latest daily snapshot.
 * Analyzes closed trades, patterns, and auto-derived lessons to produce
 * actionable takeaways that the operator can review on demand via /lesson.
 *
 * @param {Object} [options]
 * @param {string} [options.date] - Specific date (YYYY-MM-DD) to analyze, defaults to latest
 * @returns {string} HTML-formatted Telegram message
 */
export function formatDailyLessons({ date } = {}) {
  const history = loadPnlHistory();
  if (history.snapshots.length === 0) return "⚠️ No daily PnL data yet. Run /pnl first.";

  const snapshot = date
    ? history.snapshots.find((s) => s.date === date)
    : history.snapshots[history.snapshots.length - 1];

  if (!snapshot) return `⚠️ No snapshot found for ${date || "today"}.`;

  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };
  const closed = snapshot.closed_positions || [];
  const mode = process.env.DRY_RUN === "true" ? "📝 PAPER" : "🔴 LIVE";
  const L = [];

  // Escape HTML entities for safe Telegram rendering
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  L.push(`🧠 <b>DAILY LESSONS</b>`);
  L.push(`<i>${snapshot.date}</i> • ${mode}`);
  L.push(``);

  if (closed.length === 0) {
    L.push(`No closed trades to analyze.`);
    L.push(``);
    L.push(`<i>Meridian v1 • Lessons</i>`);
    return L.join("\n");
  }

  // ── Day Summary ─────────────────────────────────────────────────
  const wins = closed.filter((t) => (t.pnl_usd || 0) > 0);
  const losses = closed.filter((t) => (t.pnl_usd || 0) < 0);
  const totalFees = closed.reduce((s, t) => s + (t.fees_usd || 0), 0);
  const totalPnl = closed.reduce((s, t) => s + (t.pnl_usd || 0), 0);
  const netPnl = snapshot.net_pnl_usd;

  if (netPnl > 0 && totalPnl < 0) {
    L.push(`⚠️ <b>Fee-carried day.</b> Realized PnL was ${fmtUsd(totalPnl)} but fees (+$${totalFees.toFixed(2)}) saved the day. Without fees this is a red day.`);
  } else if (netPnl > 0) {
    L.push(`✅ <b>Green day.</b> Both PnL and fees contributed positively.`);
  } else {
    L.push(`❌ <b>Red day.</b> Losses exceeded fee income.`);
  }
  L.push(``);

  // ── Biggest Winner / Loser Analysis ─────────────────────────────
  const sorted = [...closed].sort((a, b) => (b.pnl_usd || 0) - (a.pnl_usd || 0));
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  L.push(`━━━ 🏆 <b>KEY TRADES</b> ━━━`);
  L.push(``);

  if (best && (best.pnl_usd || 0) > 0) {
    L.push(`  🥇 <b>${best.pair}</b> ${fmtUsd(best.pnl_usd)} (${best.pnl_pct}%) | ${best.hold_minutes}m`);
    L.push(`     ${esc(best.close_reason)}`);
    if (best.pnl_pct > 20) {
      L.push(`     💡 Outlier win — this single trade carried ${Math.round(((best.pnl_usd || 0) / Math.max(netPnl, 0.01)) * 100)}% of net PnL`);
    }
  }

  if (worst && (worst.pnl_usd || 0) < 0) {
    L.push(`  💀 <b>${worst.pair}</b> ${fmtUsd(worst.pnl_usd)} (${worst.pnl_pct}%) | ${worst.hold_minutes}m`);
    L.push(`     ${esc(worst.close_reason)}`);
    if (worst.hold_minutes > 600) {
      L.push(`     💡 Held ${Math.round(worst.hold_minutes / 60)}h before stop loss fired — check poll frequency and SL threshold`);
    }
    if (Math.abs(worst.pnl_pct) > 30) {
      L.push(`     💡 Loss exceeded -30%. Consider tighter stop loss or faster exit checks`);
    }
  }
  L.push(``);

  // ── Pattern Detection ───────────────────────────────────────────
  const patterns = [];

  // 1. Repeat pool entries (same token traded multiple times)
  const tokenCounts = {};
  for (const t of closed) {
    const token = (t.pair || "").split("-")[0];
    if (!tokenCounts[token]) tokenCounts[token] = { count: 0, wins: 0, losses: 0, totalPnl: 0 };
    tokenCounts[token].count++;
    tokenCounts[token].totalPnl += (t.pnl_usd || 0);
    if ((t.pnl_usd || 0) > 0) tokenCounts[token].wins++;
    else tokenCounts[token].losses++;
  }
  const repeats = Object.entries(tokenCounts).filter(([, v]) => v.count > 1);
  for (const [token, data] of repeats) {
    const netSign = data.totalPnl >= 0 ? "+" : "";
    if (data.wins > 0 && data.losses > 0) {
      patterns.push(`🔄 <b>${token}</b> traded ${data.count}x — mixed results (${data.wins}W/${data.losses}L, net ${netSign}$${Math.abs(data.totalPnl).toFixed(2)}). Re-entry after a win on same pool is risky.`);
    } else if (data.losses > 1) {
      patterns.push(`🔄 <b>${token}</b> traded ${data.count}x — all losses (net ${netSign}$${Math.abs(data.totalPnl).toFixed(2)}). Should have blacklisted after first loss.`);
    } else if (data.wins > 1) {
      patterns.push(`🔄 <b>${token}</b> traded ${data.count}x — all profitable (net ${netSign}$${Math.abs(data.totalPnl).toFixed(2)}). Good repeat target.`);
    }
  }

  // 2. Stop loss exits
  const slExits = closed.filter((t) => /stop.?loss/i.test(t.close_reason || ""));
  if (slExits.length > 0) {
    const avgSlPct = slExits.reduce((s, t) => s + Math.abs(t.pnl_pct || 0), 0) / slExits.length;
    const avgSlHold = Math.round(slExits.reduce((s, t) => s + (t.hold_minutes || 0), 0) / slExits.length);
    patterns.push(`🛑 ${slExits.length} stop loss exit${slExits.length > 1 ? "s" : ""} — avg loss -${avgSlPct.toFixed(1)}%, avg hold ${avgSlHold}m`);
    if (avgSlHold > 300) {
      patterns.push(`   ⏱️ Avg hold before SL is ${Math.round(avgSlHold / 60)}h — positions are bleeding slowly. Consider adding a time-based exit rule.`);
    }
  }

  // 3. Quick exits (< 30m hold)
  const quickExits = closed.filter((t) => (t.hold_minutes || 0) < 30);
  if (quickExits.length >= 2) {
    const quickWins = quickExits.filter((t) => (t.pnl_usd || 0) > 0).length;
    patterns.push(`⚡ ${quickExits.length} quick exit${quickExits.length > 1 ? "s" : ""} (&lt;30m) — ${quickWins}/${quickExits.length} profitable. ${quickWins > quickExits.length / 2 ? "Fast cycles are working." : "Too much churn — positions closing before fees accumulate."}`);
  }

  // 4. OOR exits
  const oorExits = closed.filter((t) => /out.?of.?range|oor/i.test(t.close_reason || ""));
  if (oorExits.length > 0) {
    const oorProfitable = oorExits.filter((t) => (t.pnl_usd || 0) > 0).length;
    patterns.push(`📐 ${oorExits.length} OOR exit${oorExits.length > 1 ? "s" : ""} — ${oorProfitable}/${oorExits.length} were still profitable. ${oorProfitable === oorExits.length ? "OOR exits are fine — price moved in our favor." : "Need wider bin ranges to stay in range longer."}`);
  }

  // 5. Fee/IL ratio
  if (totalFees > 0 && Math.abs(totalPnl) > 0) {
    const feeIlRatio = totalFees / Math.max(Math.abs(totalPnl), 0.01);
    if (feeIlRatio > 2) {
      patterns.push(`💰 Fee income is ${feeIlRatio.toFixed(1)}x the IL — fee strategy is strong.`);
    } else if (feeIlRatio < 0.5 && totalPnl < 0) {
      patterns.push(`💸 Fees only cover ${Math.round(feeIlRatio * 100)}% of losses — need higher fee/TVL pools or tighter ranges.`);
    }
  }

  if (patterns.length > 0) {
    L.push(`━━━ 🔍 <b>PATTERNS</b> ━━━`);
    L.push(``);
    for (const p of patterns) {
      L.push(`  ${p}`);
    }
    L.push(``);
  }

  // ── Auto-derived lessons from lessons.json (last 24h) ───────────
  const snapshotTime = new Date(snapshot.snapshot_at);
  const last24h = new Date(snapshotTime.getTime() - 24 * 60 * 60 * 1000);
  const recentLessons = (lessonsData.lessons || []).filter(
    (l) => l.created_at && new Date(l.created_at) > last24h && l.sourceType === "performance"
  );

  if (recentLessons.length > 0) {
    L.push(`━━━ 📚 <b>AUTO-DERIVED</b> ━━━`);
    L.push(``);
    const displayed = recentLessons.slice(-5); // Show last 5
    for (const l of displayed) {
      const icon = l.outcome === "good" ? "✅" : l.outcome === "bad" ? "❌" : "ℹ️";
      // Truncate long rules for Telegram readability
      const ruleShort = l.rule.length > 120 ? l.rule.slice(0, 117) + "..." : l.rule;
      L.push(`  ${icon} ${esc(ruleShort)}`);
    }
    if (recentLessons.length > 5) {
      L.push(`  ... +${recentLessons.length - 5} more`);
    }
    L.push(``);
  }

  // ── Key Takeaway (1-2 sentences) ────────────────────────────────
  L.push(`━━━ 💡 <b>TAKEAWAY</b> ━━━`);
  L.push(``);

  const takeaways = [];

  // Generate contextual takeaway based on the day's data
  if (losses.length > wins.length) {
    takeaways.push("More losses than wins today. Focus on pool selection quality over quantity.");
  }
  if (slExits.length >= 2 && slExits.some((t) => (t.hold_minutes || 0) > 600)) {
    takeaways.push("Slow stop losses are bleeding capital. Consider tighter SL or adding a max-hold-time rule.");
  }
  if (repeats.some(([, v]) => v.wins > 0 && v.losses > 0)) {
    takeaways.push("Re-entering the same pool after a win led to losses. Add a cooldown before re-deploying to the same token.");
  }
  if (best && (best.pnl_pct || 0) > 20 && wins.length <= 2) {
    takeaways.push("Day was carried by one outlier trade. Can't rely on moonshots — need more consistent small wins.");
  }
  if (totalPnl < 0 && totalFees > Math.abs(totalPnl)) {
    takeaways.push("Fees saved a losing day. The fee-earning strategy works but entry selection needs improvement.");
  }

  if (takeaways.length === 0) {
    takeaways.push("Solid execution today. Keep monitoring position sizing and fee/TVL ratios.");
  }

  for (const t of takeaways.slice(0, 3)) {
    L.push(`  ${t}`);
  }
  L.push(``);

  L.push(`<i>Meridian v1 • Lessons</i>`);

  return L.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────

function round(n, decimals = 2) {
  if (n == null || !Number.isFinite(n)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}
