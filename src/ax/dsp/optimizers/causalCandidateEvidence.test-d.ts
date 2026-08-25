import {
  type AxCausalCandidateEvidenceManifest,
  type AxCausalCandidateEvidenceOptions,
  type AxCausalCandidateEvidenceRecord,
  type AxCausalEvidenceAuthorityVerifier,
  type AxOptimizedProgram,
  axAttachCausalCandidateEvidence,
  type axFingerprintCausalEvidence,
  axReplaceOptimizedProgramSnapshot,
} from '../../index.js';
import type { Equal, Expect } from '../../util/typetest.js';

declare const artifact: AxOptimizedProgram;
declare const records: readonly AxCausalCandidateEvidenceRecord[];
declare const options: AxCausalCandidateEvidenceOptions;
declare const verifier: AxCausalEvidenceAuthorityVerifier;

const attached = axAttachCausalCandidateEvidence(artifact, records, options);
const replaced = axReplaceOptimizedProgramSnapshot(
  attached,
  artifact,
  verifier
);
type _manifest = Expect<
  Equal<
    typeof attached.causalCandidateEvidence,
    AxCausalCandidateEvidenceManifest | undefined
  >
>;
type _replacement = Expect<Equal<typeof replaced, typeof attached>>;
type _fingerprint = Expect<
  Equal<ReturnType<typeof axFingerprintCausalEvidence>, Promise<string>>
>;

declare const manifest: AxCausalCandidateEvidenceManifest;
// @ts-expect-error Published evidence links are readonly.
manifest.records[0]!.hypothesis = 'replace';
// @ts-expect-error Evidence record arrays are readonly.
manifest.records.push(records[0]!);
