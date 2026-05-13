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

**Meridian** is an autonomous AI-powered agent that manages liquidity positions on **Meteora DLMM pools** across Solana. It screens opportunities, deploys capital, monitors positions in real-time, and learns from every trade to continuously improve its strategy.

[Getting Started](#-quick-start) · [Features](#-features) · [Architecture](#-architecture) · [Config](#-config-reference)

</div>

---

## ⚡ Features

<table>
<tr>
<td width="50%">

### 🔍 Intelligent Screening
- Scans Meteora DLMM pools against 15+ configurable thresholds
- Fee/TVL ratio, organic score, holder analysis, mcap filters
- Smart money signal integration via OKX OnchainOS
- Token audit pipeline (bundler detection, supply concentration)

</td>
<td width="50%">

### 🤖 Autonomous Management
- ReAct agent loop — LLM reasons over live data and acts
- Trailing take-profit with confirmation rechecks
- Stop loss, out-of-range, low yield, and max hold exits
- Auto fee claiming and position rebalancing

</td>
</tr>
<tr>
<td width="50%">

### 🧠 Self-Evolving Strategy
- Records lessons from every closed position
- Evolves screening thresholds based on performance data
- Pool memory prevents repeat mistakes
- Darwin mode: automatic parameter tuning

</td>
<td width="50%">

### 📱 Full Remote Control
- Telegram bot with live notifications and chat
- Deploy, close, and monitor from your phone
- Interactive REPL with live cycle countdowns
- Complete CLI for scripting and automation

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
| **🔍 Screener** | Every 12 min | Find and deploy into the best candidate pool |
| **📋 Manager** | Every 3 min | Evaluate positions — hold, claim fees, or close |

### Data Sources
- **`@meteora-ag/dlmm` SDK** — On-chain position data, deploy/close transactions
- **Meteora PnL API** — Position yield, fee accrual, real-time PnL
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
3. Click **New Project** → name it `meridian` (or anything)
4. You'll see your **API Key** on the dashboard
5. Your RPC URL is: `https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY`

You need both values:
```
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY
HELIUS_API_KEY=YOUR_API_KEY
```

> 💡 **Free tier limits:** If you run into rate limits, upgrade to the **Developer plan** ($49/mo) for 100M credits/day. Paper trading uses very few credits.

---

### 5. Get an OpenRouter API Key

OpenRouter gives Meridian access to AI models (GPT, Claude, Gemini, etc.) — including **free models**.

1. Go to **[openrouter.ai](https://openrouter.ai/)** and sign up
2. Click your profile → **Keys** → **Create Key**
3. Name it `meridian`, click **Create**
4. Copy the key (starts with `sk-or-...`)

```
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxx
```

> 💡 **Free models available!** Meridian defaults to `openai/gpt-oss-120b:free` which costs $0. You can switch to paid models like `anthropic/claude-sonnet-4` for better reasoning. Check [openrouter.ai/models](https://openrouter.ai/models) for pricing.

#### Model Selection

| Model | Cost | Best For |
|:------|:-----|:---------|
| `openai/gpt-oss-120b:free` | Free | Default, good enough for most trades |
| `openai/gpt-oss-20b:free` | Free | Faster, lighter |
| `google/gemini-2.5-flash` | ~$0.001/cycle | Great balance of speed + quality |
| `anthropic/claude-sonnet-4` | ~$0.01/cycle | Best reasoning, highest accuracy |

Set your model in `user-config.json`:
```json
{
  "llmModel": "openai/gpt-oss-120b:free"
}
```

---

### 6. Set Up Telegram Bot (Optional but Recommended)

Telegram lets you monitor and control Meridian from your phone.

1. Open Telegram and search for **[@BotFather](https://t.me/BotFather)**
2. Send `/newbot`
3. Choose a **name** (e.g. `My Meridian Bot`)
4. Choose a **username** (e.g. `my_meridian_bot`)
5. BotFather gives you a token like `7123456789:AAH...` — copy it
6. **Get your chat ID:**
   - Send any message to your new bot
   - Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   - Find `"chat":{"id":123456789}` — that number is your chat ID
7. **Get your user ID** (for security):
   - Send a message to [@userinfobot](https://t.me/userinfobot)
   - It replies with your user ID

```
TELEGRAM_BOT_TOKEN=7123456789:AAHxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_CHAT_ID=123456789
TELEGRAM_ALLOWED_USER_IDS=123456789
```

> 🔒 `TELEGRAM_ALLOWED_USER_IDS` restricts who can send commands to the bot. Always set this!

---

### 7. Create Your `.env` File

Create a file called `.env` in the meridian directory with all your keys:

```env
# Wallet
WALLET_PRIVATE_KEY=your_base58_private_key_here

# RPC (Helius)
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
HELIUS_API_KEY=YOUR_HELIUS_KEY

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

Or run the interactive wizard which creates both `.env` and `user-config.json`:
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

# Background with PM2 (recommended for VPS / always-on)
npm install -g pm2
npm run pm2:start
pm2 save
```

> ⚠️ **Always start with `DRY_RUN=true`** to verify behavior before going live.

---

## 🎮 Usage

### Autonomous Agent

The agent starts with a live REPL showing countdown to next cycle:

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
| `/evolve` | Trigger threshold evolution (needs 5+ closed positions) |
| `/pnl` | Today's PnL breakdown |
| `/pnl week` | 7-day PnL summary |
| `<anything>` | Free-form chat with the agent |

### CLI

Direct tool access with JSON output:

```bash
# Screening
meridian candidates --limit 5
meridian pool-detail --pool <addr>
meridian search-pools --query <symbol>

# Positions
meridian positions
meridian pnl <position_address>

# Deploy & manage
meridian deploy --pool <addr> --amount <sol> --strategy spot
meridian close --position <addr>
meridian claim --position <addr>

# Learning
meridian lessons
meridian lessons add "Never deploy into tokens under 2h old"
meridian evolve
meridian performance --limit 200
```

### Telegram Commands

| Command | Action |
|:--------|:-------|
| `/positions` | List open positions with PnL bars |
| `/close <n>` | Close position by index |
| `/set <n> <note>` | Set instruction on a position |
| `/briefing` | Daily performance briefing |
| `/pnl` | Today's PnL report |
| *Free text* | Chat with the agent directly |

---

## 🧠 Learning System

### Lessons Engine

Every closed position generates structured lessons:

```
💡 PREFER: RKC-SOL-type pools (volatility=2.9, bin_step=100)
   with strategy="spot" — 100% in-range efficiency, PnL +60.83%

💡 FAILED: U1-SOL, strategy=spot, bin_step=100, volatility=3.3
   → PnL -38.23%. Reason: Stop loss triggered.
```

Lessons are injected into the agent's system prompt, shaping future decisions.

### Darwin Mode (Auto-Evolution)

After enough closed positions, Meridian automatically tunes its own parameters:

```
[AUTO-EVOLVED @ 75 positions] maxVolatility=4.3
  — Losers clustered at volatility ~3.7 — tightened from 5 → 4.3
```

---

## 📐 Exit Strategy

| Exit Type | Trigger | Description |
|:----------|:--------|:------------|
| 🎯 **Take Profit** | PnL ≥ threshold | Trailing TP with confirmation recheck |
| 🛑 **Stop Loss** | PnL ≤ -10% | Immediate close to cap downside |
| 📐 **Out of Range** | OOR > 15 min | Position no longer earning fees |
| 📉 **Low Yield** | fee/TVL below min | Pool dried up, redeploy elsewhere |
| ⏱️ **Max Hold** | Age > 90 min | Dead weight — hasn't hit TP |

---

## ⚙️ Config Reference

<details>
<summary><b>📋 Screening Parameters</b></summary>

| Field | Default | Description |
|:------|:--------|:------------|
| `minFeePerTvl24h` | `1.5` | Minimum fee/TVL ratio (%) |
| `minOrganic` | `50` | Minimum organic score (0–100) |
| `minHolders` | `300` | Minimum token holders |
| `minMcap` | `100000` | Minimum market cap (USD) |
| `maxMcap` | `15000000` | Maximum market cap (USD) |
| `minBinStep` | `60` | Minimum bin step |
| `maxBinStep` | `150` | Maximum bin step |
| `maxVolatility` | `4.3` | Maximum 1h volatility |
| `minTokenFeesSol` | `20` | Minimum all-time fees (SOL) |
| `maxBotHoldersPct` | `35` | Maximum bot holder % |
| `maxTop10Pct` | `65` | Maximum top-10 concentration |

</details>

<details>
<summary><b>💰 Position Management</b></summary>

| Field | Default | Description |
|:------|:--------|:------------|
| `deployAmountSol` | `0.5` | SOL per new position |
| `positionSizePct` | `0.25` | Fraction of balance to deploy |
| `maxPositions` | `6` | Maximum concurrent positions |
| `stopLossPct` | `-10` | Stop loss threshold (%) |
| `takeProfitFeePct` | `5` | Take profit threshold (%) |
| `trailingTakeProfit` | `true` | Enable trailing TP |
| `trailingTriggerPct` | `2.5` | Trailing activation threshold |
| `trailingDropPct` | `1.2` | Trailing drop to close |
| `outOfRangeWaitMinutes` | `15` | Minutes OOR before close |
| `maxHoldMinutes` | `90` | Max position age |

</details>

<details>
<summary><b>🤖 Agent & Schedule</b></summary>

| Field | Default | Description |
|:------|:--------|:------------|
| `managementIntervalMin` | `3` | Management cycle frequency |
| `screeningIntervalMin` | `12` | Screening cycle frequency |
| `llmProvider` | `openrouter` | LLM provider |
| `llmModel` | `openai/gpt-oss-120b:free` | Model for agent cycles |
| `darwinEnabled` | `true` | Auto-evolve parameters |

</details>

---

## 🏗️ Architecture

```
meridian/
├── index.js              # Entry point: REPL + cron + Telegram
├── agent.js              # ReAct agent loop (LLM → tool → repeat)
├── config.js             # Runtime config (user-config.json + .env)
├── prompt.js             # System prompt builder (per-role)
├── state.js              # Position registry (state.json)
├── paper-tracker.js      # Paper trading position simulator
├── paper-trader.js       # Paper trading PnL engine
├── daily-pnl.js          # Daily PnL snapshots + reporting
├── lessons.js            # Learning: performance → lessons → evolution
├── pool-memory.js        # Per-pool deploy history
├── decision-log.js       # Structured decision audit trail
├── telegram.js           # Telegram bot interface
├── briefing.js           # Daily intelligence briefing
├── hivemind.js           # Agent network sync
├── cli.js                # Full CLI (every tool as subcommand)
│
├── tools/
│   ├── definitions.js    # Tool schemas (OpenAI format)
│   ├── executor.js       # Tool dispatch + safety checks
│   ├── dlmm.js           # Meteora DLMM SDK wrapper
│   ├── screening.js      # Pool discovery + enrichment
│   ├── wallet.js         # SOL/token balances + Jupiter swap
│   ├── token.js          # Token info, holders, narrative
│   └── study.js          # Top LPer analysis
│
├── discord-listener/     # Discord signal listener
├── ecosystem.config.cjs  # PM2 process config
└── user-config.json      # Your personal config (gitignored)
```

---

## 🔌 Integrations

| Service | Purpose |
|:--------|:--------|
| **Meteora DLMM** | Pool discovery, position management, fee claiming |
| **Jupiter** | Token swaps, price feeds, token audit data |
| **OKX OnchainOS** | Smart money signals, risk scoring |
| **Helius** | RPC, wallet balance lookups |
| **OpenRouter** | LLM inference (GPT, Claude, Gemini, etc.) |
| **Telegram** | Notifications, remote control, chat |
| **Discord** | Signal listener for alpha channels |

---

## 📝 Paper Trading

Start in dry-run mode to test without risking real funds:

```bash
DRY_RUN=true node index.js
```

Paper trading simulates:
- ✅ Position deployment with live entry prices
- ✅ PnL tracking based on real price movements
- ✅ Fee accrual simulation from pool metrics
- ✅ All exit rules (SL, TP, OOR, low yield, max hold)
- ✅ Full lesson recording and evolution

---

<div align="center">

## ⚠️ Disclaimer

This software is provided as-is with no warranty. Autonomous trading carries real financial risk — you can lose funds.
Always start with `DRY_RUN=true`. Never deploy more than you can afford to lose. This is not financial advice.

---

**Built with ☕ and Solana**

</div>
