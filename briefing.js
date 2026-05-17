import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";
const DECISION_LOG_FILE = "./decision-log.json";

function progressBar(pct, len = 10) {
  const filled = Math.round(Math.max(0, Math.min(100, pct)) / 100 * len);
  return "█".repeat(filled) + "░".repeat(len - filled);
}

function healthGrade(winRate, totalClosed) {
  if (totalClosed < 3) return { grade: "?", label: "Too early to grade" };
  if (winRate >= 75) return { grade: "A+", label: "Exceptional" };
  if (winRate >= 60) return { grade: "A", label: "Strong" };
  if (winRate >= 50) return { grade: "B", label: "Solid" };
  if (winRate >= 35) return { grade: "C", label: "Needs work" };
  return { grade: "D", label: "Struggling" };
}

function greeting(pnl, closed) {
  if (closed === 0) return "☕ Quiet day — no closes yesterday.";
  if (pnl > 5) return "🔥 On fire! Great day for the bot.";
  if (pnl > 0) return "📈 Green day. Fees are stacking.";
  if (pnl > -2) return "😐 Flat day. Grinding it out.";
  return "📉 Rough patch. The bot is learning from it.";
}

function fmtUsd(n) {
  if (n == null) return "?";
  return (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2);
}

function fmtPct(n) {
  if (n == null) return "?";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

// ── Educational insights based on actual trading data ────────────

function getCloseReasonBreakdown(closedPositions) {
  const reasons = {};
  for (const p of closedPositions) {
    const reason = p.close_reason || p.reason || "unknown";
    let category = "other";
    if (/stop.?loss/i.test(reason)) category = "stop_loss";
    else if (/take.?profit/i.test(reason)) category = "take_profit";
    else if (/trailing/i.test(reason)) category = "trailing_tp";
    else if (/out.?of.?range|oor/i.test(reason)) category = "oor";
    else if (/low.?yield/i.test(reason)) category = "low_yield";

    if (!reasons[category]) reasons[category] = { count: 0, total_pnl: 0, total_fees: 0 };
    reasons[category].count++;
    reasons[category].total_pnl += (p.pnl_usd || 0);
    reasons[category].total_fees += (p.fees_usd || p.simulated_fees_usd || p.fees_earned_usd || 0);
  }
  return reasons;
}

function getAverageHoldTime(closedPositions) {
  if (closedPositions.length === 0) return null;
  const totalMinutes = closedPositions.reduce((s, p) => s + (p.minutes_held || 0), 0);
  return Math.round(totalMinutes / closedPositions.length);
}

function getBestStrategy(closedPositions) {
  const strategies = {};
  for (const p of closedPositions) {
    const strat = p.strategy || "unknown";
    if (!strategies[strat]) strategies[strat] = { count: 0, wins: 0, total_return: 0 };
    strategies[strat].count++;
    if ((p.total_return_usd || p.pnl_usd || 0) > 0) strategies[strat].wins++;
    strategies[strat].total_return += (p.total_return_usd || p.pnl_usd || 0);
  }
  let best = null;
  let bestRate = -1;
  for (const [name, data] of Object.entries(strategies)) {
    const rate = data.count > 0 ? data.wins / data.count : 0;
    if (rate > bestRate || (rate === bestRate && data.count > (best?.count || 0))) {
      bestRate = rate;
      best = { name, ...data, winRate: Math.round(rate * 100) };
    }
  }
  return best;
}

function generateLPInsight(closedPositions, openPositions) {
  const insights = [];

  // Insight: OOR analysis
  const oorCloses = closedPositions.filter(p =>
    /out.?of.?range|oor/i.test(p.close_reason || p.reason || "")
  );
  if (oorCloses.length > 0) {
    const oorPct = Math.round((oorCloses.length / closedPositions.length) * 100);
    const oorAvgPnl = oorCloses.reduce((s, p) => s + (p.pnl_usd || 0), 0) / oorCloses.length;
    if (oorPct > 40) {
      insights.push(`⚠️ ${oorPct}% of closes were OOR (avg PnL ${fmtUsd(oorAvgPnl)}). Consider wider bin ranges or more volatile pools.`);
    } else {
      insights.push(`📐 OOR closes: ${oorPct}% — range sizing is decent.`);
    }
  }

  // Insight: Fee vs IL
  const totalFees = closedPositions.reduce((s, p) => s + (p.fees_usd || p.simulated_fees_usd || p.fees_earned_usd || 0), 0);
  const totalIL = closedPositions.reduce((s, p) => s + (p.pnl_usd || 0), 0);
  if (closedPositions.length > 0) {
    if (totalFees > Math.abs(totalIL)) {
      insights.push(`✅ Fees ($${totalFees.toFixed(2)}) &gt; IL ($${Math.abs(totalIL).toFixed(2)}). The core LP strategy is working.`);
    } else {
      insights.push(`❌ IL ($${Math.abs(totalIL).toFixed(2)}) &gt; Fees ($${totalFees.toFixed(2)}). Need better pool selection or tighter ranges.`);
    }
  }

  // Insight: Position concentration
  const poolCounts = {};
  for (const p of openPositions) {
    const pair = p.pair || p.pool_name || "unknown";
    const token = pair.split("-")[0];
    poolCounts[token] = (poolCounts[token] || 0) + 1;
  }
  const duplicates = Object.entries(poolCounts).filter(([, c]) => c > 1);
  if (duplicates.length > 0) {
    insights.push(`⚠️ Concentrated: ${duplicates.map(([t, c]) => `${t} (${c}x)`).join(", ")}. Diversify for better risk management.`);
  }

  // Insight: Average hold time
  const avgHold = getAverageHoldTime(closedPositions);
  if (avgHold != null) {
    if (avgHold < 20) {
      insights.push(`⏱️ Avg hold: ${avgHold}m — very short. Positions might be closing before fees accumulate.`);
    } else if (avgHold > 180) {
      insights.push(`⏱️ Avg hold: ${avgHold}m — consider tighter exits to lock gains faster.`);
    } else {
      insights.push(`⏱️ Avg hold: ${avgHold}m — solid turnover rate.`);
    }
  }

  return insights;
}

function generateLearningTip(closedPositions, decisions) {
  // Data-driven tip from actual trade history — not generic textbook advice
  try {
    const profileData = loadJson("./trade-profile.json");
    if (profileData) {
      const tips = [];

      // Best hold time insight
      if (profileData.best_hold_time && profileData.worst_hold_time) {
        tips.push(`💡 <b>Your data says:</b> ${profileData.best_hold_time.bucket} holds win ${profileData.best_hold_time.win_rate}% of the time (${profileData.best_hold_time.count} trades). Avoid ${profileData.worst_hold_time.bucket} — only ${profileData.worst_hold_time.win_rate}% win rate.`);
      }

      // Volatility insight
      if (profileData.best_volatility && profileData.worst_volatility) {
        tips.push(`💡 <b>Volatility sweet spot:</b> ${profileData.best_volatility.bucket} pools win ${profileData.best_volatility.win_rate}% vs ${profileData.worst_volatility.win_rate}% for ${profileData.worst_volatility.bucket}. Stick to what works.`);
      }

      // Fee recovery
      if (profileData.fee_recovery) {
        const fr = profileData.fee_recovery;
        if (fr.fees_vs_il_ratio != null && fr.fees_vs_il_ratio < 1) {
          tips.push(`💡 <b>Fee gap:</b> Fees only cover ${Math.round(fr.fees_vs_il_ratio * 100)}% of losses. Need higher fee/TVL pools or shorter holds to close this gap.`);
        } else if (fr.fees_vs_il_ratio != null && fr.fees_vs_il_ratio >= 1) {
          tips.push(`💡 <b>Fees are working:</b> Fee income covers ${Math.round(fr.fees_vs_il_ratio * 100)}% of IL. Keep selecting high fee/TVL pools.`);
        }
      }

      // Stop loss insight
      const slData = profileData.by_close_reason?.stop_loss;
      if (slData && slData.count >= 3) {
        tips.push(`💡 <b>Stop losses:</b> ${slData.count} triggered at avg $${Math.abs(slData.avg_pnl).toFixed(2)} loss each. They saved you from deeper damage — the system is protecting capital.`);
      }

      // Repeat losers warning
      if (profileData.last_24h?.repeat_losers?.length > 0) {
        const names = profileData.last_24h.repeat_losers.map(r => r.token).join(", ");
        tips.push(`💡 <b>Repeat trap:</b> ${names} lost money multiple times in 24h. The bot now flags these to avoid re-entry.`);
      }

      // Trend
      if (profileData.last_24h?.trend === "declining") {
        tips.push(`💡 <b>Trend alert:</b> Win rate is declining vs prior period. The bot is tightening filters automatically to adapt.`);
      } else if (profileData.last_24h?.trend === "improving") {
        tips.push(`💡 <b>Improving:</b> Win rate is trending up. Recent config adjustments are paying off.`);
      }

      if (tips.length > 0) {
        // Rotate through data-driven tips by day
        return tips[new Date().getDate() % tips.length];
      }
    }
  } catch { /* fallback below */ }

  // Fallback if no trade profile yet
  return "💡 <b>Getting started:</b> The bot builds a statistical profile after 5+ closed trades. It gets smarter with every position.";
}

function getRecentDecisions(limit = 20) {
  try {
    if (!fs.existsSync(DECISION_LOG_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(DECISION_LOG_FILE, "utf8"));
    return (data.decisions || []).slice(0, limit);
  } catch { return []; }
}

function getDeployScreeningStats(decisions) {
  const deploys = decisions.filter(d => d.type === "deploy");
  const noDeploys = decisions.filter(d => d.type === "no_deploy");
  const skips = decisions.filter(d => d.type === "skip");
  const closes = decisions.filter(d => d.type === "close");

  return {
    deploys: deploys.length,
    noDeploys: noDeploys.length,
    skips: skips.length,
    closes: closes.length,
    hitRate: (deploys.length + noDeploys.length) > 0
      ? Math.round((deploys.length / (deploys.length + noDeploys.length)) * 100)
      : 0,
  };
}

function humanizeLesson(lesson) {
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Extract pool name from context or rule
  const poolName = (lesson.context || lesson.rule || "").match(/^(?:FAILED:\s*)?([A-Za-z0-9_]+-SOL)/)?.[1] || null;
  const tokenName = poolName ? poolName.split("-")[0] : null;

  // Evolution / config change lessons
  if (lesson.tags?.includes("evolution") || lesson.tags?.includes("config_change")) {
    const rule = lesson.rule || "";
    const paramMatch = rule.match(/\]\s*(\w+)=([\d.]+)/);
    const fromMatch = rule.match(/from\s+([\d.]+)/);
    if (paramMatch) {
      const param = paramMatch[1].replace(/([A-Z])/g, " $1").toLowerCase().trim();
      const newVal = paramMatch[2];
      const fromVal = fromMatch?.[1];
      const posMatch = rule.match(/@\s*(\d+)\s*positions/);
      const posCount = posMatch?.[1];
      let msg = `Auto-tuned <b>${esc(param)}</b> to ${newVal}`;
      if (fromVal) msg += ` (was ${fromVal})`;
      if (posCount) msg += ` after analyzing ${posCount} trades`;
      msg += ". Future screening will use this tighter filter.";
      return msg;
    }
    return esc(rule);
  }

  // Failed trade lessons — with actionable next step
  if (lesson.outcome === "bad" && lesson.pnl_pct != null) {
    const pnl = Math.abs(lesson.pnl_pct).toFixed(1);
    const fees = lesson.fees_earned_usd != null ? `$${lesson.fees_earned_usd.toFixed(2)}` : null;
    const reason = lesson.close_reason || "";
    const vol = lesson.context?.match(/volatility=([\d.]+)/)?.[1];
    const rangeEff = lesson.range_efficiency;

    let msg = poolName
      ? `Lost ${pnl}% on <b>${esc(poolName)}</b>`
      : `Lost ${pnl}% on a position`;

    // What happened
    if (/stop.?loss/i.test(reason)) msg += " — hit stop loss";
    else if (/trailing/i.test(reason)) msg += " — trailing TP triggered on the way down";
    else if (/out.?of.?range|oor/i.test(reason)) msg += " — price went out of range";
    else if (/low.?yield/i.test(reason)) msg += " — yield dried up";
    else if (/max.?hold|time/i.test(reason)) msg += " — held too long without profit";
    else if (reason) msg += ` — ${esc(reason.split(":")[0].trim().toLowerCase())}`;

    if (fees) msg += `. Fees only covered ${fees}`;
    msg += ".";

    // What to do about it (the actionable part)
    msg += "\n     → ";
    if (/stop.?loss/i.test(reason)) {
      if (vol && parseFloat(vol) > 3) {
        msg += `High volatility (${vol}) caused a fast drop. Will skip pools above this volatility level.`;
      } else {
        msg += `Will avoid similar setups. ${tokenName ? `${tokenName} added to caution list.` : "Tightening entry filters."}`;
      }
    } else if (/out.?of.?range|oor/i.test(reason)) {
      if (rangeEff != null && rangeEff < 30) {
        msg += `Only ${rangeEff.toFixed(0)}% in-range — bin range was too narrow. Will use wider ranges for this volatility.`;
      } else {
        msg += `Price moved away too fast. Will prefer lower-volatility pools or widen the bin range.`;
      }
    } else if (/low.?yield/i.test(reason)) {
      msg += `Volume collapsed after entry. Will require higher sustained fee/TVL before deploying.`;
    } else if (/max.?hold|time/i.test(reason)) {
      msg += `Position sat too long without hitting TP. Will look for faster-moving pools or tighten TP target.`;
    } else {
      msg += `Reviewing this pool type to avoid repeating the same entry.`;
    }

    return msg;
  }

  // Successful trade lessons — with what worked
  if (lesson.outcome === "good" && lesson.pnl_pct != null) {
    const pnl = lesson.pnl_pct.toFixed(1);
    const fees = lesson.fees_earned_usd != null ? `$${lesson.fees_earned_usd.toFixed(2)}` : null;
    const rangeEff = lesson.range_efficiency;

    let msg = poolName
      ? `Gained ${pnl}% on <b>${esc(poolName)}</b>`
      : `Gained ${pnl}% on a position`;
    if (fees) msg += ` with ${fees} in fees`;
    msg += ".";

    // What worked
    msg += "\n     → ";
    if (rangeEff != null && rangeEff > 80) {
      msg += `Excellent ${rangeEff.toFixed(0)}% in-range time. This pool type and bin sizing works — will favor similar setups.`;
    } else if (parseFloat(pnl) > 5) {
      msg += `Strong gain. Will look for more pools with similar characteristics.`;
    } else {
      msg += `Solid small win. Consistent setups like this compound over time.`;
    }

    return msg;
  }

  // Fallback: clean up the raw rule string
  const raw = String(lesson.rule || "unknown lesson");
  const cleaned = raw
    .replace(/\d+\.\d{4,}/g, (m) => parseFloat(m).toFixed(2))
    .replace(/undefined/g, "n/a")
    .replace(/[←→]/g, "→");
  return esc(cleaned.length > 120 ? cleaned.slice(0, 117) + "..." : cleaned);
}

function summarizeLessons(lessons, perfLast24h) {
  // Count lesson types
  const counts = { stop_loss: 0, oor: 0, low_yield: 0, max_hold: 0, good: 0, evolved: 0, other: 0 };
  for (const l of lessons) {
    if (l.tags?.includes("evolution") || l.tags?.includes("config_change")) { counts.evolved++; continue; }
    const reason = l.close_reason || l.rule || "";
    if (l.outcome === "good") counts.good++;
    else if (/stop.?loss/i.test(reason)) counts.stop_loss++;
    else if (/out.?of.?range|oor/i.test(reason)) counts.oor++;
    else if (/low.?yield/i.test(reason)) counts.low_yield++;
    else if (/max.?hold|time/i.test(reason)) counts.max_hold++;
    else if (l.outcome === "bad") counts.other++;
  }

  const parts = [];

  // What went wrong
  const problems = [];
  if (counts.stop_loss > 0) problems.push(`${counts.stop_loss} hit stop loss`);
  if (counts.oor > 0) problems.push(`${counts.oor} went out of range`);
  if (counts.low_yield > 0) problems.push(`${counts.low_yield} had yield dry up`);
  if (counts.max_hold > 0) problems.push(`${counts.max_hold} held too long`);
  if (counts.other > 0) problems.push(`${counts.other} closed for other reasons`);

  if (problems.length > 0) {
    parts.push(`From ${lessons.length} new lessons: ${problems.join(", ")}.`);
  }

  // What to do about it (one combined action)
  const actions = [];
  if (counts.stop_loss >= 2) actions.push("tightening volatility filters to avoid fast drops");
  else if (counts.stop_loss === 1) actions.push("watching volatility on entries");
  if (counts.oor >= 2) actions.push("widening bin ranges for better coverage");
  if (counts.low_yield >= 2) actions.push("raising fee/TVL floor to skip pools with weak volume");
  if (counts.max_hold >= 2) actions.push("shortening max hold time to cut dead-weight positions faster");

  if (actions.length > 0) {
    parts.push(`Adapting by ${actions.join(" and ")}.`);
  }

  // What worked
  if (counts.good > 0) {
    parts.push(`${counts.good} winning trade${counts.good > 1 ? "s" : ""} confirmed the current strategy works when pools are picked right.`);
  }

  // Config evolution
  if (counts.evolved > 0) {
    parts.push(`Auto-tuned ${counts.evolved} config parameter${counts.evolved > 1 ? "s" : ""} based on the data.`);
  }

  // Net direction
  if (perfLast24h && perfLast24h.length > 0) {
    const winRate = Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100);
    if (winRate >= 60) parts.push("Overall execution was solid — keep the current approach.");
    else if (winRate >= 45) parts.push("Mixed results — the bot is adjusting filters to improve hit rate.");
    else parts.push("Tough day — the bot is learning and tightening entry criteria for tomorrow.");
  }

  return parts.join(" ") || "No significant patterns to report today.";
}


