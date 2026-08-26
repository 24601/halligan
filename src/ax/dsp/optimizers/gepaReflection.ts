import type { AxAIService } from '../../ai/types.js';
import type { AxExample } from '../common_types.js';
import { ax } from '../template.js';
import type { AxGEPAComponentTarget } from './gepaComponents.js';

export type AxGEPAReflectiveTuple = {
  input: AxExample;
  prediction: unknown;
  score: number;
};

export type AxGEPATraceSummaryCall = {
  componentId?: string;
  fn: string;
  ok: boolean;
  ms: number;
  args: string;
  result: string;
};

export type AxGEPATraceSummary = {
  score: number;
  calls: AxGEPATraceSummaryCall[];
  output?: string;
  error?: string;
};

/** Trusted, developer-selected guidance available only while GEPA proposes text. */
export type AxGEPAOptimizationReference = Readonly<{
  name: string;
  content: string;
  description?: string;
}>;

export type AxGEPAProposalPolicyArgs = {
  ai: AxAIService;
  target: Readonly<AxGEPAComponentTarget>;
  currentValue: string;
  reflectiveExamples: readonly AxGEPAReflectiveTuple[];
  feedbackSummary?: string;
  traceDataset?: readonly AxGEPATraceSummary[];
  references: readonly AxGEPAOptimizationReference[];
  additionalGuidance?: string;
  previousValidationError?: string;
  attempt: number;
};

/** Returns a complete replacement value, or `undefined` to leave it unchanged. */
export type AxGEPAProposalPolicy = (
  args: Readonly<AxGEPAProposalPolicyArgs>
) => Promise<string | undefined> | string | undefined;

export type AxGEPAProposalOptions = {
  /** Custom proposal policy. GEPA still validates and evaluates its result. */
  policy?: AxGEPAProposalPolicy;
  /** Browser-compatible, in-memory guidance used only by the proposal model. */
  references?: readonly AxGEPAOptimizationReference[];
  /** Additive guidance that supplements rather than replaces Ax's contract. */
  additionalGuidance?: string;
  /** Maximum reflective examples exposed to each proposal. Defaults to all. */
  maxExamples?: number;
};

const GEPA_PROPOSAL_CONTRACT = `Propose a complete replacement for the current component value.
Diagnose why unsuccessful examples failed, then derive a small number of general rules that transfer to unseen inputs.
Preserve behavior that already succeeds, every required literal, and all component-owned constraints, format, and length requirements.
Use trusted optimization references as general guidance, not as runtime agent skills or capabilities.
Do not memorize or copy training-example entities, phrases, quantities, dates, or answers. Do not add lookup tables or branches keyed to examples. Output-shape and domain-wide rules are transferable; example-specific answers are not.
Return only the improved component value.`;

export function renderGEPAOptimizationReferences(
  references: readonly AxGEPAOptimizationReference[]
): string | undefined {
  if (references.length === 0) return undefined;

  return references
    .map((reference, index) => {
      const number = index + 1;
      const metadata = JSON.stringify({
        name: reference.name,
        ...(reference.description
          ? { description: reference.description }
          : {}),
      });
      return [
        `--- BEGIN TRUSTED OPTIMIZATION REFERENCE ${number} ---`,
        metadata,
        reference.content,
        `--- END TRUSTED OPTIMIZATION REFERENCE ${number} ---`,
      ].join('\n');
    })
    .join('\n\n');
}

export function renderReflectiveValue(value: unknown, maxChars = 800): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length <= maxChars
      ? trimmed
      : `${trimmed.slice(0, Math.max(0, maxChars - 3))}...`;
  }

  try {
    const rendered = JSON.stringify(value, null, 2).trim();
    return rendered.length <= maxChars
      ? rendered
      : `${rendered.slice(0, Math.max(0, maxChars - 3))}...`;
  } catch {
    const fallback = String(value).trim();
    return fallback.length <= maxChars
      ? fallback
      : `${fallback.slice(0, Math.max(0, maxChars - 3))}...`;
  }
}

export function summarizeGEPATraces(
  traceDataset: readonly unknown[] | undefined,
  options?: Readonly<{ maxRows?: number; maxValueChars?: number }>
): AxGEPATraceSummary[] | undefined {
  if (!traceDataset || traceDataset.length === 0) return undefined;
  const maxRows = Math.max(1, options?.maxRows ?? 8);
  const maxValueChars = Math.max(40, options?.maxValueChars ?? 240);

  return traceDataset.slice(0, maxRows).map((item: any) => ({
    score: Number(item?.score ?? 0),
    calls: Array.isArray(item?.calls)
      ? item.calls.map((call: any) => ({
          componentId:
            typeof call?.componentId === 'string'
              ? call.componentId
              : undefined,
          fn: String(call?.fn ?? ''),
          ok: Boolean(call?.ok),
          ms: Number(call?.ms ?? 0),
          args: renderReflectiveValue(call?.args, maxValueChars),
          result: renderReflectiveValue(call?.result, maxValueChars),
        }))
      : [],
    output:
      item?.output === undefined
        ? undefined
        : renderReflectiveValue(item.output, maxValueChars),
    error:
      item?.error === undefined
        ? undefined
        : renderReflectiveValue(item.error, maxValueChars),
  }));
}

