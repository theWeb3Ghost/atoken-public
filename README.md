# 🚀 Token Radar — ML-Powered Solana/Ethereum Token Surveillance

**Full-stack Web3 surveillance system** — predicts rug-pull runners before they moon using ML, real-time DEX scraping, and a Rust prediction engine.

## 🔬 Overview

Token Radar is a production-grade crypto surveillance system that scores newly-listed tokens in real-time, predicting which ones will 2x+ from baseline. Built by a full-stack Web3 dev combining:

- **JavaScript/Node.js** — ML orchestration, prediction loops, Telegram bot
- **Rust** — Core prediction engine (`lib.rs` mirrors JS scoring logic)
- **Data Analysis** — Live pattern weights from lift ratios, chain multipliers from runner rates, dead-zone detection

### Architecture
```
┌─────────────────┐    ┌──────────────┐    ┌──────────┐
│ DexScreener API │───▶│ Scrape Worker │───▶│  MongoDB  │
└─────────────────┘    └──────────────┘    └──────────┘
                              │                    │
                              ▼                    ▼
                    ┌──────────────┐    ┌──────────────┐
                    │ Sample Worker│    │Trade Advisor │
                    └──────────────┘    └──────────────┘
                              │                    │
                              ▼                    ▼
                    ┌──────────────┐    ┌──────────────┐
                    │RunnerPredictor│   │Pattern Weights │
                    │ (30s cycle)   │   │(30min learn)   │
                    └──────────────┘    └──────────────┘
                              │                    │
                        ┌─────┴─────┐     ┌──────┴──────┐
                        │  Rust     │     │Telegram Bot │
                        │ Prediction│     │/momentum cmd │
                        │Engine     │     │             │
                        └───────────┘     └─────────────┘
```

## 🎯 Features

### ML Prediction Pipeline
- **Signal-based scoring** — 10 pattern weights dynamically computed from lift ratios (runner vs non-runner occurrence)
- **Chain multipliers** — Per-chain boosts derived from actual runner rates (e.g., Solana 1.4x, BSC 0.7x)
- **Dead-zone detection** — Filters tokens that flatline (peakMultiple ≤ 1.01) to reduce false positives
- **Fast-peak prediction** — Estimates probability of peaking before a deadline (200 min default)
- **Bucket model** — Score buckets (0-20, 20-40, 40-60, 60-80, 80-100) with runner-rate-based performance tracking

### Real-time Monitoring
- **30-second scoring cycles** — All tracked tokens scored and ranked every 30s
- **30-minute learning cycles** — Pattern weights and chain multipliers auto-adjust from prediction accuracy
- **Momentum Entry Monitor** — 40-100 bucket tokens crossing 1.3x threshold get Telegram alerts
- **Paper trading** — Simulated entries at score thresholds with stop-loss, tracks actual outcomes

### Rust Core Engine
```rust
// lib.rs — Mirrors JS scoring with import/export weight functions
pub fn export_weights(&self) -> String { ... }
pub fn import_weights(&mut self, json: &str) -> Result<()> { ... }
```

### Web3 Full-Stack Integration
- **DexScreener ingestion** — Price sampling every 10 minutes, runner detection at 2x baseline
- **EVM + Solana support** — Address validation for both chains
- **Telegram bot** — `/predictions`, `/momentum`, `/top`, `/status`, `/info` commands
- **BullMQ queues** — Decoupled workers for scraping, analysis, sampling, training
- **Docker deployment** — `docker compose up --build -d` on Ubuntu VPS

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 20, Express, BullMQ, MongoDB |
| ML Engine | Rust (core scoring), Python (scikit-learn training) |
| Scraping | DexScreener API, Cloudflare Workers, direct HTTP |
| Blockchain | EVM (0x addresses), Solana (base58) |
| Monitoring | Telegram Bot API (long-polling) |
| Deployment | Docker, Ubuntu VPS |
| Data | MongoDB aggregations, real-time analytics |

## 🚀 Quick Start

```bash
# Clone (this public version — does NOT include private keys)
git clone https://github.com/theWeb3Ghost/atoken-public.git
cd atoken-public

# Copy env template and fill in your values
cp .env.example .env

# Build and run
docker compose up --build -d
```

## ⚙️ Key Algorithms

### Probability Scoring
```javascript
// Sigmoid centered at score 0.40, divisor 0.12
const z = (score - 0.40) / 0.12;
const probability = 1.0 / (1.0 + Math.exp(-z));

// Signal weights computed dynamically from lift ratios
// weight = lift * 0.10 (capped at 1.5x multiplier)
```

### Dead Zone Detection
```rust
// Tokens with peakMultiple ≈ 1.0 and sufficient samples are filtered
if tok.runner == false && (tok.peak_multiple - 1.0).abs() < 1e-9 {
    // Dead zone — reduce score sharply
}
```

## 📊 Data Pipeline

1. **Ingestion** — DexScreener token profiles polled every 10s
2. **Scraping** — Website metadata, social links, signal detection
3. **Scoring** — ML model + signal weights + chain multipliers
4. **Monitoring** — Tokens crossing momentum threshold tracked live
5. **Learning** — 30-min cycles update weights from accuracy data
6. **Alerts** — Telegram notifications with dedupe tracking

## 📁 Project Structure

```
src/
├── api/server.js          # REST API + WebSocket stream
├── services/
│   ├── runnerPredictor.js  # Core prediction engine (30s cycle)
│   ├── tradeAdvisor.js     # Self-learning trading advisor
│   ├── bucketModel.js      # Bucket performance + dead-zone
│   ├── sampler.js          # DexScreener price sampling
│   ├── maintenance.js      # Autopilot maintenance loop
│   ├── notifier/           # Telegram notification system
│   └── predictor/          # Rust core engine (lib.rs)
├── workers/                # BullMQ worker processes
├── bot/telegram.js         # Telegram long-polling bot
└── web/                    # React-free HTML dashboards
```

## 🌐 Live Dashboards

- **Runner Predictor**: `/predictor.html` — Live probability ladder
- **Trade Advisor**: `/trade.html` — Paper trading recommendations
- **API Health**: `/api/health`

## 🤖 Skills Demonstrated

- **JavaScript/Node.js** — Full backend, ML orchestration, real-time scoring
- **Rust** — Core prediction engine with serde JSON serialization
- **Data Analysis** — Lift ratio computation, runner rate analytics, accuracy tracking
- **Web3 Development** — EVM/Solana address handling, DexScreener integration
- **ML Engineering** — Sigmoid scoring, dead-zone detection, pattern weight learning
- **DevOps** — Docker, BullMQ queue orchestration, MongoDB indexing

## 📝 License

MIT — Use freely, but remember: crypto is risky. DYOR.

---

*This is the public version. DM FOR CALLOUTS FROM FETCHED DATA*
