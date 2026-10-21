import { coll } from '../db.js';
import { analyzeQueue } from '../queues.js';
import { normalizeTokenAddress } from '../normalize.js';

export async function requestAnalysis(chainId, tokenAddress, { force = false } = {}) {
  chainId = String(chainId).toLowerCase();
  tokenAddress = normalizeTokenAddress(chainId, tokenAddress);

  const cand = await coll.candidates.findOne({ chainId, tokenAddress });
  if (!cand) { const e = new Error('candidate not found'); e.status = 404; throw e; }

  if (['queued', 'running'].includes(cand.analysisStatus) || (cand.analysisStatus === 'done' && !force)) {
    return { status: cand.analysisStatus, analysisId: cand.analysisId || null };
  }

  const claimStates = force ? ['not_analyzed', 'failed', 'done'] : ['not_analyzed', 'failed'];
  const claimed = await coll.candidates.findOneAndUpdate(
    { chainId, tokenAddress, analysisStatus: { $in: claimStates } },
    { $set: { analysisStatus: 'queued', analysisRequestedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!claimed) return { status: cand.analysisStatus, analysisId: cand.analysisId || null };

  const { insertedId } = await coll.analyses.insertOne({
    chainId, tokenAddress, candidateId: cand._id, status: 'queued', requestedAt: new Date(),
  });
  await coll.candidates.updateOne({ _id: cand._id }, { $set: { analysisId: insertedId } });
  await analyzeQueue.add('analyze', { analysisId: insertedId.toString(), chainId, tokenAddress }, { jobId: insertedId.toString() });
  return { status: 'queued', analysisId: insertedId.toString() };
}