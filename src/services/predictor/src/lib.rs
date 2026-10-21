// Dynamic Runner Predictor — Rust core engine
// Computes probability of 2x+ pump for any token based on learned patterns

use std::collections::HashMap;

/// Pattern weights learned from historical runner data
/// These are dynamically updated by the JS learning layer
#[derive(Default)]
pub struct Predictor {
    // Signal weights (0.0 = no effect, 1.0 = strong runner indicator)
    pub signal_weights: HashMap<String, f64>,
    // Chain multipliers (solana tends to pump more)
    pub chain_multipliers: HashMap<String, f64>,
    // Time decay (fresh tokens get boost)
    pub freshness_boost_hours: f64,
    pub freshness_decay_per_hour: f64,
    // Price movement multipliers
    pub level_1_2x_mult: f64,
    pub level_1_3x_mult: f64,
    pub level_1_5x_mult: f64,
    pub level_2x_mult: f64,
    // Learning rate for weight updates
    pub learning_rate: f64,
    // Prediction accuracy tracking
    pub correct_predictions: u32,
    pub total_predictions: u32,
}

#[derive(Debug, Clone)]
pub struct TokenData {
    pub chain_id: String,
    pub token_address: String,
    pub score: f64,        // ML model score (0-1)
    pub peak_multiple: f64, // current peak / baseline
    pub current_multiple: f64, // lastPrice / baseline
    pub is_runner: bool,
    pub became_runner_at: Option<f64>, // timestamp
    pub first_seen_at: f64,            // timestamp
    pub signals: Vec<String>,
    pub baseline_usd: f64,
    pub last_price_usd: f64,
    pub liquidity_usd: f64,
    pub volume_24h: f64,
    pub time_to_peak_min: Option<u32>, // if already a runner
}

#[derive(Debug, Clone)]
pub struct PredictionResult {
    pub probability: f64,  // 0.0 - 1.0
    pub confidence: f64,  // 0.0 - 1.0 (based on historical accuracy)
    pub signals_matched: Vec<String>,
    pub reasons: Vec<String>,
    pub level: PredictionLevel,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PredictionLevel {
    Watch,      // probability >= 0.3
    Signal,     // probability >= 0.5
    Strong,     // probability >= 0.7
    Critical,   // probability >= 0.85
}

impl Predictor {
    pub fn new() -> Self {
        let mut p = Self::default();
        // Default weights based on historical analysis
        p.signal_weights.insert("docs".to_string(), 0.15);
        p.signal_weights.insert("about".to_string(), 0.10);
        p.signal_weights.insert("connect_wallet".to_string(), 0.13);
        p.signal_weights.insert("privacy".to_string(), 0.08);
        p.signal_weights.insert("terms".to_string(), 0.05);
        p.signal_weights.insert("whitepaper".to_string(), 0.12);
        p.signal_weights.insert("play".to_string(), 0.07);
        // Chain multipliers
        p.chain_multipliers.insert("solana".to_string(), 1.5);
        p.chain_multipliers.insert("robinhood".to_string(), 1.2);
        p.chain_multipliers.insert("hyperevm".to_string(), 1.1);
        p.chain_multipliers.insert("ethereum".to_string(), 0.7);
        p.chain_multipliers.insert("bsc".to_string(), 0.6);
        p.chain_multipliers.insert("base".to_string(), 1.0);
        // Time decay
        p.freshness_boost_hours = 12.0;
        p.freshness_decay_per_hour = 0.04;
        // Price movement multipliers
        p.level_1_2x_mult = 1.5;
        p.level_1_3x_mult = 2.0;
        p.level_1_5x_mult = 3.0;
        p.level_2x_mult = 5.0;
        // Learning
        p.learning_rate = 0.02;
        p
    }

