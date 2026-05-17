# Meridian Trading Bot - Active Strategy & Review Routine

## Owner
XMOMON (GitHub: https://github.com/XMOMON/meridian)
Forked from: https://github.com/yunus-0x/meridian

## Project Location
C:\Users\Administrator\Downloads\meridian

## What Is It
Autonomous Solana DLMM LP bot on Meteora. Paper trading mode. Uses free OpenRouter LLMs for screening/management decisions. Runs via PM2.

## Strategy Changes Made (2026-05-18)

### Option A — Tighter Screening
- minOrganic: 50 → 60
- minHolders: 300 → 400
- minMcap: 100k → 150k
- maxMcap: 15M → 10M
- minTokenFeesSol: 20 → 25
- maxBotHoldersPct: 35 → 30
- maxTop10Pct: 65 → 60
- blockPvpSymbols: false → true
- minVolatility: NEW → 1.5 (skip dead pools)
- screeningIntervalMin: 12 → 20

### Option B — Faster Exits
- stopLossPct: -6.1 → -2.5
- takeProfitPct: 3 → 2
- trailingTriggerPct: 4 → 2
- trailingDropPct: 1 → 0.8
- maxHoldMinutes: 32 → 25
- minAgeBeforeYieldCheck: 20 → 10
- outOfRangeWaitMinutes: 15 → 12
- repeatDeployCooldownTriggerCount: 2 → 1
- repeatDeployCooldownHours: 6 → 24

### Option C — Time-of-Day Filter
- screeningActiveHoursUtc: NEW → [18,19,20,21,22,23]
- Only deploys during 18:00-23:59 UTC (01:00-07:00 UTC+7)
- Management still runs 24/7

### Deploy Rules Overhaul
- Old: linear formula bins_below = 35-69 based on volatility
- New: fixed tiers — vol<2→8 bins, vol 2-3→12 bins, vol 3-5→18 bins, vol>5→SKIP
- LLM must calculate range coverage before deploying
- Never bins_below < 8

### Auto-Tuner Guards
- Lowered SL floor from -3% to -2% (so auto-tuner won't loosen our -2.5%)
- Lowered TP floor from 2.5% to 1.5% (so auto-tuner won't raise our 2%)

## Review Routine (Starting 2026-05-18)
- Morning → check overnight PnL report
- Evening → check win/loss ratio and exit reasons
- Day 3 (2026-05-21) → compare OOR% before vs after
- Day 5 (2026-05-23) → decide if ready for live

## Key Metrics Before Changes (baseline)
- 258 trades, 50% win rate, -$56.94 total PnL
- 140 low_yield exits (-$86.97), 19 stop losses (-$111.31)
- Best time: 18-24 UTC (60% WR), worst: 12-18 UTC (49% WR)
- Best volatility: low 1-2 (59% WR), worst: extreme >5 (33% WR)
- Best hold: 0-15m (74% WR), worst: 1-2h (17% WR)
- OOR exits: 22% of total, actually profitable (+$31.95)
- 4-day red streak, -$33.52 over 7 days

## What To Watch For
- Low_yield exit count should drop significantly
- Stop loss hits should be smaller (~$1.10 instead of ~$2.50)
- No deploys outside 18-23 UTC
- Fewer total trades (15-20/day instead of 40+)
- Repeat losers should be impossible (1-strike 24h cooldown)
- OOR exits with tighter bins should still be profitable but happen sooner
