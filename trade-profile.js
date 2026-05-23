/**
 * Trade Profile — Statistical learning from closed positions.
 *
 * Builds a data-driven profile from all trade history and:
 *   1. Auto-tunes risk parameters (stopLoss, TP, hold time, trailing)
 *   2. Generates a structured "trade profile" block injected into LLM prompts
 *   3. Identifies statistical patterns the LLM can act on
 *
 * Unlike text lessons (soft guidance), this produces hard numbers
 * the agent can reference for screening and management decisions.
 */

import fs from "fs";
import { log } from "./logger.js";

const LESSONS_FILE = "./lessons.json";
const PROFILE_FILE = "./trade-profile.json";

function loadPerf() {
  try {
    if (!fs.existsSync(LESSONS_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    return data.performance || [];
  } catch { return []; }
}

function loadProfile() {
  try {
    if (!fs.existsSync(PROFILE_FILE)) return null;
    return JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));
  } catch { return null; }
}

function saveProfile(profile) {
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
}

// ─── Bucketing helpers ───────────────────────────────────────────

function bucket(value, breakpoints, labels) {
  for (let i = 0; i < breakpoints.length; i++) {
    if (value <= breakpoints[i]) return labels[i];
  }
  return labels[labels.length - 1];
}

function holdTimeBucket(minutes) {
  return bucket(minutes, [15, 30, 60, 120, 180],
    ["0-15m", "15-30m", "30-60m", "1-2h", "2-3h", ">3h"]);
}

function mcapBucket(mcap) {
  if (mcap == null) return "unknown";
  return bucket(mcap, [100_000, 500_000, 1_000_000, 5_000_000],
    ["<100k", "100k-500k", "500k-1M", "1M-5M", ">5M"]);
}

function volatilityBucket(vol) {
  if (vol == null) return "unknown";
  return bucket(vol, [1, 2, 3, 5],
    ["very_low(<1)", "low(1-2)", "mid(2-3)", "high(3-5)", "extreme(>5)"]);
}

function hourBucket(isoString) {
  try {
    const h = new Date(isoString).getUTCHours();
    if (h < 6) return "00-06 UTC";
    if (h < 12) return "06-12 UTC";
    if (h < 18) return "12-18 UTC";
    return "18-24 UTC";
  } catch { return "unknown"; }
}

// ─── Core analysis ───────────────────────────────────────────────

function analyzeByBucket(perfs, bucketFn, fieldName) {
  const buckets = {};
  for (const p of perfs) {
    const key = bucketFn(p[fieldName] ?? p);
    if (!buckets[key]) buckets[key] = { count: 0, wins: 0, total_pnl: 0, total_fees: 0 };
    buckets[key].count++;
    if (p.pnl_pct > 0) buckets[key].wins++;
    buckets[key].total_pnl += (p.pnl_usd || 0);
    buckets[key].total_fees += (p.fees_earned_usd || 0);
  }
  // Compute win rates
  for (const b of Object.values(buckets)) {
    b.win_rate = b.count > 0 ? Math.round((b.wins / b.count) * 100) : 0;
    b.avg_pnl = b.count > 0 ? Math.round((b.total_pnl / b.count) * 100) / 100 : 0;
  }
  return buckets;
}

function findOptimalRange(bucketData, minSamples = 3) {
  let best = null;
  let bestRate = -1;
  for (const [key, data] of Object.entries(bucketData)) {
    if (data.count >= minSamples && data.win_rate > bestRate) {
      bestRate = data.win_rate;
      best = { bucket: key, ...data };
    }
  }
  return best;
}

function findWorstRange(bucketData, minSamples = 3) {
  let worst = null;
  let worstRate = 101;
  for (const [key, data] of Object.entries(bucketData)) {
    if (data.count >= minSamples && data.win_rate < worstRate) {
      worstRate = data.win_rate;
      worst = { bucket: key, ...data };
    }
  }
  return worst;
}

// ─── Strategy analysis ───────────────────────────────────────────

function analyzeStrategies(perfs) {
  const strategies = {};
  for (const p of perfs) {
    const s = p.strategy || "unknown";
    if (!strategies[s]) strategies[s] = { count: 0, wins: 0, total_pnl: 0, total_fees: 0 };
    strategies[s].count++;
    if (p.pnl_pct > 0) strategies[s].wins++;
    strategies[s].total_pnl += (p.pnl_usd || 0);
    strategies[s].total_fees += (p.fees_earned_usd || 0);
  }
  for (const s of Object.values(strategies)) {
    s.win_rate = s.count > 0 ? Math.round((s.wins / s.count) * 100) : 0;
    s.avg_pnl = s.count > 0 ? Math.round((s.total_pnl / s.count) * 100) / 100 : 0;
  }
  return strategies;
}