    pub fn predict(&self, token: &TokenData, now: f64) -> PredictionResult {
        if token.is_runner {
            return PredictionResult {
                probability: 1.0,
                confidence: 0.95,
                signals_matched: token.signals.clone(),
                reasons: vec!["already_runner".to_string()],
                level: PredictionLevel::Critical,
            };
        }

        let mut reasons = Vec::new();
        let mut raw_score = 0.0;

        // 1. Base ML score (0-1 scale → 0-40 points)
        let ml_component = token.score * 40.0;
        raw_score += ml_component;
        if ml_component > 0.1 {
            reasons.push(format!("ml_score_{:.3}", token.score));
        }

        // 2. Signal weights (0-100 points)
        let mut signal_score = 0.0;
        for sig in &token.signals {
            if let Some(&weight) = self.signal_weights.get(&sig.to_lowercase()) {
                let contribution = weight * 100.0;
                signal_score += contribution;
                if contribution > 5.0 {
                    reasons.push(format!("signal_{}", sig));
                }
            }
        }
        raw_score += signal_score;

        // 3. Chain multiplier
        let chain_mult = self.chain_multipliers.get(&token.chain_id).copied().unwrap_or(1.0);
        let chain_boost = (chain_mult - 1.0) * 20.0; // ±20 points max
        raw_score += chain_boost;
        if chain_boost > 0.1 {
            reasons.push(format!("chain_{}_x{:.1}", token.chain_id, chain_mult));
        }

        // 4. Price movement multiplier (momentum) — capped to prevent runaway scores
        let price_mult = token.current_multiple.min(100.0); // guard against underflow
        let price_boost = match () {
            () if price_mult >= 2.0 => {
                reasons.push("price_2x".to_string());
                ((price_mult - 1.0) * self.level_2x_mult).min(20.0)
            }
            () if price_mult >= 1.5 => {
                reasons.push("price_1.5x".to_string());
                ((price_mult - 1.5) * self.level_1_5x_mult * 10.0).min(15.0)
            }
            () if price_mult >= 1.3 => {
                reasons.push("price_1.3x".to_string());
                ((price_mult - 1.3) * self.level_1_3x_mult * 10.0).min(8.0)
            }
            () if price_mult >= 1.2 => {
                reasons.push("price_1.2x".to_string());
                ((price_mult - 1.2) * self.level_1_2x_mult * 10.0).min(5.0)
            }
            () => 0.0,
        };
        raw_score += price_boost;

        // 5. Freshness boost (tokens discovered recently get higher priority)
        let age_hours = (now - token.first_seen_at) / 3600.0;
        if age_hours < self.freshness_boost_hours {
            let freshness_mult = 1.0 + (self.freshness_boost_hours - age_hours) / self.freshness_boost_hours;
            let freshness_boost = ((freshness_mult - 1.0) * 10.0).min(10.0);
            raw_score += freshness_boost;
            if freshness_boost > 0.5 {
                reasons.push(format!("fresh_{:.0}h", age_hours));
            }
        }

        // 6. Liquidity and volume boost
        if token.liquidity_usd > 10000.0 {
            raw_score += 5.0;
        }
        if token.volume_24h > 50000.0 {
            raw_score += 5.0;
        }

        // Clamp to 0-100
        let clamped = raw_score.max(0.0).min(100.0);

        // Convert to probability (sigmoid-like curve, steeper for more differentiation)
        let probability = 1.0 / (1.0 + (-((clamped - 50.0) / 15.0)).exp());

        // Confidence based on historical accuracy and data quality
        let confidence = self.prediction_confidence(&token, probability);

        // Determine level
        let level = if probability >= 0.85 {
            PredictionLevel::Critical
        } else if probability >= 0.7 {
            PredictionLevel::Strong
        } else if probability >= 0.5 {
            PredictionLevel::Signal
        } else {
            PredictionLevel::Watch
        };

        PredictionResult {
            probability,
            confidence,
            signals_matched: token.signals.clone(),
            reasons,
            level,
        }
    }

    fn prediction_confidence(&self, token: &TokenData, prob: f64) -> f64 {
        let mut confidence = 0.5; // base

        // More signals = more confident
        confidence += (token.signals.len() as f64).min(5.0) * 0.05;

        // Historical accuracy
        if self.total_predictions > 0 {
            let historical = self.correct_predictions as f64 / self.total_predictions as f64;
            confidence = (confidence * 0.5 + historical * 0.5).max(0.1);
        }

        // Extreme probabilities are more confident
        let prob_confidence = (prob - 0.5).abs() * 2.0;
        confidence = (confidence * 0.7 + prob_confidence * 0.3).min(0.95);

        confidence
    }

    /// Record prediction outcome for learning
    pub fn record_outcome(&mut self, token: &TokenData, became_runner: bool, peak_mult: f64) {
        self.total_predictions += 1;
        if became_runner && peak_mult >= 2.0 {
            self.correct_predictions += 1;

            // Reinforce signal weights that were present
            let boost = self.learning_rate;
            for sig in &token.signals {
                if let Some(w) = self.signal_weights.get_mut(sig) {
                    *w = (*w + boost).min(1.0);
                }
            }
        } else if !became_runner {
            // Reduce weights for signals that led to false positives
            let reduction = self.learning_rate * 2.0;
            for sig in &token.signals {
                if let Some(w) = self.signal_weights.get_mut(sig) {
                    *w = (*w - reduction).max(0.0);
                }
            }
        }
    }

