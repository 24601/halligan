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
    streamId: 'stream:style',
    streamVersion: 1,
    epoch: 1,
    revisions: [
      {
        operation: 'assert',
        revision: 1,
        epoch: 1,
        eventId: 'event:style:1',
        kind: 'confirmed-preference',
        value: 'Use concise bullet points.',
        sourceReceiptRef: 'source:settings:1',
        confidence: 1,
        scope: 'response-style',
        recordedAt: '2026-08-20T12:00:00.000Z',
        authorityReceiptRef: 'authority:account:1',
        consentReceiptRef: 'consent:personalization:1',
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
    verifyStreamState: (request) =>
      request.record.streamVersion === request.streamVersion,
    verifyReceipt: (request) =>
      request.event.eventId === request.eventId &&
      request.receiptRef.length > 0,
    verifyDestructiveLifecycleReceipt: (request) =>
      request.purpose === 'destructive-lifecycle',
  }
);

axPreferenceEvidenceToMemories(selection);
