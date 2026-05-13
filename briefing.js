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
  const tips = [
    "💡 <b>LP Basics:</b> Your profit = fees earned − impermanent loss. Wider ranges = less IL but less fee concentration.",
    "💡 <b>Bin Step:</b> Higher bin step = wider price intervals per bin. Good for volatile tokens, bad for stable pairs.",
    "💡 <b>OOR Risk:</b> When price exits your range, you stop earning fees but keep IL exposure. That's the worst spot.",
    "💡 <b>Fee/TVL Ratio:</b> This is your yield gauge. Higher = more fees per dollar of TVL. Below 1% is usually not worth it.",
    "💡 <b>Trailing TP:</b> Locks profits by tracking the peak PnL and closing when it drops by X%. Prevents giving back gains.",
    "💡 <b>Single-Side SOL:</b> You only deposit SOL (no token). You earn fees when price drops into your range, but absorb IL if it keeps dropping.",
    "💡 <b>Volatility &amp; Bins:</b> High volatility pools need more bins_below for safety. The bot scales this automatically.",
    "💡 <b>Organic Score:</b> Measures real human trading vs wash trading. Below 50 = suspicious activity.",
    "💡 <b>Smart Wallets:</b> When known profitable wallets are in a pool, it's a strong confidence signal.",
    "💡 <b>Position Sizing:</b> Never put more than 25-35% of available capital in one position. Diversify across pools.",
    "💡 <b>Token Age:</b> Very new tokens (under 2h) are higher risk but higher reward. Established tokens (24h+) are safer but lower yield.",
    "💡 <b>Bundle %:</b> High bundle % means coordinated buying (potential pump &amp; dump). Stay cautious above 30%.",
  ];

  // Pick a tip based on recent performance patterns
  const recentLosses = closedPositions.filter(p => (p.total_return_usd || p.pnl_usd || 0) < 0);
  const recentWins = closedPositions.filter(p => (p.total_return_usd || p.pnl_usd || 0) > 0);

  // Contextual tip selection
  if (recentLosses.length > recentWins.length * 2) {
    // Losing streak — focus on risk management
    const riskTips = tips.filter(t => /risk|stop|loss|IL|OOR/i.test(t));
    if (riskTips.length > 0) return riskTips[Math.floor(Math.random() * riskTips.length)];
  }
  if (recentWins.length > recentLosses.length * 2) {
    // Winning streak — teach about optimization
    const optTips = tips.filter(t => /trailing|fee|yield|sizing/i.test(t));
    if (optTips.length > 0) return optTips[Math.floor(Math.random() * optTips.length)];
  }

  // Random tip
  const dayIndex = new Date().getDate();
  return tips[dayIndex % tips.length];
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
    L.push(`  <b>New lessons:</b>`);
    for (const l of lessonsLast24h.slice(0, 3)) {
      const safeRule = String(l.rule || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      L.push(`  💡 ${safeRule}`);
    }
    if (lessonsLast24h.length > 3) L.push(`  ... +${lessonsLast24h.length - 3} more`);
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
