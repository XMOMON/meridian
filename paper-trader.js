/**
 * paper-trader.js
 *
 * Simulated position tracker for DRY_RUN=true mode.
 *
 * Writes to state.json under two new keys:
 *   state.paperPositions        — open simulated positions (keyed by id)
 *   state.closedPaperPositions  — append-only closed position log
 *
 * ── PnL model (intentionally simplified, IL not modelled) ──────────────────
 *
 *   entry_value_usd  = deployed_sol × sol_price_at_entry
 *   current_value    = deployed_sol × current_sol_price
 *   simulated_fees   = entry_value × (fee_tvl_ratio / 100) × elapsed_days
 *   pnl_usd          = (current_value + simulated_fees) − entry_value
 *   pnl_pct          = pnl_usd / entry_value × 100
 *
 * fee_tvl_ratio is stored in PERCENT (e.g. 0.5643 means 0.5643 %/day),
 * matching the bot's existing convention in config.management.minFeePerTvl24h.
 *
 * ── In-range detection ─────────────────────────────────────────────────────
 *   Uses token price % change from entry vs. range_coverage bounds saved at
 *   deploy. Falls back to true (in-range) when token price is unavailable.
 */

import fs from "fs";
import { log } from "./logger.js";

const STATE_FILE  = "./state.json";
const SOL_MINT    = "So11111111111111111111111111111111111111112";
const JUPITER_URL = "https://api.jup.ag/price/v2?ids=";

// ─── State helpers ────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { positions: {}, paperPositions: {}, closedPaperPositions: [], recentEvents: [], lastUpdated: null };
    }
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!raw.paperPositions)       raw.paperPositions       = {};
    if (!raw.closedPaperPositions) raw.closedPaperPositions = [];
    return raw;
  } catch (err) {
    log("paper_trader", `State read error: ${err.message}`);
    return { positions: {}, paperPositions: {}, closedPaperPositions: [], recentEvents: [], lastUpdated: null };
  }
}

function saveState(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("paper_trader", `State write error: ${err.message}`);
  }
}

// ─── Price fetching ───────────────────────────────────────────────────────────

/**
 * Fetch USD prices from Jupiter Price API v2.
 * Always includes SOL so we always have a SOL price in the response.
 * Returns { [mint]: number | null }
 */
