import {
  type AxCausalCandidateEvidenceManifest,
  type AxCausalCandidateEvidenceRecord,
  type AxOptimizedProgram,
  axAttachCausalCandidateEvidence,
  axReplaceOptimizedProgramSnapshot,
} from '../../index.js';
import type { Equal, Expect } from '../../util/typetest.js';

declare const artifact: AxOptimizedProgram;
declare const records: readonly AxCausalCandidateEvidenceRecord[];

const attached = axAttachCausalCandidateEvidence(artifact, records);
const replaced = axReplaceOptimizedProgramSnapshot(attached, artifact);
type _manifest = Expect<
  Equal<
    typeof attached.causalCandidateEvidence,
    AxCausalCandidateEvidenceManifest | undefined
  >
>;
type _replacement = Expect<Equal<typeof replaced, typeof attached>>;

declare const manifest: AxCausalCandidateEvidenceManifest;
// @ts-expect-error Published evidence links are readonly.
manifest.records[0]!.hypothesis = 'replace';
// @ts-expect-error Evidence record arrays are readonly.
manifest.records.push(records[0]!);
