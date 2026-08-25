import {
  type AxPreferenceEvidenceRecord,
  type AxPreferenceEvidenceSelection,
  axPreferenceEvidenceToMemories,
  axSelectPreferenceEvidence,
} from '../index.js';

const records = [
  {
    id: 'style',
    principalId: 'principal:example',
    revisions: [
      {
        operation: 'assert',
        revision: 1,
        kind: 'confirmed-preference',
        value: 'Use concise bullet points.',
        sourceRef: 'source:settings:1',
        confidence: 1,
        scope: 'response-style',
        recordedAt: '2026-08-20T12:00:00.000Z',
        authorityRef: 'authority:account:1',
        consentRef: 'consent:personalization:1',
      },
    ],
  },
] as const satisfies readonly AxPreferenceEvidenceRecord[];

const selection: AxPreferenceEvidenceSelection = axSelectPreferenceEvidence(
  records,
  {
    principalId: 'principal:example',
    query: 'concise response',
    scope: 'response-style',
    now: '2026-08-25T12:00:00.000Z',
    acceptedSourceRefs: ['source:settings:1'],
    acceptedAuthorityRefs: ['authority:account:1'],
    acceptedConsentRefs: ['consent:personalization:1'],
  }
);

axPreferenceEvidenceToMemories(selection);

// A model-authored consent string is insufficient unless the host admits it.
axSelectPreferenceEvidence(records, {
  principalId: 'principal:example',
  query: 'concise response',
  scope: 'response-style',
  now: '2026-08-25T12:00:00.000Z',
  acceptedSourceRefs: [],
  acceptedAuthorityRefs: [],
  acceptedConsentRefs: [],
});