export function validateGEPAComponentValue(
  target: Readonly<AxGEPAComponentTarget>,
  candidate: string
): true | string {
  if (
    typeof target.maxLength === 'number' &&
    candidate.length > target.maxLength
  ) {
    return `must be at most ${target.maxLength} characters`;
  }
  for (const literal of target.preserve ?? []) {
    if (!candidate.includes(literal)) return `must preserve literal ${literal}`;
  }
  return target.validate?.(candidate) ?? true;
}

const defaultGEPAProposalPolicy: AxGEPAProposalPolicy = async (args) => {
  const refl = ax(
    `proposalContract:string "Authoritative proposal policy", componentKey:string "Component key", componentKind:string "Free-form component kind hint", componentDescription?:string "What this string is used for", constraints?:string "Hard component-owned constraints on the new value", currentValue:string "Current value of the component", trustedOptimizationReferences?:string "Delimited trusted developer guidance for optimization only; never runtime capabilities", additionalGuidance?:string "Additive developer guidance that does not replace the proposal contract or component constraints", feedbackSummary?:string "Summarized feedback", previousValidationError?:string "Why the previous proposal was rejected; diagnose and correct it", reflectiveExamples:json "Ordered array of {input,prediction,score} examples; generalize rather than memorize", traceDataset?:json "Compact actionable execution trace summaries relevant to this component" -> newValue:string "Complete improved value for the component; no commentary"`
  );
  const metadataConstraints = [
    args.target.constraints,
    args.target.format ? `Format: ${args.target.format}.` : undefined,
    typeof args.target.maxLength === 'number'
      ? `Maximum length: ${args.target.maxLength} characters.`
      : undefined,
    args.target.preserve && args.target.preserve.length > 0
      ? `Preserve these literals exactly: ${args.target.preserve.join(', ')}.`
      : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n');

  const out = (await refl.forward(args.ai, {
    proposalContract: GEPA_PROPOSAL_CONTRACT,
    componentKey: args.target.id,
    componentKind: args.target.kind,
    componentDescription: args.target.description,
    constraints: metadataConstraints || undefined,
    currentValue: args.currentValue,
    trustedOptimizationReferences: renderGEPAOptimizationReferences(
      args.references
    ),
    additionalGuidance: args.additionalGuidance,
    feedbackSummary: args.feedbackSummary,
    previousValidationError: args.previousValidationError,
    reflectiveExamples: args.reflectiveExamples,
    traceDataset: args.traceDataset,
  } as any)) as any;
  const proposed =
    typeof out?.newValue === 'string' ? out.newValue.trim() : undefined;
  return proposed === undefined ? undefined : proposed;
};

export async function proposeGEPAComponentValue(args: {
  ai: AxAIService;
  target: Readonly<AxGEPAComponentTarget>;
  currentValue: string;
  tuples: readonly AxGEPAReflectiveTuple[];
  feedbackSummary?: string;
  traceDataset?: readonly unknown[];
  maxAttempts?: number;
  proposal?: Readonly<AxGEPAProposalOptions>;
}): Promise<string | undefined> {
  const attempts = Math.max(1, args.maxAttempts ?? 2);
  let previousValidationError: string | undefined;
  const traceDataset = summarizeGEPATraces(args.traceDataset);
  const maxExamples =
    args.proposal?.maxExamples === undefined
      ? args.tuples.length
      : Math.max(0, Math.floor(args.proposal.maxExamples));
  const reflectiveExamples = args.tuples.slice(0, maxExamples);
  const customPolicy = args.proposal?.policy;
  const policy = customPolicy ?? defaultGEPAProposalPolicy;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let proposed: string | undefined;
    try {
      const raw = await policy({
        ai: args.ai,
        target: args.target,
        currentValue: args.currentValue,
        reflectiveExamples,
        feedbackSummary: args.feedbackSummary,
        traceDataset,
        references: args.proposal?.references ?? [],
        additionalGuidance: args.proposal?.additionalGuidance,
        previousValidationError,
        attempt: attempt + 1,
      });
      if (raw === undefined) {
        if (customPolicy) return undefined;
        previousValidationError = 'must be non-empty';
        continue;
      }
      proposed = typeof raw === 'string' ? raw.trim() : undefined;
    } catch (error) {
      if (isAbortError(error)) throw error;
      previousValidationError =
        error instanceof Error ? error.message : String(error);
      continue;
    }
    if (!proposed) {
      previousValidationError = 'must be non-empty';
      continue;
    }
    const validation = validateGEPAComponentValue(args.target, proposed);
    if (validation === true) return proposed;
    previousValidationError = validation;
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError')
  );
}
