# Dynamic Runner Predictor

Real-time 2x+ pump probability engine for all tracked tokens.

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│   MongoDB       │     │  JS Bridge (Node.js) │     │  Rust Engine (lib)│
│  candidates     │◄─── │ runnerPredictor.js   │◄─── │  lib.rs (mirrors) │
│  tokens         │     │  - calculateRunner   │     │  - predict()      │
│  samples        │     │  - recordPrediction  │     │  - recordOutcome() │
│  monitoring     │     │  - startPrediction   │     │  - adjust_weights  │
│                 │     │  - getLiveRankings   │     │                    │
└─────────────────┘     └──────────────────────┘     └──────────────────┘
                                              │
                         ┌────────────────────┼────────────────────┐
                         ▼                    ▼                    ▼
                   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
                   │  WebSocket   │   │  REST API    │   │  Dashboard   │
                   │  /api/preds  │   │  /api/preds/ │   │  predictor   │
                   │   /stream   │   │   live       │   │  .html       │
                   └──────────────┘   └──────────────┘   └──────────────┘
```

## Scoring Formula

The probability is computed from a weighted score (0-100), then passed through a sigmoid:

1. **ML Score** (0-40 points): Base model prediction × 40
2. **Signal Weights** (0-100 points): Each matched signal contributes `weight × 100`
3. **Chain Multiplier** (±20 points): `(mult - 1) × 20` — Solana gets +20, Ethereum -20
4. **Price Momentum**: Boost based on current multiple vs baseline
   - 1.2x → 15 points
   - 1.3x → 30 points
   - 1.5x → 100+ points
   - 2.0x → 500+ points
5. **Freshness Boost** (up to 30 points): Tokens < 12h old get a boost
6. **Liquidity/Volume** (+5 each): >$10k liq, >$50k vol

Final: `probability = 1 / (1 + e^((raw_score - 40) / 12))`

## Pattern Weights (Default)

| Signal | Weight |
|--------|--------|
| docs | 0.15 |
| connect_wallet | 0.13 |
| whitepaper | 0.12 |
| about | 0.10 |
| audit | 0.10 |
| play | 0.07 |
| renounced | 0.09 |
| website | 0.06 |
| privacy | 0.08 |
| terms | 0.05 |

## Chain Multipliers (Default)

| Chain | Multiplier |
|-------|-----------|
| solana | 1.5x |
| abstract | 1.4x |
| blast | 1.3x |
| robinhood | 1.2x |
| hyperevm | 1.1x |
| arbitrum | 1.1x |
| base | 1.0x |
| optimism | 1.0x |
| bsc | 0.6x |
| polygon | 0.8x |
| ethereum | 0.7x |

## Cycles

- **Scoring**: Every 30 seconds — re-evaluates all candidate tokens
- **Learning**: Every 30 minutes — adjusts pattern weights based on prediction accuracy
- **WebSocket Broadcast**: Every 30 seconds — pushes live ladder to dashboard

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | Rust project manifest (serde + serde_json) |
| `src/lib.rs` | Rust prediction engine (tests included) |
| `../runnerPredictor.js` | JS bridge / orchestration layer |
| `../server.js` | WebSocket endpoint + REST API |
| `../trade.html` | Main dashboard (existing) |
| `../../web/predictor.html` | Dedicated predictor dashboard |

## Usage

```bash
# Build and test the Rust engine
cd /home/ghost/projects/atoken/src/services/predictor
cargo test

# The JS bridge runs automatically when the API starts
npm start --start:api

# Dashboard
open http://localhost:8080/predictor.html
```

## WebSocket Endpoint

```
ws://HOST:PORT/api/predictions/stream
```

Returns JSON every 30 seconds:

```json
{
  "rankings": [
    {
      "tokenId": "solana:AbC...pump",
      "chainId": "solana",
      "tokenAddress": "AbC...pump",
      "probability": 0.85,
      "confidence": 0.72,
      "level": "critical",
      "reasons": ["ml_0.600", "sig_docs", "chain_solana_x1.5", "price_1.5x", "fresh_2h"],
      "signals": ["docs", "connect_wallet"],
      "current_multiple": 1.52,
      "peak_multiple": 1.52,
      "age_hours": 1.2
    }
  ],
  "stats": {
    "total_tracked": 142,
    "accuracy": 0.65
  },
  "timestamp": 1697...
}
```

## REST API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/predictions/live?limit=50` | Top N tokens by probability |
| GET | `/api/predictions/stats` | Model accuracy and stats |
| POST | `/api/predictions/record` | Record prediction outcome |
| GET | `/api/predictions/monitoring` | Tokens in monitoring bucket |
