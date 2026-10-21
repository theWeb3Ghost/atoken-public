#!/usr/bin/env python3
"""Trains P(ran_2x | discovery-time features). Walk-forward by day, class
weighting, calibration bins, hard data gates. Gates refuse to write a model
until there is enough honest data."""
import json, sys
from datetime import datetime, timezone
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, brier_score_loss

DATA, OUT = 'data/dataset.json', 'data/model.json'
MIN_ROWS, MIN_RUNNERS, TARGET, K = 200, 20, 'ran_2x', 5

# dead zone threshold: tokens whose peak_multiple stays at ~1x are excluded
# from training to avoid confusing flat-line tokens with genuine non-runners
DEADZONE_PEAK_THRESHOLD = 1.05
DEADZONE_MIN_SAMPLES = 5

def main():
    d = json.load(open(DATA))
    feats = d.get('feature_names') or d.get('featureNames')
    # filter to labeled rows only
    all_labeled = [r for r in d['rows'] if r['outcome']['label_known'] == 1]

    # exclude dead-zone tokens: peak stayed at 1x with enough samples to confirm
    # this prevents the model from learning that "flat" = "not a runner"
    # which dilutes signal from genuine non-runners with weak features
    non_deadzone = [
        r for r in all_labeled
        if not (
            r['outcome'].get('peak_multiple', 1) <= DEADZONE_PEAK_THRESHOLD
            and r['outcome'].get('n_points', 0) >= DEADZONE_MIN_SAMPLES
        )
    ]
    excluded_deadzone = len(all_labeled) - len(non_deadzone)
    print(f'rows={len(non_deadzone)} (excluded {excluded_deadzone} dead-zone tokens with peak <= {DEADZONE_PEAK_THRESHOLD}x)')

    rows = non_deadzone
    n_run = sum(r['outcome'][TARGET] for r in rows)
    base = n_run / len(rows) if rows else 0
    print(f'runners={n_run} base_rate={base:.3f} (was {sum(r["outcome"][TARGET] for r in all_labeled) / len(all_labeled):.3f} before exclusion)')
    if len(rows) < MIN_ROWS or n_run < MIN_RUNNERS:
        print(f'GATE: need >= {MIN_ROWS} labeled rows and >= {MIN_RUNNERS} runners. Keep collecting. No model written.')
        return 1

    X = np.array([[r['features'].get(f, 0) for f in feats] for r in rows], float)
    y = np.array([r['outcome'][TARGET] for r in rows], int)
    day = lambda r: r['createdAt'][:10]
    days = sorted({day(r) for r in rows})

    yt_all, yp_all, precs = [], [], []
    for i in range(1, len(days)):
        tr = [j for j, r in enumerate(rows) if day(r) < days[i]]
        te = [j for j, r in enumerate(rows) if day(r) == days[i]]
        if not tr or not te or y[tr].sum() == 0: continue
        m = LogisticRegression(max_iter=1000, C=1.0, class_weight='balanced').fit(X[tr], y[tr])
        p = m.predict_proba(X[te])[:, 1]
        top = np.argsort(-p)[:K]
        precs.append(y[te][top].mean())
        yt_all += y[te].tolist(); yp_all += p.tolist()
    auc = roc_auc_score(yt_all, yp_all) if len(set(yt_all)) > 1 else float('nan')
    print(f'WALK-FORWARD (honest numbers): days={len(days)-1} AUC={auc:.3f} '
          f'Brier={brier_score_loss(yt_all, yp_all):.3f} precision@{K}={np.mean(precs):.3f} vs base {base:.3f}')
    if not (auc > 0.5): print('WARNING: AUC <= 0.5 — model has no signal yet. Model written for calibration tracking only.')

    model = LogisticRegression(max_iter=1000, C=1.0, class_weight='balanced').fit(X, y)
    p_all = model.predict_proba(X)[:, 1]
    bins = []
    for lo, hi in zip([0, .2, .4, .6, .8], [.2, .4, .6, .8, 1.001]):
        m = (p_all >= lo) & (p_all < hi)
        bins.append({'lo': lo, 'hi': hi, 'n': int(m.sum()),
                     'observed': float(y[m].mean()) if m.any() else None})

    json.dump({
        'feature_names': feats, 'weights': model.coef_[0].tolist(),
        'bias': float(model.intercept_[0]), 'calibration': bins,
        'meta': {'trained_at': datetime.now(timezone.utc).isoformat(), 'rows': len(rows),
                 'runners': int(n_run), 'target': TARGET, 'walk_forward_auc': float(auc),
                 'precision_at_5': float(np.mean(precs)), 'base_rate': float(base)},
    }, open(OUT, 'w'), indent=2)
    print('wrote', OUT)
    print('top drivers:')
    for f, w in sorted(zip(feats, model.coef_[0]), key=lambda t: -abs(t[1]))[:10]:
        print(f'  {w:+.3f}  {f}')
    return 0

if __name__ == '__main__':
    sys.exit(main())