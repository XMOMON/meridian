#!/usr/bin/env node
/**
 * apply-paper-trader-patch.mjs
 *
 * Surgically patches index.js to wire up paper-trader.js.
 * Run once from your bot root directory:
 *
 *   node apply-paper-trader-patch.mjs
 *
 * A timestamped backup (index.js.bak.<timestamp>) is created before any edit.
 * The script is idempotent — running it twice is safe (it detects existing patches).
 */

import fs from "fs";
import path from "path";

const TARGET = "./index.js";

if (!fs.existsSync(TARGET)) {
  console.error(`❌  ${TARGET} not found. Run this script from your bot root directory.`);
  process.exit(1);
}

// ── Backup ────────────────────────────────────────────────────────────────────
const backup = `${TARGET}.bak.${Date.now()}`;
fs.copyFileSync(TARGET, backup);
console.log(`✅  Backup created: ${backup}`);

// ── Read (normalise Windows line endings → \n for matching) ───────────────────
let src = fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");
let changed = 0;

function patch(label, find, replace) {
  if (src.includes(replace.split("\n")[0].trim())) {
    console.log(`⏭   ${label} — already applied, skipping`);
    return;
  }
  if (!src.includes(find)) {
    console.error(`❌  ${label} — search string NOT found. Check the file manually.`);
    console.error(`    First 80 chars of search string:\n    ${find.slice(0, 80)}`);
    process.exit(1);
  }
  src = src.replace(find, replace);
  changed++;
  console.log(`✅  ${label} — applied`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 1 — Import paper-trader.js
// ═══════════════════════════════════════════════════════════════════════════════
patch(
  "PATCH 1 — import paper-trader.js",

  `import { appendDecision } from "./decision-log.js";`,

  `import { appendDecision } from "./decision-log.js";
import {
  trackPaperDeploy,
  updatePaperPositions,
  closePaperPosition,
  checkPaperPositionCloseRule,
} from "./paper-trader.js";`
);

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 2 — Update paper positions at the start of every management cycle,
//           before the early-return that fires when no live positions exist.
// ═══════════════════════════════════════════════════════════════════════════════
patch(
  "PATCH 2 — management cycle paper-position update + close-check",

  `    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      runScreeningCycle().catch((e) => log("cron_error", \`Triggered screening failed: \${e.message}\`));
      return mgmtReport;
    }`,

  `    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    // ── Paper trading: update PnL + close-check (dry run only) ──────────────
    if (process.env.DRY_RUN === "true") {
      try {
        const updatedPaper = await updatePaperPositions();
        for (const pp of updatedPaper) {
          if (pp.closed) continue;
          const closeRule = checkPaperPositionCloseRule(pp, config.management);
          if (closeRule) {
            closePaperPosition(pp.id, closeRule.reason);
            log("paper_trader", \`Auto-closed paper position \${pp.pool_name}: \${closeRule.reason}\`);
            if (!silent && telegramEnabled()) {
              sendMessage(
                \`📄 [PAPER TRADE] Closed \${pp.pool_name}\\n\` +
                \`PnL: \${pp.pnl_pct?.toFixed(2) ?? "?"}% ($\${pp.pnl_usd?.toFixed(4) ?? "?"})\\n\` +
                \`Fees: $\${pp.simulated_fees_usd?.toFixed(4) ?? "?"}\\n\` +
                \`Reason: \${closeRule.reason}\`
              ).catch(() => {});
            }
          }
        }
      } catch (err) {
        log("cron_error", \`Paper position update failed: \${err.message}\`);
      }
    }

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      runScreeningCycle().catch((e) => log("cron_error", \`Triggered screening failed: \${e.message}\`));
      return mgmtReport;
    }`
);

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 3 — Capture deploy args + result in runScreeningCycle
// ═══════════════════════════════════════════════════════════════════════════════
patch(
  "PATCH 3 — add paper deploy capture variables",

  `    let deployAttempted = false;
    let deploySucceeded = false;`,

  `    let deployAttempted = false;
    let deploySucceeded = false;
    let _paperDeployArgs   = null;   // dry-run: args passed to deploy_position
    let _paperDeployResult = null;   // dry-run: tool result from deploy_position`
);

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 4 — Capture args in onToolStart
// ═══════════════════════════════════════════════════════════════════════════════
patch(
  "PATCH 4 — onToolStart capture deploy args",

  `        onToolStart: async ({ name }) => {
          if (name === "deploy_position") deployAttempted = true;
          await liveMessage?.toolStart(name);
        },`,

  `        onToolStart: async ({ name, args }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            if (process.env.DRY_RUN === "true") _paperDeployArgs = args ?? null;
          }
          await liveMessage?.toolStart(name);
        },`
);

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 5 — Capture result in onToolFinish
// ═══════════════════════════════════════════════════════════════════════════════
patch(
  "PATCH 5 — onToolFinish capture deploy result",

  `        onToolFinish: async ({ name, result, success }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            deploySucceeded = Boolean(success && result?.success !== false && !result?.error && !result?.blocked);
          }
          await liveMessage?.toolFinish(name, result, success);
        },`,

  `        onToolFinish: async ({ name, result, success }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            deploySucceeded = Boolean(success && result?.success !== false && !result?.error && !result?.blocked);
            if (process.env.DRY_RUN === "true" && deploySucceeded) {
              _paperDeployResult = result ?? null;
            }
          }
          await liveMessage?.toolFinish(name, result, success);
        },`
);

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 6 — Record paper position immediately after agentLoop returns
// ═══════════════════════════════════════════════════════════════════════════════
patch(
  "PATCH 6 — record paper deploy after agentLoop",

  `    screenReport = content;
    if (/⛔\\s*NO DEPLOY/i.test(content)) {`,

  `    screenReport = content;

    // ── Paper trading: record simulated position (dry run only) ─────────────
    if (process.env.DRY_RUN === "true" && deploySucceeded && _paperDeployArgs) {
      try {
        const poolAddress = _paperDeployArgs.pool_address;
        const matchingCandidate = passing.find(({ pool }) => pool.pool === poolAddress);
        await trackPaperDeploy({
          poolAddress,
          poolName:
            _paperDeployArgs.pool_name ||
            matchingCandidate?.pool?.name ||
            "Unknown",
          baseMint:
            _paperDeployArgs.base_mint ||
            matchingCandidate?.pool?.base?.mint ||
            null,
          deployedSol: _paperDeployArgs.amount_y ?? deployAmount,
          rangeCoverage: _paperDeployResult?.range_coverage ?? {},
          feeTvlRatio:
            _paperDeployArgs.fee_tvl_ratio ??
            matchingCandidate?.pool?.fee_active_tvl_ratio ??
            0,
          deployResult: _paperDeployResult ?? {},
        });
      } catch (err) {
        log("paper_trader", \`Failed to record paper deploy: \${err.message}\`);
      }
    }

    if (/⛔\\s*NO DEPLOY/i.test(content)) {`
);

// ── Write back ────────────────────────────────────────────────────────────────
if (changed === 0) {
  console.log("\nℹ️   No changes were applied (all patches already present).");
} else {
  fs.writeFileSync(TARGET, src, "utf8");
  console.log(`\n✅  ${changed} patch(es) applied to ${TARGET}`);
  console.log("    Restart your bot to activate paper trading.\n");
  console.log("    state.json will now gain two new keys:");
  console.log('      "paperPositions"       — open simulated positions');
  console.log('      "closedPaperPositions" — closed position log\n');
}
