import {
  type AxFrameSampler,
  type AxFrameSamplerDecision,
  type AxVisualObservation,
  axFrameSampler,
} from '../../index.js';

const observation: AxVisualObservation = {
  sourceId: 'source',
  streamId: 'stream',
  frameId: 'frame',
  revision: 1,
  freshness: { capturedAtMs: 0, observedAtMs: 0, expiresAtMs: 1_000 },
  dimensions: { width: 640, height: 360 },
  mediaType: 'image/webp',
  byteLength: 1_024,
  tokenEstimate: 256,
  authority: { authorityRef: 'authority', consentRef: 'consent', revision: 1 },
  digest: { algorithm: 'dhash-64', value: '0000000000000000' },
};

const sampler: AxFrameSampler = axFrameSampler();
const decision: AxFrameSamplerDecision = sampler.observe(observation);
void decision;

const missingAuthority: AxVisualObservation = {
  ...observation,
  // @ts-expect-error visual observations require explicit authority metadata
  authority: undefined,
};
void missingAuthority;