// ─── Close reason analysis ───────────────────────────────────────

function analyzeCloseReasons(perfs) {
  const reasons = {};
  for (const p of perfs) {
    const raw = String(p.close_reason || "unknown").toLowerCase();
    let cat = "other";
    if (/stop.?loss/i.test(raw)) cat = "stop_loss";
    else if (/trailing/i.test(raw)) cat = "trailing_tp";
    else if (/take.?profit/i.test(raw)) cat = "take_profit";
    else if (/out.?of.?range|oor/i.test(raw)) cat = "oor";
    else if (/low.?yield/i.test(raw)) cat = "low_yield";
    else if (/max.?hold|time/i.test(raw)) cat = "max_hold";

    if (!reasons[cat]) reasons[cat] = { count: 0, avg_pnl: 0, total_pnl: 0, avg_fees: 0, total_fees: 0 };
    reasons[cat].count++;
    reasons[cat].total_pnl += (p.pnl_usd || 0);
    reasons[cat].total_fees += (p.fees_earned_usd || 0);
  }
  for (const r of Object.values(reasons)) {
    r.avg_pnl = r.count > 0 ? Math.round((r.total_pnl / r.count) * 100) / 100 : 0;
    r.avg_fees = r.count > 0 ? Math.round((r.total_fees / r.count) * 100) / 100 : 0;
  }
  return reasons;
}

// ─── Fee recovery analysis ───────────────────────────────────────

function analyzeFeeRecovery(perfs) {
  if (perfs.length === 0) return null;
  let feesCoverIL = 0;
  let totalFees = 0;
  let totalIL = 0;

  for (const p of perfs) {
    const fees = p.fees_earned_usd || 0;
    const il = Math.min(0, p.pnl_usd || 0); // only count negative pnl as IL
    totalFees += fees;
    totalIL += Math.abs(il);
    if (fees >= Math.abs(il) && il < 0) feesCoverIL++;
  }

  const losers = perfs.filter(p => (p.pnl_usd || 0) < 0);
  return {
    fee_recovery_rate: losers.length > 0 ? Math.round((feesCoverIL / losers.length) * 100) : 100,
    total_fees_earned: Math.round(totalFees * 100) / 100,
    total_il_absorbed: Math.round(totalIL * 100) / 100,
    fees_vs_il_ratio: totalIL > 0 ? Math.round((totalFees / totalIL) * 100) / 100 : null,
  };
}

// ─── Optimal parameter suggestions ──────────────────────────────

