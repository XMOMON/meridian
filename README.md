<div align="center">

# 🌐 MERIDIAN

### Autonomous Solana Liquidity Agent

*Deploy. Monitor. Learn. Evolve.*

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Solana](https://img.shields.io/badge/Solana-Mainnet-9945FF?style=for-the-badge&logo=solana&logoColor=white)](https://solana.com)
[![Meteora](https://img.shields.io/badge/Meteora-DLMM-FF6B35?style=for-the-badge)](https://meteora.ag)
[![Telegram](https://img.shields.io/badge/Telegram-Bot-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

---

> ⚠️ **Experimental** — This bot is under active development and is not yet consistently profitable. The learning system is evolving and parameters are being tuned. Always use `DRY_RUN=true` (paper trading) to evaluate before risking real funds.

---

**Meridian** is an autonomous AI-powered agent that manages liquidity positions on **Meteora DLMM pools** across Solana. It screens opportunities, deploys capital, monitors positions in real-time, and learns from every trade to continuously improve its strategy.

[Getting Started](#-quick-start) · [Features](#-features) · [Architecture](#-architecture) · [Config](#-config-reference)

</div>

---

## ⚡ Features

<table>
<tr>
<td width="50%">

### 🔍 Intelligent Screening
- Scans Meteora DLMM pools against 20+ configurable thresholds
- Fee/TVL ratio, organic score, holder analysis, mcap filters
- Smart money signal integration via OKX OnchainOS
- Token audit pipeline (bundler detection, supply concentration)
- **Time-of-day filter** — only deploy during profitable hours
- **Volatility band** — min/max volatility to skip dead or chaotic pools

</td>
<td width="50%">

### 🤖 Autonomous Management
- ReAct agent loop — LLM reasons over live data and acts
- Trailing take-profit with confirmation rechecks
- Stop loss, out-of-range, low yield, and max hold exits
- Auto fee claiming and position rebalancing
- Deterministic rule engine (no LLM needed for clear exits)

</td>
</tr>
<tr>
<td width="50%">

### 🧠 Self-Evolving Strategy
- Records lessons from every closed position
- **Trade Profile** — statistical analysis of all trades by hold time, volatility, time-of-day
- **Darwin mode** — auto-tunes screening thresholds from win/loss patterns
- **Risk param tuning** — auto-adjusts SL, TP, trailing based on real data
- Pool memory prevents repeat mistakes
- Repeat loser cooldown (token-level bans)

</td>
<td width="50%">

### 📱 Full Remote Control
- Telegram bot with live notifications and chat
- Deploy, close, and monitor from your phone
- Interactive REPL with live cycle countdowns
- Complete CLI for scripting and automation
- Daily PnL reports + morning briefings

</td>
</tr>
</table>

---

## 📊 How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                      MERIDIAN AGENT LOOP                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐              │
│   │ SCREENING│────▶│ ANALYSIS │────▶│  DEPLOY  │              │
│   │  AGENT   │     │ + AUDIT  │     │ DECISION │              │
│   └──────────┘     └──────────┘     └────┬─────┘              │
│        ▲                                  │                     │
│        │           ┌──────────┐           │                     │
│        │           │ LESSONS  │◀──────────┤                     │
│        │           │ + EVOLVE │           │                     │
│        │           └──────────┘           ▼                     │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐              │
│   │MANAGEMENT│◀────│  PnL +   │◀────│ POSITION │              │
│   │  AGENT   │     │  RANGE   │     │ TRACKING │              │
│   └──────────┘     └──────────┘     └──────────┘              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

| Agent | Interval | Role |
|:------|:---------|:-----|
| **🔍 Screener** | Every 20 min | Find and deploy into the best candidate pool |
| **📋 Manager** | Every 3 min | Evaluate positions — hold, claim fees, or close |
| **🧠 Learner** | Every 5 closes | Evolve thresholds + tune risk params |

### Data Sources
- **`@meteora-ag/dlmm` SDK** — On-chain position data, deploy/close transactions
- **Meteora Pool Discovery API** — Pool metrics, fee/TVL, volatility
- **OKX OnchainOS** — Smart money signals, token risk scoring
- **Jupiter API** — Token audit, mcap, price stats, launchpad info

---

## 🚀 Quick Start

### 1. Install Node.js

Meridian requires **Node.js 18+**.

- **Windows:** Download from [nodejs.org](https://nodejs.org/) (LTS recommended) → Run installer → Restart terminal
- **Mac:** `brew install node`
- **Linux:** `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs`

Verify: `node --version` should show `v18.x.x` or higher.

### 2. Clone & Install

```bash
git clone https://github.com/XMOMON/meridian.git
cd meridian
npm install
```

### 3. Get a Solana Wallet

You need a **base58 private key** for the wallet Meridian will trade with.

<details>
<summary><b>Option A — Create a new wallet (recommended for bot use)</b></summary>

```bash
# Install Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Create a new wallet
solana-keygen new --outfile ~/meridian-wallet.json

# Export the base58 private key
node -e "const k=require('fs').readFileSync(require('os').homedir()+'/meridian-wallet.json');const bs58=require('bs58');console.log(bs58.encode(Buffer.from(JSON.parse(k))))"
```

Copy the output — that's your `WALLET_PRIVATE_KEY`.

</details>

<details>
<summary><b>Option B — Export from Phantom / Solflare</b></summary>

1. Open **Phantom** → ⚙️ Settings → 🔑 **Export Private Key**
2. Enter your password
3. Copy the base58 string — that's your `WALLET_PRIVATE_KEY`

> ⚠️ Use a **dedicated wallet** for the bot. Never use your main wallet.

</details>

Fund the wallet with SOL (at least **1 SOL** for paper trading, more for live).

---

### 4. Get a Helius RPC Endpoint

Helius provides fast, reliable Solana RPC access. The **free tier** gives you **500K credits/day** — enough for Meridian.

1. Go to **[helius.dev](https://www.helius.dev/)** and click **Start Building**
2. Sign up with GitHub or email
3. Click **New Project** → name it `meridian`
4. Your RPC URL is: `https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY`

---

### 5. Get an OpenRouter API Key

OpenRouter gives Meridian access to AI models — including **free models**.

1. Go to **[openrouter.ai](https://openrouter.ai/)** and sign up
2. Click your profile → **Keys** → **Create Key**
3. Copy the key (starts with `sk-or-...`)

> 💡 **Free models available!** Meridian works with free models like `minimax/minimax-m2.5:free`. Check [openrouter.ai/models](https://openrouter.ai/models) for options.

#### Model Selection

| Model | Cost | Best For |
|:------|:-----|:---------|
| `minimax/minimax-m2.5:free` | Free | Default, solid reasoning |
| `openai/gpt-oss-120b:free` | Free | Alternative free option |
| `google/gemini-2.5-flash` | ~$0.001/cycle | Great speed + quality |
| `anthropic/claude-sonnet-4` | ~$0.01/cycle | Best reasoning |

---

### 6. Set Up Telegram Bot (Optional but Recommended)

1. Open Telegram → search **[@BotFather](https://t.me/BotFather)** → send `/newbot`
2. Choose a name and username
3. Copy the token (e.g. `7123456789:AAH...`)
4. Get your chat ID: send a message to your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates`
5. Get your user ID from [@userinfobot](https://t.me/userinfobot)

---

### 7. Create Your `.env` File

```env
# Wallet
WALLET_PRIVATE_KEY=your_base58_private_key_here

# RPC (Helius)
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# AI (OpenRouter)
OPENROUTER_API_KEY=sk-or-v1-your_key_here

# Telegram (optional)
TELEGRAM_BOT_TOKEN=7123456789:AAHxxxxxx
TELEGRAM_CHAT_ID=your_chat_id
TELEGRAM_ALLOWED_USER_IDS=your_user_id

# Mode
DRY_RUN=true
```

> ⚠️ **Never share your `.env` file.** It's gitignored by default.

### 8. Create Your Config

```bash
cp user-config.example.json user-config.json
```

Or run the interactive wizard:
```bash
npm run setup
```

---

### 9. Run

```bash
# Paper trading (safe, no real transactions)
npm run dev

# Live mode (real SOL!)
npm start

# Background with PM2 (recommended for VPS)
npm install -g pm2
npm run pm2:start
pm2 save
```

> ⚠️ **Always start with `DRY_RUN=true`** to verify behavior before going live.

---

## 🎮 Usage

### Autonomous Agent

The agent starts with a live REPL:

```
[manage: 2m 12s | screen: 8m 3s]
>
```

| Command | Description |
|:--------|:------------|
| `/status` | Wallet balance and open positions |
| `/candidates` | Re-screen top pool candidates |
| `/learn` | Study top LPers across candidate pools |
| `/thresholds` | Current thresholds + performance stats |
| `/evolve` | Trigger threshold evolution |
| `/pnl` | Today's PnL breakdown |
| `/pnl week` | 7-day PnL summary |
| `<anything>` | Free-form chat with the agent |

### Telegram Commands

| Command | Action |
|:--------|:-------|
| `/positions` | List open positions with PnL |
| `/close <n>` | Close position by index |
| `/set <n> <note>` | Set instruction on a position |
| `/briefing` | Daily performance briefing |
| `/pnl` | Today's PnL report |
| *Free text* | Chat with the agent |

---

## 📐 Exit Strategy

| Exit Type | Trigger | Description |
|:----------|:--------|:------------|
| 🎯 **Take Profit** | Total return ≥ TP% | Trailing TP with confirmation recheck |
| 🛑 **Stop Loss** | PnL ≤ SL% | Immediate close to cap downside |
| 📐 **Out of Range** | OOR > N minutes | Position no longer earning fees |
| 📉 **Low Yield** | fee/TVL below min | Pool dried up after min age check |
| ⏱️ **Max Hold** | Age > limit | Dead weight — hasn't hit TP |
| 🔄 **Trailing TP** | Drops X% from peak | Locks in gains after trigger |

---

## 🧠 Learning System

### How Meridian Actually Learns

Every 5 closed positions, three systems fire:

**1. Threshold Evolution** (`lessons.js`)
- Compares winner vs loser distributions (volatility, fee/TVL, organic score)
- Nudges screening thresholds toward winner characteristics (max 20% per step)
- Writes changes directly to `user-config.json`

**2. Risk Param Tuning** (`trade-profile.js`)
- Analyzes loss distribution → optimizes stop loss
- Analyzes win distribution → optimizes take profit
- Analyzes hold time buckets → optimizes max hold
- Analyzes trailing closes → optimizes trailing drop

**3. Darwin Signal Weights** (`signal-weights.js`)
- Tracks which screening signals predict profitable positions
- Boosts signals that correlate with wins, decays those that don't
- Weights injected into LLM prompt to prioritize the right criteria

### Trade Profile

Statistical breakdown injected into every LLM decision:

```
TRADE PROFILE (258 closed trades)
Overall: 52% win rate | avg PnL -0.51% | avg fees $0.32 | avg hold 55m
Best hold time: 0-15m (74% win, 19 trades)
Worst hold time: 1-2h (17% win, 24 trades) — AVOID holding this long
Best volatility: low(1-2) (59% win, 88 trades)
Worst volatility: extreme(>5) (33% win, 21 trades) — AVOID
Time pattern: best 18-24 UTC (60%W) | worst 12-18 UTC (49%W)
⚠️ Repeat losers (24h): Yae (3x, -$6.65), BABYTROLL (3x, -$1.90) — AVOID
```

---

## ⚙️ Config Reference

### 🔍 Screening Parameters

| Field | Default | Description |
|:------|:--------|:------------|
| `minOrganic` | `60` | Minimum organic score (0–100) |
| `minQuoteOrganic` | `60` | Minimum quote token organic score |
| `minHolders` | `400` | Minimum token holders |
| `minMcap` | `150000` | Minimum market cap (USD) |
| `maxMcap` | `10000000` | Maximum market cap (USD) |
| `minBinStep` | `60` | Minimum bin step |
| `maxBinStep` | `150` | Maximum bin step |
| `minVolatility` | `1.5` | Minimum volatility (skip dead pools) |
| `maxVolatility` | `2.9` | Maximum volatility (skip chaotic pools) |
| `minTokenFeesSol` | `25` | Minimum all-time fees in SOL |
| `maxBotHoldersPct` | `30` | Maximum bot holder % |
| `maxTop10Pct` | `60` | Maximum top-10 holder concentration |
| `maxBundlePct` | `30` | Maximum bundle holding % |
| `blockPvpSymbols` | `true` | Hard-block PVP symbol conflicts |
| `timeframe` | `1h` | Screening data timeframe |

### 💰 Position Management

| Field | Default | Description |
|:------|:--------|:------------|
| `deployAmountSol` | `0.5` | SOL per new position |
| `positionSizePct` | `0.25` | Fraction of balance to deploy |
| `maxPositions` | `6` | Maximum concurrent positions |
| `stopLossPct` | `-2.5` | Stop loss threshold (%) |
| `takeProfitPct` | `2` | Take profit threshold (%) |
| `trailingTakeProfit` | `true` | Enable trailing TP |
| `trailingTriggerPct` | `2` | Trailing activation threshold |
| `trailingDropPct` | `0.8` | Trailing drop to close |
| `outOfRangeWaitMinutes` | `12` | Minutes OOR before close |
| `maxHoldMinutes` | `25` | Max position age |
| `minAgeBeforeYieldCheck` | `10` | Minutes before low yield can trigger |
| `minFeePerTvl24h` | `5` | Minimum fee/TVL to stay open |

### ⏰ Schedule & Time Filter

| Field | Default | Description |
|:------|:--------|:------------|
| `managementIntervalMin` | `3` | Management cycle frequency |
| `screeningIntervalMin` | `20` | Screening cycle frequency |
| `screeningActiveHoursUtc` | `[18,19,20,21,22,23]` | UTC hours when screening is active. `null` = 24/7 |

### 🔄 Repeat Protection

| Field | Default | Description |
|:------|:--------|:------------|
| `repeatDeployCooldownEnabled` | `true` | Enable token cooldown after losses |
| `repeatDeployCooldownTriggerCount` | `1` | Losses before cooldown activates |
| `repeatDeployCooldownHours` | `24` | Cooldown duration |
| `repeatDeployCooldownScope` | `token` | Scope: `token`, `pool`, or `both` |

### 🤖 Agent & LLM

| Field | Default | Description |
|:------|:--------|:------------|
| `llmModel` | `minimax/minimax-m2.5:free` | Primary model |
| `llmFallbackModels` | `[...]` | Fallback model rotation |
| `darwinEnabled` | `true` | Auto-evolve parameters |
| `dryRun` | `true` | Paper trading mode |

---

## 🏗️ Architecture

```
meridian/
├── index.js              # Entry point: REPL + cron + management/screening loops
├── agent.js              # ReAct agent loop (LLM → tool → repeat)
├── config.js             # Runtime config (user-config.json + .env)
├── prompt.js             # System prompt builder (per-role)
├── state.js              # Position registry + trailing TP state
├── paper-tracker.js      # Paper trading position simulator
├── trade-profile.js      # Statistical trade analysis + risk param tuning
├── daily-pnl.js          # Daily PnL snapshots + streak tracking
├── lessons.js            # Learning: performance → lessons → evolution
├── signal-weights.js     # Darwin signal weight system
├── pool-memory.js        # Per-pool deploy history + cooldowns
├── decision-log.js       # Structured decision audit trail
├── telegram.js           # Telegram bot interface
├── briefing.js           # Daily intelligence briefing
├── hivemind.js           # Agent network sync
├── cli.js                # Full CLI (every tool as subcommand)
│
├── tools/
│   ├── definitions.js    # Tool schemas (OpenAI function calling format)
│   ├── executor.js       # Tool dispatch + safety checks
│   ├── dlmm.js           # Meteora DLMM SDK wrapper
│   ├── screening.js      # Pool discovery + enrichment + filtering
│   ├── wallet.js         # SOL/token balances + Jupiter swap
│   ├── token.js          # Token info, holders, narrative
│   ├── okx.js            # OKX OnchainOS integration
│   └── study.js          # Top LPer analysis
│
├── ecosystem.config.cjs  # PM2 process config
├── user-config.json      # Your personal config (gitignored)
└── .env                  # Secrets (gitignored)
```

---

## 🔌 Integrations

| Service | Purpose |
|:--------|:--------|
| **Meteora DLMM** | Pool discovery, position management, fee claiming |
| **Jupiter** | Token swaps, price feeds, token audit data |
| **OKX OnchainOS** | Smart money signals, risk scoring, holder analysis |
| **Helius** | Solana RPC |
| **OpenRouter** | LLM inference (free + paid models) |
| **Telegram** | Notifications, remote control, chat |

---

## 📝 Paper Trading

Start in dry-run mode to test without risking real funds:

```bash
DRY_RUN=true node index.js
```

Paper trading simulates:
- ✅ Position deployment with live entry prices
- ✅ PnL tracking based on real price movements
- ✅ Fee accrual simulation from live pool metrics
- ✅ All exit rules (SL, TP, OOR, low yield, max hold, trailing)
- ✅ Full lesson recording and evolution
- ✅ Daily PnL reports and briefings

---

<div align="center">

## ⚠️ Disclaimer

This software is provided as-is with no warranty. Autonomous trading carries real financial risk.
Always start with `DRY_RUN=true`. Never deploy more than you can afford to lose.

---

## 🙏 Credits

Forked from [yunus-0x/meridian](https://github.com/yunus-0x/meridian) — the original Meridian DLMM agent. Big thanks to the creator for building the foundation.

---

## ☕ Support

If Meridian helped you or you want to support development:

**Solana (SOL / SPL tokens):**

```
CYeQiqU2Fb3unSF9kseucNZzMEPmeevFVkhhfHcr4G6J
```

---

**Built with ☕ and Solana**

</div>
