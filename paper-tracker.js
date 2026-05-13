/**
 * Paper Trading Tracker for DRY_RUN mode.
 *
 * When DRY_RUN=true, the bot currently logs decisions but doesn't
 * track simulated positions. This module adds full paper position
 * tracking: entry price, live PnL, estimated fees, range status.
 *
 * All data is persisted in state.json under `paperPositions` and
 * `closedPaperPositions` so the dashboard can read it.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";
import { appendDecision } from "./decision-log.js";
import { recordPerformance } from "./lessons.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "state.json");
const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// ─── State I/O ─────────────────────────────────────────────────

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], paperPositions: {}, closedPaperPositions: [], lastUpdated: null };
  }
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!state.paperPositions) state.paperPositions = {};
    if (!state.closedPaperPositions) state.closedPaperPositions = [];
    return state;
  } catch (err) {
    log("paper_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, recentEvents: [], paperPositions: {}, closedPaperPositions: [], lastUpdated: null };
  }
}

function saveState(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("paper_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Price Fetching ────────────────────────────────────────────

/**
 * Fetch current USD price for a token mint via Jupiter Price API v3.
 * Returns { price, sol_price } or null on failure.
 */
export async function fetchTokenPrice(mint) {
  try {
    const url = `${JUPITER_PRICE_API}?ids=${mint},${SOL_MINT}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Jupiter price API ${res.status}`);
    const data = await res.json();
    const tokenData = data?.data?.[mint];
    const solData = data?.data?.[SOL_MINT];
    return {
      price_usd: tokenData?.price ? parseFloat(tokenData.price) : null,
      sol_price_usd: solData?.price ? parseFloat(solData.price) : null,
    };
  } catch (err) {
    log("paper_warn", `Price fetch failed for ${mint?.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch pool detail from Meteora Pool Discovery API for live fee/TVL data.
 */
async function fetchPoolMetrics(poolAddress) {
  try {
    const url = `https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=1h`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const pool = (data?.data || [])[0];
    if (!pool) return null;
    return {
      fee_active_tvl_ratio: parseFloat(pool.fee_active_tvl_ratio || 0),
      volatility: parseFloat(pool.volatility || 0),
      active_bin: pool.active_bin_id ?? null,
      bin_step: pool.dlmm_params?.bin_step ?? pool.bin_step ?? null,
      tvl: parseFloat(pool.tvl || pool.active_tvl || 0),
      base_mint: pool.token_x?.address ?? null,
      quote_mint: pool.token_y?.address ?? null,
      base_price_usd: pool.token_x?.price ? parseFloat(pool.token_x.price) : null,
      quote_price_usd: pool.token_y?.price ? parseFloat(pool.token_y.price) : null,
      pool_price: pool.pool_price ? parseFloat(pool.pool_price) : null,
      name: pool.name ?? null,
    };
  } catch (err) {
    log("paper_warn", `Pool metrics fetch failed for ${poolAddress?.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

// ─── Paper Position CRUD ───────────────────────────────────────

/**
 * Create a paper position from a dry-run deploy result.
 *
 * @param {Object} deployArgs - The original deploy_position args
 * @param {Object} deployResult - The dry_run result from dlmm.js
 */
export async function createPaperPosition(deployArgs, deployResult) {
  const poolAddress = deployArgs.pool_address;
  const wouldDeploy = deployResult.would_deploy || {};
  const amountSol = wouldDeploy.amount_y ?? deployArgs.amount_y ?? deployArgs.amount_sol ?? 0;

  // Fetch live pool data for entry price and metadata
  const poolMetrics = await fetchPoolMetrics(poolAddress);
  const baseMint = poolMetrics?.base_mint || deployArgs.base_mint || null;

  // Get prices — prefer pool API data (already has token prices), fallback to Jupiter
  let entryPriceUsd = poolMetrics?.base_price_usd ?? null;
  let solPriceUsd = poolMetrics?.quote_price_usd ?? null;

  if ((!entryPriceUsd || !solPriceUsd) && baseMint) {
    const prices = await fetchTokenPrice(baseMint);
    if (!entryPriceUsd) entryPriceUsd = prices?.price_usd ?? null;
    if (!solPriceUsd) solPriceUsd = prices?.sol_price_usd ?? null;
  }
  // If we still don't have SOL price, fetch it directly
  if (!solPriceUsd) {
    const solPrices = await fetchTokenPrice(SOL_MINT);
    solPriceUsd = solPrices?.price_usd ?? null;
  }

  const positionId = `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const initialValueUsd = solPriceUsd ? amountSol * solPriceUsd : null;

  const position = {
    id: positionId,
    pool: poolAddress,
    pair: deployArgs.pool_name || poolMetrics?.name || `${baseMint?.slice(0, 6) || "?"}-SOL`,
    base_mint: baseMint,
    strategy: wouldDeploy.strategy || deployArgs.strategy || "bid_ask",
    bins_below: wouldDeploy.bins_below ?? 0,
    bins_above: wouldDeploy.bins_above ?? 0,
    amount_sol: amountSol,
    initial_value_usd: initialValueUsd,

    // Price tracking
    entry_price_usd: entryPriceUsd,
    entry_sol_price_usd: solPriceUsd,
    current_price_usd: entryPriceUsd,
    current_sol_price_usd: solPriceUsd,

    // PnL tracking
    pnl_usd: 0,
    pnl_pct: 0,
    simulated_fees_usd: 0,
    simulated_fees_sol: 0,
    total_return_usd: 0,
    total_return_pct: 0,

    // Range tracking
    in_range: true,
    minutes_out_of_range: 0,
    out_of_range_since: null,

    // Pool metrics at entry
    entry_fee_tvl_ratio: poolMetrics?.fee_active_tvl_ratio ?? deployArgs.fee_tvl_ratio ?? null,
    entry_volatility: poolMetrics?.volatility ?? deployArgs.volatility ?? null,
    entry_bin_step: poolMetrics?.bin_step ?? deployArgs.bin_step ?? null,
    entry_active_bin: poolMetrics?.active_bin ?? null,

    // Metadata
    deployed_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    update_count: 0,
    closed: false,
  };

  const state = loadState();
  state.paperPositions[positionId] = position;

  // Push to recentEvents
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({
    ts: new Date().toISOString(),
    action: "paper_deploy",
    position: positionId,
    pool_name: position.pair,
    amount_sol: amountSol,
  });
  if (state.recentEvents.length > 20) state.recentEvents = state.recentEvents.slice(-20);

  saveState(state);

  log("paper", `📝 Paper position created: ${position.pair} | ${amountSol} SOL | entry $${entryPriceUsd?.toFixed(6) || "?"} | pool ${poolAddress.slice(0, 8)}`);

  appendDecision({
    type: "deploy",
    actor: "SCREENER",
    pool: poolAddress,
    pool_name: position.pair,
    position: positionId,
    summary: `[PAPER] Deployed ${amountSol} SOL with ${position.strategy}`,
    reason: `Paper position — entry price $${entryPriceUsd?.toFixed(6) || "unknown"}`,
    metrics: {
      amount_sol: amountSol,
      strategy: position.strategy,
      entry_price: entryPriceUsd,
      bins_below: position.bins_below,
      bins_above: position.bins_above,
    },
  });

  return position;
}

/**
 * Update all open paper positions with live price data.
 * Called every management cycle.
 */
export async function updatePaperPositions() {
  const state = loadState();
  const openPositions = Object.values(state.paperPositions).filter(p => !p.closed);

  if (openPositions.length === 0) return { updated: 0, positions: [] };

  // Collect unique mints to batch price fetch
  const mints = [...new Set(openPositions.map(p => p.base_mint).filter(Boolean))];
  if (!mints.includes(SOL_MINT)) mints.push(SOL_MINT);

  // Batch price fetch
  let priceMap = {};
  try {
    const url = `${JUPITER_PRICE_API}?ids=${mints.join(",")}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      for (const [mint, info] of Object.entries(data?.data || {})) {
        priceMap[mint] = parseFloat(info.price);
      }
    }
  } catch (err) {
    log("paper_warn", `Batch price fetch failed: ${err.message}`);
  }

  const solPriceUsd = priceMap[SOL_MINT] || null;
  const results = [];

  for (const pos of openPositions) {
    let currentPrice = pos.base_mint ? (priceMap[pos.base_mint] ?? null) : null;
    const now = new Date();
    const deployedAt = new Date(pos.deployed_at);
    const minutesHeld = Math.floor((now - deployedAt) / 60000);
    const minutesSinceLastUpdate = pos.last_updated
      ? Math.floor((now - new Date(pos.last_updated)) / 60000)
      : minutesHeld;

    // Backfill base_mint and prices from pool API if missing
    if (!pos.base_mint || currentPrice == null || pos.entry_price_usd == null) {
      try {
        const poolMetrics = await fetchPoolMetrics(pos.pool);
        if (poolMetrics) {
          if (!pos.base_mint && poolMetrics.base_mint) pos.base_mint = poolMetrics.base_mint;
          if (poolMetrics.base_price_usd != null) currentPrice = poolMetrics.base_price_usd;
          if (pos.entry_price_usd == null && poolMetrics.base_price_usd != null) {
            pos.entry_price_usd = poolMetrics.base_price_usd;
          }
          if (pos.entry_sol_price_usd == null && poolMetrics.quote_price_usd != null) {
            pos.entry_sol_price_usd = poolMetrics.quote_price_usd;
          }
          if (pos.initial_value_usd == null && pos.entry_sol_price_usd != null) {
            pos.initial_value_usd = pos.amount_sol * pos.entry_sol_price_usd;
          }
        }
      } catch { /* best effort */ }
    }

    // ── Update price & PnL ──────────────────────────────────────
    if (currentPrice != null) {
      pos.current_price_usd = currentPrice;
    }
    if (solPriceUsd != null) {
      pos.current_sol_price_usd = solPriceUsd;
    }

    // Price PnL (impermanent loss approximation for single-sided SOL)
    // For single-side SOL LP: if token price drops, your SOL value stays but you now hold
    // more of the depreciating token. Simplified: PnL ≈ price change % / 2
    if (pos.entry_price_usd != null && pos.current_price_usd != null && pos.entry_price_usd > 0) {
      const priceChangePct = ((pos.current_price_usd - pos.entry_price_usd) / pos.entry_price_usd) * 100;
      // Single-sided SOL IL approximation: you capture ~half the price movement
      const ilPct = priceChangePct < 0 ? priceChangePct * 0.5 : priceChangePct * 0.3;
      const currentValueUsd = pos.initial_value_usd ? pos.initial_value_usd * (1 + ilPct / 100) : null;
      pos.pnl_usd = currentValueUsd != null ? Math.round((currentValueUsd - pos.initial_value_usd) * 10000) / 10000 : 0;
      pos.pnl_pct = Math.round(ilPct * 100) / 100;
    }

    // ── Simulate fee accrual ────────────────────────────────────
    // fee_per_tvl_24h is in % per 24h. Scale to the update interval.
    if (pos.entry_fee_tvl_ratio != null && pos.initial_value_usd != null && minutesSinceLastUpdate > 0) {
      // Fetch fresh fee/TVL if available, else use entry value
      let feeRatio = pos.entry_fee_tvl_ratio;
      try {
        const freshMetrics = await fetchPoolMetrics(pos.pool);
        if (freshMetrics?.fee_active_tvl_ratio) feeRatio = freshMetrics.fee_active_tvl_ratio;
      } catch { /* use entry ratio */ }

      // feeRatio is fee/TVL per hour (1h timeframe). Scale to minutes elapsed.
      const feePerMinutePct = feeRatio / 60;
      const feesThisPeriodPct = feePerMinutePct * minutesSinceLastUpdate;
      const feesThisPeriodUsd = (pos.initial_value_usd * feesThisPeriodPct) / 100;

      pos.simulated_fees_usd = Math.round((pos.simulated_fees_usd + feesThisPeriodUsd) * 10000) / 10000;
      if (solPriceUsd && solPriceUsd > 0) {
        pos.simulated_fees_sol = Math.round((pos.simulated_fees_usd / solPriceUsd) * 100000) / 100000;
      }
    }

    // ── Total return (PnL + fees) ───────────────────────────────
    pos.total_return_usd = Math.round((pos.pnl_usd + pos.simulated_fees_usd) * 10000) / 10000;
    pos.total_return_pct = pos.initial_value_usd > 0
      ? Math.round((pos.total_return_usd / pos.initial_value_usd) * 10000) / 100
      : 0;

    // ── Range status ────────────────────────────────────────────
    // Approximate: if token price moved > bins_below * bin_step%, we're out of range
    if (pos.entry_price_usd != null && pos.current_price_usd != null && pos.entry_bin_step != null) {
      const priceDrop = ((pos.entry_price_usd - pos.current_price_usd) / pos.entry_price_usd) * 100;
      const binStepPct = pos.entry_bin_step / 100; // bin_step 80 = 0.8% per bin
      const rangeDownPct = pos.bins_below * binStepPct;
      const rangeUpPct = pos.bins_above * binStepPct;

      const wasInRange = pos.in_range;
      pos.in_range = priceDrop <= rangeDownPct && -priceDrop <= rangeUpPct;

      if (!pos.in_range && wasInRange) {
        pos.out_of_range_since = now.toISOString();
      } else if (pos.in_range && !wasInRange) {
        pos.out_of_range_since = null;
        pos.minutes_out_of_range = 0;
      }

      if (!pos.in_range && pos.out_of_range_since) {
        pos.minutes_out_of_range = Math.floor((now - new Date(pos.out_of_range_since)) / 60000);
      }
    }

    pos.age_minutes = minutesHeld;
    pos.last_updated = now.toISOString();
    pos.update_count += 1;

    state.paperPositions[pos.id] = pos;
    results.push(pos);
  }

  saveState(state);

  if (results.length > 0) {
    log("paper", `📊 Updated ${results.length} paper position(s): ${results.map(p => `${p.pair} PnL ${p.pnl_pct}% fees $${p.simulated_fees_usd.toFixed(4)}`).join(" | ")}`);
  }

  return { updated: results.length, positions: results };
}

/**
 * Close a paper position and move to closed log.
 */
export async function closePaperPosition(positionId, reason = "manual") {
  const state = loadState();
  const pos = state.paperPositions[positionId];
  if (!pos) {
    log("paper_warn", `Paper position ${positionId} not found`);
    return null;
  }

  // Final price update
  if (pos.base_mint) {
    const prices = await fetchTokenPrice(pos.base_mint);
    if (prices?.price_usd) pos.current_price_usd = prices.price_usd;
    if (prices?.sol_price_usd) pos.current_sol_price_usd = prices.sol_price_usd;
  }

  const now = new Date();
  pos.closed = true;
  pos.closed_at = now.toISOString();
  pos.close_reason = reason;
  pos.minutes_held = Math.floor((now - new Date(pos.deployed_at)) / 60000);

  // Final PnL calc
  if (pos.entry_price_usd && pos.current_price_usd && pos.entry_price_usd > 0) {
    const priceChangePct = ((pos.current_price_usd - pos.entry_price_usd) / pos.entry_price_usd) * 100;
    const ilPct = priceChangePct < 0 ? priceChangePct * 0.5 : priceChangePct * 0.3;
    pos.pnl_pct = Math.round(ilPct * 100) / 100;
    if (pos.initial_value_usd) {
      pos.pnl_usd = Math.round(pos.initial_value_usd * ilPct / 100 * 10000) / 10000;
    }
  }
  pos.total_return_usd = Math.round((pos.pnl_usd + pos.simulated_fees_usd) * 10000) / 10000;
  pos.total_return_pct = pos.initial_value_usd > 0
    ? Math.round((pos.total_return_usd / pos.initial_value_usd) * 10000) / 100
    : 0;

  // Move to closed list
  if (!state.closedPaperPositions) state.closedPaperPositions = [];
  state.closedPaperPositions.push({ ...pos });
  delete state.paperPositions[positionId];

  // Push recent event
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({
    ts: now.toISOString(),
    action: "paper_close",
    position: positionId,
    pool_name: pos.pair,
    pnl_pct: pos.pnl_pct,
    total_return_pct: pos.total_return_pct,
    reason,
  });
  if (state.recentEvents.length > 20) state.recentEvents = state.recentEvents.slice(-20);

  saveState(state);

  log("paper", `📕 Paper position closed: ${pos.pair} | PnL ${pos.pnl_pct}% | Fees $${pos.simulated_fees_usd.toFixed(4)} | Total ${pos.total_return_pct}% | Reason: ${reason}`);

  // Feed into the learning system so evolveThresholds and lesson generation work
  try {
    const minutesOOR = pos.minutes_out_of_range || 0;
    await recordPerformance({
      position: pos.id,
      pool: pos.pool,
      pool_name: pos.pair,
      base_mint: pos.base_mint || null,
      strategy: pos.strategy,
      bin_step: pos.entry_bin_step || null,
      volatility: pos.entry_volatility ?? null,
      fee_tvl_ratio: pos.entry_fee_tvl_ratio || null,
      amount_sol: pos.amount_sol,
      fees_earned_usd: pos.simulated_fees_usd,
      fees_earned_sol: pos.simulated_fees_sol || 0,
      final_value_usd: (pos.initial_value_usd || 0) + pos.pnl_usd,
      initial_value_usd: pos.initial_value_usd || 0,
      minutes_in_range: pos.minutes_held - minutesOOR,
      minutes_held: pos.minutes_held,
      close_reason: reason,
      deployed_at: pos.deployed_at,
      paper: true,
    });
    log("paper", `📚 Performance recorded for lessons: ${pos.pair}`);
  } catch (e) {
    log("paper_error", `Failed to record performance: ${e.message}`);
  }

  appendDecision({
    type: "close",
    actor: "MANAGER",
    pool: pos.pool,
    pool_name: pos.pair,
    position: positionId,
    summary: `[PAPER] Closed ${pos.pair}`,
    reason: `${reason} — PnL ${pos.pnl_pct}%, fees $${pos.simulated_fees_usd.toFixed(4)}, total return ${pos.total_return_pct}%`,
    metrics: {
      pnl_pct: pos.pnl_pct,
      pnl_usd: pos.pnl_usd,
      fees_usd: pos.simulated_fees_usd,
      total_return_pct: pos.total_return_pct,
      minutes_held: pos.minutes_held,
    },
  });

  return pos;
}

// ─── Query Functions ───────────────────────────────────────────

/**
 * Get all open paper positions.
 */
export function getPaperPositions() {
  const state = loadState();
  return Object.values(state.paperPositions || {}).filter(p => !p.closed);
}

/**
 * Get closed paper positions.
 */
export function getClosedPaperPositions(limit = 50) {
  const state = loadState();
  return (state.closedPaperPositions || []).slice(-limit);
}

/**
 * Get paper position count (for position limit checks).
 */
export function getPaperPositionCount() {
  return getPaperPositions().length;
}

/**
 * Find a paper position by pool address.
 */
export function findPaperPositionByPool(poolAddress) {
  return getPaperPositions().find(p => p.pool === poolAddress) || null;
}

/**
 * Get paper positions formatted like getMyPositions output
 * so the management cycle can process them uniformly.
 */
export function getPaperPositionsAsLive() {
  const positions = getPaperPositions();
  return {
    wallet: "paper-wallet",
    total_positions: positions.length,
    positions: positions.map(p => ({
      position: p.id,
      pool: p.pool,
      pair: p.pair,
      base_mint: p.base_mint,
      lower_bin: null,
      upper_bin: null,
      active_bin: p.entry_active_bin,
      in_range: p.in_range,
      unclaimed_fees_usd: p.simulated_fees_usd,
      total_value_usd: p.initial_value_usd ? p.initial_value_usd + p.pnl_usd : null,
      pnl_usd: p.pnl_usd,
      pnl_pct: p.pnl_pct,
      pnl_pct_suspicious: false,
      fee_per_tvl_24h: p.entry_fee_tvl_ratio,
      age_minutes: p.age_minutes || 0,
      minutes_out_of_range: p.minutes_out_of_range || 0,
      instruction: null,
      paper: true,
    })),
  };
}

/**
 * Get paper performance summary.
 */
export function getPaperPerformanceSummary() {
  const open = getPaperPositions();
  const closed = getClosedPaperPositions(200);

  const openValue = open.reduce((s, p) => s + (p.initial_value_usd || 0) + (p.pnl_usd || 0), 0);
  const openFees = open.reduce((s, p) => s + (p.simulated_fees_usd || 0), 0);
  const closedPnl = closed.reduce((s, p) => s + (p.total_return_usd || 0), 0);
  const closedWins = closed.filter(p => p.total_return_usd > 0).length;

  return {
    open_positions: open.length,
    open_value_usd: Math.round(openValue * 100) / 100,
    open_unrealized_fees_usd: Math.round(openFees * 100) / 100,
    closed_positions: closed.length,
    closed_total_pnl_usd: Math.round(closedPnl * 100) / 100,
    closed_win_rate_pct: closed.length > 0 ? Math.round((closedWins / closed.length) * 100) : null,
  };
}

/**
 * Check paper exit conditions (stop loss, OOR, low yield).
 * Returns positions that should be closed.
 */
export function checkPaperExits() {
  const positions = getPaperPositions();
  const exits = [];

  for (const pos of positions) {
    // Stop loss
    if (pos.pnl_pct != null && config.management.stopLossPct != null && pos.pnl_pct <= config.management.stopLossPct) {
      exits.push({ id: pos.id, reason: `Stop loss: PnL ${pos.pnl_pct}% <= ${config.management.stopLossPct}%` });
      continue;
    }
    // Take profit (total return including fees)
    if (pos.total_return_pct != null && config.management.takeProfitPct != null && pos.total_return_pct >= config.management.takeProfitPct) {
      exits.push({ id: pos.id, reason: `Take profit: total return ${pos.total_return_pct}% >= ${config.management.takeProfitPct}%` });
      continue;
    }
    // OOR too long
    if (!pos.in_range && pos.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
      exits.push({ id: pos.id, reason: `Out of range for ${pos.minutes_out_of_range}m (limit: ${config.management.outOfRangeWaitMinutes}m)` });
      continue;
    }
    // Low yield (after min age)
    const ageMinutes = pos.age_minutes || 0;
    if (pos.entry_fee_tvl_ratio != null && config.management.minFeePerTvl24h != null
      && pos.entry_fee_tvl_ratio < config.management.minFeePerTvl24h
      && ageMinutes >= (config.management.minAgeBeforeYieldCheck ?? 60)) {
      exits.push({ id: pos.id, reason: `Low yield: fee/TVL ${pos.entry_fee_tvl_ratio}% < min ${config.management.minFeePerTvl24h}%` });
      continue;
    }
    // Max hold time — 60-120m bucket has 6% win rate; positions that haven't
    // hit TP by maxHoldMinutes are statistically dead weight.
    if (config.management.maxHoldMinutes != null && ageMinutes >= config.management.maxHoldMinutes
      && pos.total_return_pct < config.management.takeProfitPct) {
      exits.push({ id: pos.id, reason: `Max hold time: ${ageMinutes}m >= ${config.management.maxHoldMinutes}m limit (return ${pos.total_return_pct}%)` });
    }
  }

  return exits;
}