function suggestRiskParams(perfs, currentConfig) {
  if (perfs.length < 10) return null;

  const suggestions = {};
  const rationale = {};

  // Skip params that are manually locked (prevent auto-tuner from overriding manual strategy changes)
  const locked = new Set(currentConfig._lockedParams || []);

  // ── Stop loss optimization ──
  // Find the PnL at which losses become unrecoverable (fees never cover it)
  const losers = perfs.filter(p => p.pnl_pct < 0).sort((a, b) => a.pnl_pct - b.pnl_pct);
  if (!locked.has("stopLossPct") && losers.length >= 3) {
    // Find the threshold where losses that went deeper rarely recovered
    const deepLosses = losers.filter(p => p.pnl_pct <= currentConfig.stopLossPct);
    const shallowLosses = losers.filter(p => p.pnl_pct > currentConfig.stopLossPct);
    
    // If most losses hit the stop loss exactly, it might be too tight
    const avgLossPnl = losers.reduce((s, p) => s + p.pnl_pct, 0) / losers.length;
    const p25Loss = losers[Math.floor(losers.length * 0.25)]?.pnl_pct;

    if (p25Loss != null) {
      // Suggest SL at the 25th percentile of losses (where 75% of losses are shallower)
      const suggestedSL = Math.round(Math.max(-15, Math.min(-2, p25Loss * 1.1)) * 10) / 10;
      if (Math.abs(suggestedSL - currentConfig.stopLossPct) > 0.5) {
        suggestions.stopLossPct = suggestedSL;
        rationale.stopLossPct = `25th percentile of losses at ${p25Loss.toFixed(1)}% — suggests ${suggestedSL}% (current: ${currentConfig.stopLossPct}%)`;
      }
    }
  }

  // ── Take profit optimization ──
  const winners = perfs.filter(p => p.pnl_pct > 0).sort((a, b) => b.pnl_pct - a.pnl_pct);
  if (!locked.has("takeProfitPct") && winners.length >= 3) {
    // Median winner PnL — suggests realistic TP target
    const medianWinPnl = winners[Math.floor(winners.length / 2)]?.pnl_pct;
    if (medianWinPnl != null) {
      // Floor at 1.8% — must stay below trailingTriggerPct so trailing TP can activate
      const tpFloor = Math.max(1.8, (currentConfig.trailingTriggerPct ?? 4) - 1.5);
      const suggestedTP = Math.round(Math.max(tpFloor, Math.min(15, medianWinPnl * 0.8)) * 10) / 10;
      if (Math.abs(suggestedTP - currentConfig.takeProfitPct) > 0.5) {
        suggestions.takeProfitPct = suggestedTP;
        rationale.takeProfitPct = `Median winner at ${medianWinPnl.toFixed(1)}% — suggests TP at ${suggestedTP}% (current: ${currentConfig.takeProfitPct}%, floor: ${tpFloor}%)`;
      }
    }
  }

  // ── Hold time optimization ──
  const holdPerfs = perfs.filter(p => p.minutes_held != null && p.minutes_held > 0);
  if (!locked.has("maxHoldMinutes") && holdPerfs.length >= 5) {
    const holdByBucket = analyzeByBucket(holdPerfs, holdTimeBucket, "minutes_held");
    const bestHold = findOptimalRange(holdByBucket, 3);
    const worstHold = findWorstRange(holdByBucket, 3);

    if (worstHold && worstHold.win_rate < 30) {
      // Parse the worst bucket to get a max hold suggestion
      const worstKey = worstHold.bucket;
      const holdLimits = { ">3h": 180, "2-3h": 120, "1-2h": 60, "30-60m": 30, "15-30m": 15 };
      const suggestedMaxHold = holdLimits[worstKey];
      if (suggestedMaxHold && (!currentConfig.maxHoldMinutes || suggestedMaxHold < currentConfig.maxHoldMinutes)) {
        suggestions.maxHoldMinutes = suggestedMaxHold;
        rationale.maxHoldMinutes = `Positions held ${worstKey} have ${worstHold.win_rate}% win rate — cap at ${suggestedMaxHold}m`;
      }
    }
  }

  // ── Trailing drop optimization ──
  if (!locked.has("trailingDropPct") && winners.length >= 5) {
    const trailingCloses = perfs.filter(p =>
      /trailing/i.test(p.close_reason || "") && p.pnl_pct > 0
    );
    if (trailingCloses.length >= 3) {
      // Average winner PnL on trailing closes — if they're all low, drop% might be too tight
      const avgTrailingPnl = trailingCloses.reduce((s, p) => s + p.pnl_pct, 0) / trailingCloses.length;
      if (avgTrailingPnl < currentConfig.trailingTriggerPct * 0.5) {
        // Trailing is capturing too little — tighten the drop
        const suggestedDrop = Math.round(Math.max(0.5, currentConfig.trailingDropPct * 0.8) * 10) / 10;
        if (suggestedDrop !== currentConfig.trailingDropPct) {
          suggestions.trailingDropPct = suggestedDrop;
          rationale.trailingDropPct = `Trailing exits avg ${avgTrailingPnl.toFixed(1)}% — tighten drop to ${suggestedDrop}% (current: ${currentConfig.trailingDropPct}%)`;
        }
      }
    }
  }

  if (Object.keys(suggestions).length === 0) return null;
  return { suggestions, rationale };
}

// ─── Recent trend analysis (yesterday focus) ─────────────────────

function analyzeRecentTrend(perfs, hours = 24) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const recent = perfs.filter(p => (p.recorded_at || p.closed_at || "") >= cutoff);
  const older = perfs.filter(p => (p.recorded_at || p.closed_at || "") < cutoff);

  if (recent.length === 0) return null;

  const recentWinRate = recent.length > 0
    ? Math.round((recent.filter(p => p.pnl_pct > 0).length / recent.length) * 100) : 0;
  const olderWinRate = older.length >= 5
    ? Math.round((older.filter(p => p.pnl_pct > 0).length / older.length) * 100) : null;

  const recentAvgPnl = recent.reduce((s, p) => s + (p.pnl_pct || 0), 0) / recent.length;
  const olderAvgPnl = older.length >= 5
    ? older.reduce((s, p) => s + (p.pnl_pct || 0), 0) / older.length : null;

  // Identify repeat losers (same token lost multiple times recently)
  const tokenLosses = {};
  for (const p of recent) {
    if (p.pnl_pct >= 0) continue;
    const token = (p.pool_name || "").split("-")[0];
    if (!token) continue;
    if (!tokenLosses[token]) tokenLosses[token] = { count: 0, total_loss: 0 };
    tokenLosses[token].count++;
    tokenLosses[token].total_loss += p.pnl_usd || 0;
  }
  const repeatLosers = Object.entries(tokenLosses)
    .filter(([, d]) => d.count >= 2)
    .map(([token, d]) => ({ token, ...d }));

  return {
    period_hours: hours,
    trades: recent.length,
    win_rate: recentWinRate,
    avg_pnl_pct: Math.round(recentAvgPnl * 100) / 100,
    total_pnl: Math.round(recent.reduce((s, p) => s + (p.pnl_usd || 0), 0) * 100) / 100,
    trend: olderWinRate != null ? (recentWinRate > olderWinRate + 5 ? "improving" : recentWinRate < olderWinRate - 5 ? "declining" : "stable") : "insufficient_data",
    win_rate_change: olderWinRate != null ? recentWinRate - olderWinRate : null,
    repeat_losers: repeatLosers,
  };
}

