import { Worker } from 'bullmq';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { coll } from '../db.js';
import { log } from '../lib/logger.js';
import { createConnection } from '../queues.js';
import { rescoreAll, loadModel } from '../services/score.js';

export function startTrainWorker() {
  const worker = new Worker('train', async (_job) => {
    const modelPath = path.join(process.cwd(), 'data', 'model.json');
    const before = fs.existsSync(modelPath) ? fs.statSync(modelPath).mtimeMs : 0;

    const out = await new Promise((resolve) => {
      const p = spawn('python3', [path.join(process.cwd(), 'train', 'model.py')], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      p.on('error', () => resolve({ code: -1, stdout, stderr, error: 'python3 not available' }));
      p.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    const after = fs.existsSync(modelPath) ? fs.statSync(modelPath).mtimeMs : 0;
    const trained = after > before;
    const result = {
      code: out.code,
      trained,
      tail: (out.stdout + out.stderr).split('\n').filter(Boolean).slice(-5).join(' | '),
    };

    if (trained) {
      const n = await rescoreAll();
      result.rescored = n;
      loadModel(true);
      log.info('[train] model updated, rescored %d candidates', n);
    } else {
      log.info('[train] training completed, no model update', { result });
    }

    await coll.config.updateOne(
      { _id: 'training' },
      { $set: { lastRunAt: new Date(), lastResult: result } },
      { upsert: true }
    );

    return result;
  }, { connection: createConnection(), concurrency: 1 }); // Train one at a time

  worker.on('error', (e) => log.error('[train worker]', e.message));
  log.info('[train worker] started');
  return { worker };
}