export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [], paperPositions: {}, closedPaperPositions: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };
  const decisions = getRecentDecisions(50);

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const dateStr = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  // Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  const allPaper = Object.values(state.paperPositions || {});
  const closedPaper = state.closedPaperPositions || [];
  const paperOpenedLast24h = allPaper.filter(p => new Date(p.deployed_at) > last24h);
  const paperClosedLast24h = closedPaper.filter(p => new Date(p.closed_at) > last24h);
  const openPaper = allPaper.filter(p => !p.closed);

  // Performance
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const totalPnLUsd = perfLast24h.reduce((s, p) => s + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((s, p) => s + (p.fees_earned_usd || 0), 0);
  const wins24h = perfLast24h.filter(p => p.pnl_usd > 0).length;
  const winRate24h = perfLast24h.length > 0 ? Math.round((wins24h / perfLast24h.length) * 100) : null;

  // All-time
  const perfSummary = getPerformanceSummary();
  const allTimePerf = lessonsData.performance || [];
  const allTimeWins = allTimePerf.filter(p => p.pnl_usd > 0).length;
  const allTimeWinRate = allTimePerf.length > 0 ? Math.round((allTimeWins / allTimePerf.length) * 100) : 0;
  const health = healthGrade(allTimeWinRate, allTimePerf.length);

  // Best/worst 24h
  const bestPerf = perfLast24h.length > 0 ? perfLast24h.reduce((a, b) => (a.pnl_usd || 0) > (b.pnl_usd || 0) ? a : b) : null;
  const worstPerf = perfLast24h.length > 0 ? perfLast24h.reduce((a, b) => (a.pnl_usd || 0) < (b.pnl_usd || 0) ? a : b) : null;

  // Lessons
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);
  const totalLessons = (lessonsData.lessons || []).length;

  // Open portfolio
  const openPositions = allPositions.filter(p => !p.closed);
  const paperValue = openPaper.reduce((s, p) => s + (p.initial_value_usd || 0) + (p.pnl_usd || 0), 0);
  const paperFees = openPaper.reduce((s, p) => s + (p.simulated_fees_usd || 0), 0);
  const totalOpened = openedLast24h.length + paperOpenedLast24h.length;
  const totalClosed = closedLast24h.length + paperClosedLast24h.length;

  // Win streak
  let streak = 0;
  for (let i = allTimePerf.length - 1; i >= 0; i--) {
    if ((allTimePerf[i].pnl_usd || 0) > 0) streak++;
    else break;
  }

  // Decision stats
  const decisionStats = getDeployScreeningStats(decisions);

  // Close reason breakdown
  const allClosed = [...closedLast24h, ...paperClosedLast24h];
  const closeBreakdown = getCloseReasonBreakdown(allClosed);

  // Strategy performance
  const bestStrat = getBestStrategy([...closedPaper, ...allPositions.filter(p => p.closed)]);

  const L = [];

  L.push(`☀️ <b>MERIDIAN DAILY REPORT</b>`);
  L.push(`<i>${dateStr}</i>`);
  L.push(``);
  L.push(greeting(totalPnLUsd, totalClosed));
  L.push(``);

  // ── Activity
  L.push(`━━━ 📊 <b>24H ACTIVITY</b> ━━━`);
  L.push(``);
  L.push(`  📥 Deployed:  ${totalOpened} position${totalOpened !== 1 ? "s" : ""}`);
  L.push(`  📤 Closed:    ${totalClosed} position${totalClosed !== 1 ? "s" : ""}`);
  L.push(`  🔍 Screened:  ${decisionStats.deploys + decisionStats.noDeploys} cycle${(decisionStats.deploys + decisionStats.noDeploys) !== 1 ? "s" : ""} (${decisionStats.hitRate}% deploy rate)`);
  L.push(``);

  // ── Performance
  L.push(`━━━ 💰 <b>PERFORMANCE</b> ━━━`);
  L.push(``);
  L.push(`  PnL:     <b>${fmtUsd(totalPnLUsd)}</b>`);
  L.push(`  Fees:    <b>+$${totalFeesUsd.toFixed(2)}</b>`);
  L.push(`  Net:     <b>${fmtUsd(totalPnLUsd + totalFeesUsd)}</b>`);
  L.push(winRate24h != null ? `  Win Rate: ${progressBar(winRate24h)} ${winRate24h}%` : `  Win Rate: —`);
  L.push(``);

  if (bestPerf && perfLast24h.length > 1) {
    L.push(`  🏆 Best:  ${bestPerf.pool_name || "?"} ${fmtUsd(bestPerf.pnl_usd)}`);
    L.push(`  💀 Worst: ${worstPerf.pool_name || "?"} ${fmtUsd(worstPerf.pnl_usd)}`);
    L.push(``);
  }

  // ── Close Breakdown (educational)
  if (Object.keys(closeBreakdown).length > 0 && totalClosed > 0) {
    L.push(`━━━ 🔍 <b>EXIT ANALYSIS</b> ━━━`);
    L.push(``);
    const exitLabels = {
      stop_loss: "🛑 Stop Loss",
      take_profit: "🎯 Take Profit",
      trailing_tp: "📈 Trailing TP",
      oor: "📐 Out of Range",
      low_yield: "📉 Low Yield",
      other: "❓ Other",
    };
    for (const [key, data] of Object.entries(closeBreakdown)) {
      const label = exitLabels[key] || key;
      L.push(`  ${label}: ${data.count}x | PnL ${fmtUsd(data.total_pnl)} | Fees +$${data.total_fees.toFixed(2)}`);
    }
    L.push(``);
  }


  // ── Intelligence
  L.push(`━━━ 🧠 <b>INTELLIGENCE</b> ━━━`);
  L.push(``);
  L.push(`  Health: <b>${health.grade}</b> — ${health.label}`);
  L.push(`  Brain:  ${totalLessons} lesson${totalLessons !== 1 ? "s" : ""} learned`);
  if (bestStrat && bestStrat.count >= 2) {
    L.push(`  Best strat: <b>${bestStrat.name}</b> (${bestStrat.winRate}% win, ${bestStrat.count} trades)`);
  }
  if (streak > 1) L.push(`  Streak: 🔥 ${streak} wins in a row`);
  L.push(``);

  if (lessonsLast24h.length > 0) {
    L.push(`  <b>What I learned today:</b>`);
    L.push(`  ${summarizeLessons(lessonsLast24h, perfLast24h)}`);
    L.push(``);
  }

  // ── Portfolio
  L.push(`━━━ 💼 <b>PORTFOLIO</b> ━━━`);
  L.push(``);

  if (openPositions.length > 0) {
    L.push(`  <b>Live (${openPositions.length}):</b>`);
    for (const p of openPositions.slice(0, 5)) {
      L.push(`  ▸ ${p.pool_name || "?"} | PnL: ${p.pnl_pct ?? "?"}%`);
    }
    L.push(``);
  }

  if (openPaper.length > 0) {
    L.push(`  <b>Paper (${openPaper.length}):</b>  $${paperValue.toFixed(2)} total | $${paperFees.toFixed(2)} fees`);
    for (const p of openPaper.slice(0, 5)) {
      const icon = p.in_range ? "🟢" : "🔴";
      const pnlColor = p.pnl_pct >= 0 ? "+" : "";
      L.push(`  ▸ ${icon} ${p.pair} | ${pnlColor}${p.pnl_pct}% | $${p.simulated_fees_usd.toFixed(4)} fees | ${p.age_minutes || 0}m`);
    }
    L.push(``);
  }

  if (openPositions.length === 0 && openPaper.length === 0) {
    L.push(`  No open positions. Scanning for opportunities...`);
    L.push(``);
  }

  // ── LP Insights (educational analysis)
  const allClosedForInsight = [...closedPaper, ...allPositions.filter(p => p.closed)];
  if (allClosedForInsight.length >= 2) {
    const allOpenForInsight = [...openPositions, ...openPaper];
    const lpInsights = generateLPInsight(allClosedForInsight, allOpenForInsight);
    if (lpInsights.length > 0) {
      L.push(`━━━ 📚 <b>LP INSIGHTS</b> ━━━`);
      L.push(``);
      for (const insight of lpInsights.slice(0, 4)) {
        L.push(`  ${insight}`);
      }
      L.push(``);
    }
  }

  // ── Daily Learning Tip
  L.push(`━━━ 🎓 <b>DAILY TIP</b> ━━━`);
  L.push(``);
  L.push(`  ${generateLearningTip(allClosedForInsight, decisions)}`);
  L.push(``);

  // ── All-time
  if (perfSummary || allTimePerf.length > 0) {
    L.push(`━━━ 📈 <b>ALL-TIME</b> ━━━`);
    L.push(``);
    L.push(`  Closed: ${allTimePerf.length} position${allTimePerf.length !== 1 ? "s" : ""}`);
    if (perfSummary) {
      L.push(`  PnL:    <b>${fmtUsd(perfSummary.total_pnl_usd)}</b>`);
    }
    L.push(`  W/L:    ${allTimeWins}/${allTimePerf.length - allTimeWins} (${allTimeWinRate}%)`);
    L.push(`  ${progressBar(allTimeWinRate, 15)}`);
    const avgHold = getAverageHoldTime(allTimePerf);
    if (avgHold != null) L.push(`  Avg hold: ${avgHold}m`);
    L.push(``);
  }

  L.push(`<i>Meridian v1 • ${process.env.DRY_RUN === "true" ? "📝 PAPER MODE" : "🔴 LIVE"}</i>`);

  return L.join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