// ═════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═════════════════════════════════════════════════════════════════

/**
 * Build or refresh the trade profile from all performance data.
 * Called after each trade close and on startup.
 */
export function buildTradeProfile() {
  const perfs = loadPerf();
  if (perfs.length < 5) return null;

  const profile = {
    generated_at: new Date().toISOString(),
    total_trades: perfs.length,

    // Overall stats
    overall: {
      win_rate: Math.round((perfs.filter(p => p.pnl_pct > 0).length / perfs.length) * 100),
      avg_pnl_pct: Math.round((perfs.reduce((s, p) => s + (p.pnl_pct || 0), 0) / perfs.length) * 100) / 100,
      avg_fees_usd: Math.round((perfs.reduce((s, p) => s + (p.fees_earned_usd || 0), 0) / perfs.length) * 100) / 100,
      avg_hold_minutes: perfs.filter(p => p.minutes_held).length > 0
        ? Math.round(perfs.filter(p => p.minutes_held).reduce((s, p) => s + p.minutes_held, 0) / perfs.filter(p => p.minutes_held).length)
        : null,
    },

    // Pattern analysis
    by_hold_time: analyzeByBucket(perfs.filter(p => p.minutes_held), holdTimeBucket, "minutes_held"),
    by_volatility: analyzeByBucket(perfs.filter(p => p.volatility != null), volatilityBucket, "volatility"),
    by_time_of_day: analyzeByBucket(perfs.filter(p => p.recorded_at), hourBucket, "recorded_at"),
    by_strategy: analyzeStrategies(perfs),
    by_close_reason: analyzeCloseReasons(perfs),
    fee_recovery: analyzeFeeRecovery(perfs),

    // Best/worst zones
    best_hold_time: findOptimalRange(analyzeByBucket(perfs.filter(p => p.minutes_held), holdTimeBucket, "minutes_held")),
    worst_hold_time: findWorstRange(analyzeByBucket(perfs.filter(p => p.minutes_held), holdTimeBucket, "minutes_held")),
    best_volatility: findOptimalRange(analyzeByBucket(perfs.filter(p => p.volatility != null), volatilityBucket, "volatility")),
    worst_volatility: findWorstRange(analyzeByBucket(perfs.filter(p => p.volatility != null), volatilityBucket, "volatility")),

    // Recent trend
    last_24h: analyzeRecentTrend(perfs, 24),
    last_48h: analyzeRecentTrend(perfs, 48),
  };

  saveProfile(profile);
  return profile;
}

/**
 * Suggest risk parameter adjustments based on trade data.
 * Returns null if not enough data, or { suggestions, rationale }.
 */
export function suggestParamTuning(currentManagementConfig) {
  const perfs = loadPerf();
  return suggestRiskParams(perfs, currentManagementConfig);
}

/**
 * Apply suggested parameter tuning to user-config.json.
 * Only applies changes that differ meaningfully from current values.
 */
export function applyParamTuning(currentManagementConfig) {
  const result = suggestParamTuning(currentManagementConfig);
  if (!result) return { applied: false, reason: "Not enough data or no improvements found" };

  const { suggestions, rationale } = result;
  const USER_CONFIG_PATH = "./user-config.json";

  try {
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    }

    const applied = {};
    for (const [key, value] of Object.entries(suggestions)) {
      userConfig[key] = value;
      applied[key] = value;
    }

    userConfig._lastProfileTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    log("trade_profile", `Applied param tuning: ${JSON.stringify(applied)}`);
    return { applied: true, changes: applied, rationale };
  } catch (e) {
    log("trade_profile_error", `Failed to apply tuning: ${e.message}`);
    return { applied: false, reason: e.message };
  }
}