    /// Export current weights as JSON for persistence
    pub fn export_weights(&self) -> String {
        let signals: HashMap<String, f64> = self.signal_weights.clone();
        let chains: HashMap<String, f64> = self.chain_multipliers.clone();
        let accuracy = if self.total_predictions > 0 {
            self.correct_predictions as f64 / self.total_predictions as f64
        } else { 0.0 };

        // Build a proper JSON structure using serde_json
        serde_json::json!({
            "signals": signals,
            "chains": chains,
            "freshness_hours": self.freshness_boost_hours,
            "decay_per_hour": self.freshness_decay_per_hour,
            "learning_rate": self.learning_rate,
            "accuracy": accuracy,
            "total_predictions": self.total_predictions,
            "correct_predictions": self.correct_predictions
        }).to_string()
    }

    /// Import weights from JSON
    /// Expected format: {"signals": {"docs": 0.15, ...}, "chains": {"solana": 1.5, ...}, ...}
    pub fn import_weights(&mut self, json: &str) {
        let config: HashMap<String, serde_json::Value> = match serde_json::from_str(json) {
            Ok(c) => c,
            Err(_) => return, // Invalid JSON — silently ignore
        };

        // Update signal weights
        if let Some(signals) = config.get("signals").and_then(|v| v.as_object()) {
            for (name, val) in signals {
                if let Some(w) = val.as_f64() {
                    self.signal_weights.insert(name.to_lowercase(), w);
                }
            }
        }

        // Update chain multipliers
        if let Some(chains) = config.get("chains").and_then(|v| v.as_object()) {
            for (chain, val) in chains {
                if let Some(m) = val.as_f64() {
                    self.chain_multipliers.insert(chain.to_lowercase(), m);
                }
            }
        }

        // Update learning params
        if let Some(lr) = config.get("learning_rate").and_then(|v| v.as_f64()) {
            self.learning_rate = lr;
        }
    }
}

// Helper function: compute multiple from prices
pub fn compute_multiple(baseline: f64, current: u64) -> f64 {
    if baseline > 0.0 { current as f64 / baseline } else { 1.0 }
}

// Helper: parse signals from JSON array string
pub fn parse_signals(json_str: &str) -> Vec<String> {
    json_str.trim_matches(|c: char| c == '[' || c == ']' || c == '"' || c == ' ')
        .split(',')
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_prediction() {
        let p = Predictor::new();
        let token = TokenData {
            chain_id: "solana".to_string(),
            token_address: "test123".to_string(),
            score: 0.6,
            peak_multiple: 1.5,
            current_multiple: 1.5,
            is_runner: false,
            became_runner_at: None,
            first_seen_at: 1000000000.0,
            signals: vec!["docs".to_string(), "connect_wallet".to_string()],
            baseline_usd: 0.0001,
            last_price_usd: 0.00015,
            liquidity_usd: 50000.0,
            volume_24h: 100000.0,
            time_to_peak_min: None,
        };
        let result = p.predict(&token, 1000000000.0 + 3600.0); // 1 hour later
        assert!(result.probability > 0.1);
        assert!(result.probability < 1.0);
        assert!(result.reasons.len() > 0);
    }

    #[test]
    fn test_chain_multiplier() {
        let p = Predictor::new();
        assert_eq!(p.chain_multipliers.get("solana"), Some(&1.5));
        assert_eq!(p.chain_multipliers.get("ethereum"), Some(&0.7));
    }

    #[test]
    fn test_learning_updates_weights() {
        let mut p = Predictor::new();
        let initial_docs = p.signal_weights["docs"];
        let token = TokenData {
            chain_id: "solana".to_string(),
            token_address: "test".to_string(),
            score: 0.5,
            peak_multiple: 2.5,
            current_multiple: 2.5,
            is_runner: true,
            became_runner_at: None,
            first_seen_at: 1000000000.0,
            signals: vec!["docs".to_string()],
            baseline_usd: 0.0001,
            last_price_usd: 0.00025,
            liquidity_usd: 50000.0,
            volume_24h: 100000.0,
            time_to_peak_min: Some(45),
        };
        p.record_outcome(&token, true, 2.5);
        assert!(p.signal_weights["docs"] > initial_docs);
    }
}