export async function fetchPrices(mintAddresses = []) {
  const mints = [...new Set([SOL_MINT, ...mintAddresses.filter(Boolean)])];
  try {
    const res = await fetch(`${JUPITER_URL}${mints.join(",")}`, {
      signal: AbortSignal.timeout(8_000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const prices = {};
    for (const [mint, info] of Object.entries(json.data || {})) {
      // Jupiter v2 returns price as a string — always parseFloat
      const p = parseFloat(info?.price);
      prices[mint] = Number.isFinite(p) ? p : null;
    }
    return prices;
  } catch (err) {
    log("paper_trader", `Jupiter price fetch failed: ${err.message}`);
    return {};
  }
}

export const extractSolPrice   = (pm) => pm[SOL_MINT] ?? null;
export const extractTokenPrice = (pm, mint) => (mint ? (pm[mint] ?? null) : null);

// ─── Math helpers ─────────────────────────────────────────────────────────────

const r4           = (n) => Math.round(n * 10_000) / 10_000;
const minutesSince = (iso) => iso ? Math.max(0, (Date.now() - new Date(iso).getTime()) / 60_000) : 0;

/**
 * Compute current PnL + simulated fees for an open paper position.
 * fee_tvl_ratio is in PERCENT → divide by 100 for the daily decimal multiplier.
 */
function computePnl(pos, solPrice) {
  if (!solPrice || !pos.entry_sol_price_usd || !pos.deployed_sol) {
    return {
      current_value_usd:  pos.entry_value_usd ?? 0,
      simulated_fees_usd: pos.simulated_fees_usd ?? 0,
      pnl_usd: 0,
      pnl_pct: 0,
    };
  }
  const currentValueUsd  = pos.deployed_sol * solPrice;
  const daysElapsed      = minutesSince(pos.entry_ts) / 1_440;
  const dailyFeeDecimal  = (pos.fee_tvl_ratio ?? 0) / 100;      // pct → decimal
  const simulatedFeesUsd = Math.max(0, (pos.entry_value_usd ?? 0) * dailyFeeDecimal * daysElapsed);
  const pnlUsd           = (currentValueUsd + simulatedFeesUsd) - (pos.entry_value_usd ?? 0);
  const pnlPct           = (pos.entry_value_usd ?? 0) > 0 ? (pnlUsd / pos.entry_value_usd) * 100 : 0;
  return {
    current_value_usd:  r4(currentValueUsd),
    simulated_fees_usd: r4(simulatedFeesUsd),
    pnl_usd: r4(pnlUsd),
    pnl_pct: r4(pnlPct),
  };
}

/** Estimate in-range via token price % change vs. stored range bounds. */
function computeInRange(pos, tokenPrice) {
  if (!tokenPrice || !pos.entry_token_price_usd || pos.entry_token_price_usd === 0) return true;
  const changePct = ((tokenPrice - pos.entry_token_price_usd) / pos.entry_token_price_usd) * 100;
  return changePct >= -(pos.range_coverage?.downside_pct ?? 30) &&
         changePct <=  (pos.range_coverage?.upside_pct   ?? 5);
}

// ─── Track new paper deploy ───────────────────────────────────────────────────

/**
 * Called from index.js → runScreeningCycle → onToolFinish after a successful
 * dry-run deploy. Fetches entry prices and writes the simulated position.
 *
 * @param {string}      poolAddress
 * @param {string}      poolName
 * @param {string|null} baseMint
 * @param {number}      deployedSol
 * @param {object}      rangeCoverage   — { downside_pct, upside_pct, width_pct }
 * @param {number}      feeTvlRatio     — daily fee/TVL in PERCENT (e.g. 0.5643)
 * @param {object}      deployResult    — raw tool result
 */
export async function trackPaperDeploy({
  poolAddress,
  poolName,
  baseMint,
  deployedSol,
  rangeCoverage = {},
  feeTvlRatio   = 0,
  deployResult  = {},
}) {
  if (process.env.DRY_RUN !== "true") return null;

  log("paper_trader",
    `Recording paper deploy: ${poolName} | ${(poolAddress || "").slice(0, 8)}… | ◎${deployedSol}`
  );

  const priceMap   = await fetchPrices(baseMint ? [baseMint] : []);
  const solPrice   = extractSolPrice(priceMap);
  const tokenPrice = extractTokenPrice(priceMap, baseMint);

  if (!solPrice) log("paper_trader", "SOL price unavailable at entry — entry_value_usd = 0");

  const entryValueUsd = (deployedSol && solPrice) ? r4(deployedSol * solPrice) : 0;
  const now = new Date().toISOString();
  const id  = `paper_${(poolAddress || "unknown").slice(0, 8)}_${Date.now()}`;

  const position = {
    id,
    pool:      poolAddress ?? null,
    pool_name: poolName    || "Unknown",
    base_mint: baseMint    ?? null,

    entry_ts:              now,
    deployed_sol:          deployedSol ?? 0,
    entry_sol_price_usd:   solPrice,
    entry_token_price_usd: tokenPrice,
    entry_value_usd:       entryValueUsd,

    range_coverage: {
      downside_pct: rangeCoverage.downside_pct ?? null,
      upside_pct:   rangeCoverage.upside_pct   ?? null,
      width_pct:    rangeCoverage.width_pct     ?? null,
    },
    fee_tvl_ratio: feeTvlRatio ?? 0,   // in PERCENT

    current_sol_price_usd:   solPrice,
    current_token_price_usd: tokenPrice,
    current_value_usd:       entryValueUsd,
    simulated_fees_usd:      0,
    pnl_usd:  0,
    pnl_pct:  0,
    in_range: true,
    out_of_range_since: null,
    last_updated: now,

    deploy_result: {
      position: deployResult.position ?? null,
      txs:      deployResult.txs      ?? [],
      dry_run:  deployResult.dry_run  ?? true,
    },

    closed:         false,
    closed_at:      null,
    close_reason:   null,
    final_pnl_usd:  null,
    final_pnl_pct:  null,
    final_fees_usd: null,
  };

  const state = loadState();
  state.paperPositions[id] = position;
  saveState(state);

  log("paper_trader",
    `Paper position saved — ${id} | SOL $${solPrice ?? "?"} | token $${tokenPrice ?? "?"} | entry $${entryValueUsd}`
  );
  return position;
}

// ─── Update all open paper positions ─────────────────────────────────────────

/** Refresh PnL + in-range for all open paper positions. Called each management cycle. */
export async function updatePaperPositions() {
  const state = loadState();
  const open  = Object.values(state.paperPositions).filter((p) => !p.closed);
  if (open.length === 0) { log("paper_trader", "No open paper positions to update"); return []; }

  const mints    = [...new Set(open.map((p) => p.base_mint).filter(Boolean))];
  const priceMap = await fetchPrices(mints);
  const solPrice = extractSolPrice(priceMap);

  if (!solPrice) {
    log("paper_trader", "SOL price unavailable — paper update skipped");
    return open;
  }

  const now = new Date().toISOString();
  const updated = [];

  for (const pos of open) {
    const tokenPrice = extractTokenPrice(priceMap, pos.base_mint);
    const { current_value_usd, simulated_fees_usd, pnl_usd, pnl_pct } = computePnl(pos, solPrice);
    const inRange = computeInRange(pos, tokenPrice);

    let oorSince = pos.out_of_range_since ?? null;
    if (!inRange && !oorSince) { oorSince = now; log("paper_trader", `${pos.pool_name} went OOR`); }
    else if (inRange && oorSince) { oorSince = null; log("paper_trader", `${pos.pool_name} back in range`); }

    const updatedPos = {
      ...pos,
      current_sol_price_usd:   solPrice,
      current_token_price_usd: tokenPrice,
      current_value_usd, simulated_fees_usd, pnl_usd, pnl_pct,
      in_range: inRange, out_of_range_since: oorSince, last_updated: now,
    };
    state.paperPositions[pos.id] = updatedPos;
    updated.push(updatedPos);
  }

  saveState(state);
  const avgPnl = updated.reduce((s, p) => s + (p.pnl_pct ?? 0), 0) / updated.length;
  log("paper_trader", `Updated ${updated.length} paper position(s) | SOL $${solPrice} | avg PnL ${avgPnl.toFixed(2)}%`);
  return updated;
}

// ─── Close a paper position ───────────────────────────────────────────────────

export function closePaperPosition(id, reason) {
  const state = loadState();
  const pos   = state.paperPositions[id];
  if (!pos)       { log("paper_trader", `closePaperPosition: ${id} not found`);     return null; }
  if (pos.closed) { log("paper_trader", `closePaperPosition: ${id} already closed`); return pos;  }

  const now             = new Date().toISOString();
  const durationMinutes = Math.round(minutesSince(pos.entry_ts));

  state.paperPositions[id] = {
    ...pos, closed: true, closed_at: now, close_reason: reason,
    final_pnl_usd: pos.pnl_usd, final_pnl_pct: pos.pnl_pct, final_fees_usd: pos.simulated_fees_usd,
  };

  if (!Array.isArray(state.closedPaperPositions)) state.closedPaperPositions = [];
  state.closedPaperPositions.push({
    id: pos.id, pool: pos.pool, pool_name: pos.pool_name,
    entry_ts: pos.entry_ts, closed_at: now, duration_minutes: durationMinutes,
    deployed_sol: pos.deployed_sol, entry_value_usd: pos.entry_value_usd,
    final_value_usd: pos.current_value_usd,
    final_pnl_usd: pos.pnl_usd, final_pnl_pct: pos.pnl_pct,
    final_fees_usd: pos.simulated_fees_usd, close_reason: reason,
  });

  saveState(state);
  log("paper_trader",
    `Closed: ${pos.pool_name} (${id}) | PnL ${pos.pnl_pct?.toFixed(2) ?? "?"}% ($${pos.pnl_usd ?? "?"}) | held ${durationMinutes}m`
  );
  return state.paperPositions[id];
}

// ─── Summary (for dashboard / agent prompt) ───────────────────────────────────

export function getPaperTradingSummary() {
  const state     = loadState();
  const all       = Object.values(state.paperPositions || {});
  const open      = all.filter((p) => !p.closed);
  const closedLog = state.closedPaperPositions || [];
  const winCount  = closedLog.filter((p) => (p.final_pnl_pct ?? 0) > 0).length;

  return {
    paper_trading:      true,
    open_count:         open.length,
    closed_count:       closedLog.length,
    total_deployed_sol: r4(open.reduce((s, p) => s + (p.deployed_sol ?? 0), 0)),
    open_pnl_usd:       r4(open.reduce((s, p) => s + (p.pnl_usd ?? 0), 0)),
    open_fees_usd:      r4(open.reduce((s, p) => s + (p.simulated_fees_usd ?? 0), 0)),
    closed_pnl_usd:     r4(closedLog.reduce((s, p) => s + (p.final_pnl_usd ?? 0), 0)),
    win_rate_pct:       closedLog.length > 0 ? r4((winCount / closedLog.length) * 100) : null,
    open_positions: open.map((p) => ({
      id: p.id, pool_name: p.pool_name, deployed_sol: p.deployed_sol,
      pnl_pct: p.pnl_pct, pnl_usd: p.pnl_usd,
      simulated_fees_usd: p.simulated_fees_usd,
      in_range: p.in_range, age_minutes: Math.round(minutesSince(p.entry_ts)),
    })),
    recent_closed: closedLog.slice(-5),
  };
}

// ─── Deterministic close rules ────────────────────────────────────────────────

/**
 * fee_tvl_ratio is in PERCENT, same unit as config.management.minFeePerTvl24h.
 * No conversion needed for yield comparison.
 */
export function checkPaperPositionCloseRule(pos, mgmtConfig) {
  const pnl        = pos.pnl_pct;
  const ageMinutes = Math.round(minutesSince(pos.entry_ts));

  if (pnl != null && mgmtConfig.stopLossPct  != null && pnl <= mgmtConfig.stopLossPct)
    return { rule: "stop_loss",  reason: `Stop loss: PnL ${pnl.toFixed(2)}% ≤ ${mgmtConfig.stopLossPct}%` };

  if (pnl != null && mgmtConfig.takeProfitPct != null && pnl >= mgmtConfig.takeProfitPct)
    return { rule: "take_profit", reason: `Take profit: PnL ${pnl.toFixed(2)}% ≥ ${mgmtConfig.takeProfitPct}%` };

  if (!pos.in_range && pos.out_of_range_since) {
    const oorMinutes = Math.round(minutesSince(pos.out_of_range_since));
    if (mgmtConfig.outOfRangeWaitMinutes != null && oorMinutes >= mgmtConfig.outOfRangeWaitMinutes)
      return { rule: "oor", reason: `OOR ${oorMinutes}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)` };
  }

  const minAge = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    pos.fee_tvl_ratio != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    pos.fee_tvl_ratio < mgmtConfig.minFeePerTvl24h &&
    ageMinutes >= minAge
  ) {
    return { rule: "low_yield",
      reason: `Low yield: fee/TVL ${pos.fee_tvl_ratio.toFixed(4)}% < ${mgmtConfig.minFeePerTvl24h}% (age: ${ageMinutes}m)` };
  }

  return null;
}