/**
 * Format the trade profile as a compact text block for LLM prompt injection.
 * This is the key output — gives the LLM precise data to make decisions.
 */
export function getTradeProfileForPrompt() {
  let profile = loadProfile();

  // Rebuild if stale (>1h old) or missing
  if (!profile || !profile.generated_at ||
      (Date.now() - new Date(profile.generated_at).getTime()) > 60 * 60 * 1000) {
    profile = buildTradeProfile();
  }

  if (!profile) return null;

  const lines = [];
  lines.push(`TRADE PROFILE (${profile.total_trades} closed trades)`);

  // Overall
  const o = profile.overall;
  lines.push(`Overall: ${o.win_rate}% win rate | avg PnL ${o.avg_pnl_pct}% | avg fees $${o.avg_fees_usd}${o.avg_hold_minutes ? ` | avg hold ${o.avg_hold_minutes}m` : ""}`);

  // Best/worst patterns
  if (profile.best_hold_time) {
    lines.push(`Best hold time: ${profile.best_hold_time.bucket} (${profile.best_hold_time.win_rate}% win, ${profile.best_hold_time.count} trades)`);
  }
  if (profile.worst_hold_time) {
    lines.push(`Worst hold time: ${profile.worst_hold_time.bucket} (${profile.worst_hold_time.win_rate}% win, ${profile.worst_hold_time.count} trades) — AVOID holding this long`);
  }
  if (profile.best_volatility) {
    lines.push(`Best volatility: ${profile.best_volatility.bucket} (${profile.best_volatility.win_rate}% win, ${profile.best_volatility.count} trades)`);
  }
  if (profile.worst_volatility) {
    lines.push(`Worst volatility: ${profile.worst_volatility.bucket} (${profile.worst_volatility.win_rate}% win, ${profile.worst_volatility.count} trades) — AVOID`);
  }

  // Strategy comparison
  const strats = Object.entries(profile.by_strategy || {})
    .filter(([, d]) => d.count >= 3)
    .sort((a, b) => b[1].win_rate - a[1].win_rate);
  if (strats.length > 0) {
    lines.push(`Strategies: ${strats.map(([s, d]) => `${s} ${d.win_rate}%W (${d.count})`).join(" | ")}`);
  }

  // Close reason stats
  const reasons = Object.entries(profile.by_close_reason || {})
    .filter(([, d]) => d.count >= 2)
    .sort((a, b) => b[1].count - a[1].count);
  if (reasons.length > 0) {
    lines.push(`Exit breakdown: ${reasons.map(([r, d]) => `${r}: ${d.count}x avg ${d.avg_pnl >= 0 ? "+" : ""}$${d.avg_pnl}`).join(" | ")}`);
  }

  // Fee recovery
  if (profile.fee_recovery) {
    const fr = profile.fee_recovery;
    lines.push(`Fee recovery: ${fr.fee_recovery_rate}% of losses covered by fees | fees $${fr.total_fees_earned} vs IL $${fr.total_il_absorbed}${fr.fees_vs_il_ratio != null ? ` (ratio: ${fr.fees_vs_il_ratio})` : ""}`);
  }

  // Recent trend
  if (profile.last_24h) {
    const t = profile.last_24h;
    lines.push(`Last 24h: ${t.trades} trades, ${t.win_rate}% win rate, ${t.avg_pnl_pct >= 0 ? "+" : ""}${t.avg_pnl_pct}% avg, trend: ${t.trend}${t.win_rate_change != null ? ` (${t.win_rate_change >= 0 ? "+" : ""}${t.win_rate_change}% vs prior)` : ""}`);
    if (t.repeat_losers.length > 0) {
      lines.push(`⚠️ Repeat losers (24h): ${t.repeat_losers.map(r => `${r.token} (${r.count}x, $${r.total_loss.toFixed(2)})`).join(", ")} — AVOID re-entering these`);
    }
  }

  // Time-of-day patterns
  const timeSlots = Object.entries(profile.by_time_of_day || {})
    .filter(([, d]) => d.count >= 3)
    .sort((a, b) => b[1].win_rate - a[1].win_rate);
  if (timeSlots.length >= 2) {
    const best = timeSlots[0];
    const worst = timeSlots[timeSlots.length - 1];
    if (best[1].win_rate - worst[1].win_rate >= 15) {
      lines.push(`Time pattern: best ${best[0]} (${best[1].win_rate}%W) | worst ${worst[0]} (${worst[1].win_rate}%W)`);
    }
  }

  return lines.join("\n");
}
