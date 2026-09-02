import { AX_SKILL_PROVENANCE_MAX_AUTHORIZATIONS } from '../authority/skillProvenance.js';
import type { AxAuthorizationReceipt } from '../authority/types.js';
import type { AxAgentContextStage } from './contextEvents.js';

/** One run's attributed cost for one declared-used skill. */
export type AxAgentSkillCostSample = Readonly<{
  id: string;
  success: boolean;
  tokensAttributed?: number;
  wallMs?: number;
  verificationRounds?: number;
}>;

/**
 * Rolling per-skill accounting. `loads` counts prompt renders and `uses` counts
 * actor declarations, deliberately as two numbers: a skill that is loaded and
 * never declared used is uninformative, not free.
 */
export type AxAgentSkillCostProfile = Readonly<{
  id: string;
  /** Times the skill was rendered into a prompt. */
  loads: number;
  /** Times the actor declared it used. */
  uses: number;
  successes: number;
  tokensTotal: number;
  wallMsTotal: number;
  verificationRoundsTotal: number;
  /** Canonical ISO timestamp supplied by the caller's clock. */
  updatedAt: string;
}>;

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export function axUpdateSkillCostProfile(
  existing: Readonly<AxAgentSkillCostProfile> | undefined,
  sample: Readonly<AxAgentSkillCostSample>,
  now: string
): AxAgentSkillCostProfile {
  const base: AxAgentSkillCostProfile = existing ?? {
    id: sample.id,
    loads: 0,
    uses: 0,
    successes: 0,
    tokensTotal: 0,
    wallMsTotal: 0,
    verificationRoundsTotal: 0,
    updatedAt: now,
  };
  return Object.freeze({
    id: base.id,
    loads: base.loads,
    uses: base.uses + 1,
    successes: base.successes + (sample.success ? 1 : 0),
    tokensTotal: base.tokensTotal + finite(sample.tokensAttributed),
    wallMsTotal: base.wallMsTotal + finite(sample.wallMs),
    verificationRoundsTotal:
      base.verificationRoundsTotal + finite(sample.verificationRounds),
    updatedAt: now,
  });
}

/** Record that a skill was rendered into a prompt without claiming it was used. */
export function axRecordSkillLoad(
  existing: Readonly<AxAgentSkillCostProfile> | undefined,
  id: string,
  now: string
): AxAgentSkillCostProfile {
  const base: AxAgentSkillCostProfile = existing ?? {
    id,
    loads: 0,
    uses: 0,
    successes: 0,
    tokensTotal: 0,
    wallMsTotal: 0,
    verificationRoundsTotal: 0,
    updatedAt: now,
  };
  return Object.freeze({ ...base, loads: base.loads + 1, updatedAt: now });
}

/**
 * Attribution by declaration: one turn's cost split equally across the ids the
 * actor declared used. This is NOT a causal measurement of what a skill cost,
 * and the docs say so in those words.
 */
export function axAttributeSkillCost(
  args: Readonly<{
    declaredUsed: readonly string[];
    tokens?: number;
    wallMs?: number;
    verificationRounds?: number;
    success: boolean;
  }>
): readonly AxAgentSkillCostSample[] {
  const ids = [...new Set(args.declaredUsed)].sort();
  if (ids.length === 0) {
    return Object.freeze([]);
  }
  const share = (value: number | undefined): number | undefined =>
    value === undefined || !Number.isFinite(value)
      ? undefined
      : Math.round(value / ids.length);
  const tokensAttributed = share(args.tokens);
  const wallMs = share(args.wallMs);
  const verificationRounds = share(args.verificationRounds);
  return Object.freeze(
    ids.map((id) =>
      Object.freeze({
        id,
        success: args.success,
        ...(tokensAttributed !== undefined ? { tokensAttributed } : {}),
        ...(wallMs !== undefined ? { wallMs } : {}),
        ...(verificationRounds !== undefined ? { verificationRounds } : {}),
      })
    )
  );
}

/** Every weight is exposed. Success rate stays in the numerator by construction. */
export type AxAgentSkillRankingWeights = Readonly<{
  similarity?: number;
  success?: number;
  cost?: number;
  /** Laplace prior. A never-used skill scores 0.5, not 1.0. */
  successPriorAlpha?: number;
  successPriorBeta?: number;
  /** Cost normalizer and zero-division floor, in tokens. */
  costFloorTokens?: number;
}>;

export const axDefaultSkillRankingWeights: Required<AxAgentSkillRankingWeights> =
  Object.freeze({
    similarity: 1,
    success: 1,
    cost: 1,
    successPriorAlpha: 1,
    successPriorBeta: 1,
    costFloorTokens: 1000,
  });

/**
 * `similarity^wSim * successRate^wSuccess / normCost^wCost` where
 * `successRate = (successes + a) / (uses + a + b)` and
 * `normCost = ((tokensTotal + floor) / (uses + 1)) / floor`.
 *
 * With no profile the result is `0.5 * similarity` — a positive constant
 * multiple of similarity, so rank order is provably unchanged.
 */
export function axSkillValueScore(
  similarity: number,
  profile: Readonly<AxAgentSkillCostProfile> | undefined,
  weights?: Readonly<AxAgentSkillRankingWeights>
): number {
  const resolved = { ...axDefaultSkillRankingWeights, ...(weights ?? {}) };
  const floor = Math.max(1, resolved.costFloorTokens);
  const uses = profile ? Math.max(0, profile.uses) : 0;
  const successes = profile ? Math.max(0, profile.successes) : 0;
  const tokensTotal = profile ? Math.max(0, profile.tokensTotal) : 0;
  const successRate =
    (successes + resolved.successPriorAlpha) /
    (uses + resolved.successPriorAlpha + resolved.successPriorBeta);
  const normCost = (tokensTotal + floor) / (uses + 1) / floor;
  const base = Math.max(0, similarity);
  return (
    (base ** resolved.similarity * successRate ** resolved.success) /
    normCost ** resolved.cost
  );
}

/**
 * One terminal state, not two. A host discriminates by handling the
 * `verification_budget` context event, not by an `onExceeded` enum whose
 * branches were behaviourally identical.
 */
export type AxAgentVerificationBudget = Readonly<{
  maxRounds: number;
  /**
   * Qualified tool names that also count as a verification round. Counted by
   * `axCountVerificationToolCall` on the same `afterToolCall` boundary the
   * rails fire on, whether or not any rail is configured.
   */
  verificationTools?: readonly string[];
  /** Per-rail deadline. Default 5000. A rail that exceeds it is disabled. */
  railTimeoutMs?: number;
}>;

export type AxAgentVerificationBudgetState = Readonly<{
  rounds: number;
  status: 'within' | 'exceeded';
  /** Rail ids disabled for the remainder of the run (timeout or throw). */
  disabledRails: readonly string[];
}>;

export const AX_DEFAULT_RAIL_TIMEOUT_MS = 5000;

/**
 * Applied when `verifierRails` are configured and the host set no
 * `verificationBudget`. Without it the rails are unbounded: `status` never
 * leaves `'within'`, every rail fires after every tool call, and a rail
 * emitting a fresh signature per call grows the guidance log for the whole run.
 * An always-on lifecycle hook must have a ceiling even when nobody named one.
 */
export const AX_DEFAULT_VERIFICATION_MAX_ROUNDS = 32;

/** Per-run ceiling on distinct rail diagnostics injected into the guidance log. */
export const AX_MAX_RAIL_DIAGNOSTICS_PER_RUN = 32;

/** Per-diagnostic character bound. A rail cannot grow the prompt by a novel. */
export const AX_MAX_RAIL_DIAGNOSTIC_CHARS = 400;

export function axInitialVerificationBudgetState(): AxAgentVerificationBudgetState {
  return Object.freeze({
    rounds: 0,
    status: 'within' as const,
    disabledRails: Object.freeze([]),
  });
}

/**
 * Deterministic and monotone: once exceeded the state is absorbing. This is
 * never expressed as a prompt instruction — the runtime counts, the model is
 * not told to.
 */
export function axApplyVerificationBudget(
  state: Readonly<AxAgentVerificationBudgetState>,
  budget: Readonly<AxAgentVerificationBudget>
): AxAgentVerificationBudgetState {
  if (state.status === 'exceeded') {
    return state;
  }
  const rounds = state.rounds + 1;
  const maxRounds = Number.isFinite(budget.maxRounds)
    ? Math.max(0, budget.maxRounds)
    : Number.POSITIVE_INFINITY;
  return Object.freeze({
    rounds,
    status: rounds >= maxRounds ? ('exceeded' as const) : ('within' as const),
    disabledRails: state.disabledRails,
  });
}

export type AxAgentRailDiagnostic = Readonly<{
  /** Stable dedupe key. Two diagnostics with this key are the same fact. */
  signature: string;
  code: string;
  message: string;
  severity: 'info' | 'warn' | 'error';
}>;

export type AxAgentVerifierRailContext = Readonly<{
  stage: AxAgentContextStage;
  qualifiedName: string;
  name: string;
  args: Readonly<Record<string, unknown>>;
  result?: unknown;
  error?: string;
  /**
   * Composed from the run's outer abort signal and this invocation's own, so a
   * rail aborts on either.
   */
  signal: AbortSignal;
  /** The rail's own deadline, already applied by the runtime. */
  timeoutMs: number;
}>;

/**
 * An unconditional lifecycle hook: it fires after every tool call and may
 * surface a second, unrequested signal.
 *
 * CONTAINMENT CONTRACT, enforced by the runtime and not by the rail:
 * - every rail is raced against `railTimeoutMs`, with the abort listener
 *   removed on settle;
 * - a rail that throws or rejects is swallowed, recorded as a `rail_error`
 *   diagnostic, and disabled for the remainder of the run;
 * - a rail that exceeds its deadline counts a round, is recorded as
 *   `rail_timeout`, and is disabled for the remainder of the run;
 * - rail outcomes never alter the tool call's own result, error, or timing.
 */
export type AxAgentVerifierRail = Readonly<{
  id: string;
  stage: 'afterToolCall';
  verify(
    context: Readonly<AxAgentVerifierRailContext>
  ):
    | readonly Readonly<AxAgentRailDiagnostic>[]
    | Promise<readonly Readonly<AxAgentRailDiagnostic>[]>;
}>;

/**
 * The load-bearing half of the rail: only novel signatures are injected as
 * evidence. Without this an always-on rail floods the context with the same
 * fact on every tool call.
 */
export function axDedupeRailDiagnostics(
  seen: ReadonlySet<string>,
  produced: readonly Readonly<AxAgentRailDiagnostic>[]
): Readonly<{
  novel: readonly AxAgentRailDiagnostic[];
  suppressed: readonly AxAgentRailDiagnostic[];
}> {
  const novel: AxAgentRailDiagnostic[] = [];
  const suppressed: AxAgentRailDiagnostic[] = [];
  const withinBatch = new Set<string>();
  for (const diagnostic of produced) {
    if (!diagnostic || typeof diagnostic.signature !== 'string') {
      continue;
    }
    if (
      seen.has(diagnostic.signature) ||
      withinBatch.has(diagnostic.signature)
    ) {
      suppressed.push(diagnostic);
      continue;
    }
    withinBatch.add(diagnostic.signature);
    novel.push(diagnostic);
  }
  return Object.freeze({
    novel: Object.freeze(novel),
    suppressed: Object.freeze(suppressed),
  });
}

export type AxAgentRailOutcome = Readonly<{
  diagnostics: readonly AxAgentRailDiagnostic[];
  /** True when the rail must be disabled for the remainder of the run. */
  disable: boolean;
}>;

/**
 * Run one rail under a deadline, contained. The deadline — not the `await` — is
 * what bounds it: awaiting an unbounded promise inside the tool-call observer
 * does not bound anything.
 */
/**
 * A rail's diagnostic is model-facing text produced by host code, and the
 * guidance log has no truncation of its own. Bound it here, at the boundary,
 * rather than trusting every rail author to be brief.
 */
function boundRailDiagnostic(
  diagnostic: Readonly<AxAgentRailDiagnostic>
): AxAgentRailDiagnostic {
  const message = String(diagnostic.message ?? '');
  const signature = String(diagnostic.signature ?? '');
  if (
    message.length <= AX_MAX_RAIL_DIAGNOSTIC_CHARS &&
    signature.length <= AX_MAX_RAIL_DIAGNOSTIC_CHARS
  ) {
    return diagnostic;
  }
  return Object.freeze({
    ...diagnostic,
    signature: signature.slice(0, AX_MAX_RAIL_DIAGNOSTIC_CHARS),
    message: message.slice(0, AX_MAX_RAIL_DIAGNOSTIC_CHARS),
  });
}

export async function axRunVerifierRail(
  rail: Readonly<AxAgentVerifierRail>,
  context: Readonly<Omit<AxAgentVerifierRailContext, 'timeoutMs'>>,
  timeoutMs: number
): Promise<AxAgentRailOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const signal = context.signal;
  try {
    const deadline = new Promise<'cut'>((resolve) => {
      timer = setTimeout(
        () => {
          resolve('cut');
        },
        Math.max(0, timeoutMs)
      );
      if (signal.aborted) {
        resolve('cut');
        return;
      }
      onAbort = () => {
        resolve('cut');
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const outcome = await Promise.race([
      Promise.resolve(rail.verify({ ...context, timeoutMs })),
      deadline,
    ]);
    if (outcome === 'cut') {
      return Object.freeze({
        diagnostics: Object.freeze([
          Object.freeze({
            signature: `rail_timeout:${rail.id}`,
            code: 'rail_timeout',
            message: `Verifier rail ${rail.id} exceeded ${timeoutMs}ms and was disabled`,
            severity: 'warn' as const,
          }),
        ]),
        disable: true,
      });
    }
    return Object.freeze({
      diagnostics: Object.freeze(
        Array.isArray(outcome) ? outcome.map(boundRailDiagnostic) : []
      ),
      disable: false,
    });
  } catch (error) {
    return Object.freeze({
      diagnostics: Object.freeze([
        Object.freeze({
          signature: `rail_error:${rail.id}`,
          code: 'rail_error',
          message: `Verifier rail ${rail.id} failed and was disabled: ${
            error instanceof Error ? error.message : String(error)
          }`,
          severity: 'error' as const,
        }),
      ]),
      disable: true,
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort) {
      // No abort listener survives settle, aborted or not.
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Everything the runtime needs to fire rails for one run. Held on the agent
 * state so the tool wrapper can reach it without another positional parameter,
 * exactly as the working-state receipt sink is.
 */
export type AxAgentVerifierRailBinding = Readonly<{
  rails: readonly Readonly<AxAgentVerifierRail>[];
  budget?: Readonly<AxAgentVerificationBudget>;
  stage: AxAgentContextStage;
  getState: () => AxAgentVerificationBudgetState;
  setState: (state: AxAgentVerificationBudgetState) => void;
  /** Signatures already surfaced this run. Dedupe is per run, not per turn. */
  seen: Set<string>;
  /** Surfaces novel diagnostics as evidence. Never called with a repeat. */
  emit: (diagnostics: readonly Readonly<AxAgentRailDiagnostic>[]) => void;
  onStateChange?: (state: AxAgentVerificationBudgetState) => void;
}>;

/**
 * Count one settled tool call against the budget when its qualified name is in
 * `budget.verificationTools`.
 *
 * RFC 7.5: "a round is one rail firing, OR one tool call whose `qualifiedName`
 * is in `budget.verificationTools`." This is the second half, and it is
 * independent of the rails — a host may declare its own verification tools and
 * configure no rails at all.
 */
export function axCountVerificationToolCall(
  binding: Readonly<AxAgentVerifierRailBinding>,
  qualifiedName: string
): void {
  const budget = binding.budget;
  if (!budget?.verificationTools?.includes(qualifiedName)) {
    return;
  }
  const state = binding.getState();
  if (state.status !== 'within') {
    return;
  }
  const next = axApplyVerificationBudget(state, budget);
  binding.setState(next);
  binding.onStateChange?.(next);
}

/**
 * Fire every enabled rail for one settled tool call.
 *
 * The caller has already determined the tool call's result or error; nothing
 * here can change either. Each rail costs one verification round, is bounded by
 * `railTimeoutMs`, and is disabled for the rest of the run if it throws or
 * overruns. Once the budget is exceeded no further rail fires.
 */
export async function axFireVerifierRails(
  binding: Readonly<AxAgentVerifierRailBinding>,
  context: Readonly<Omit<AxAgentVerifierRailContext, 'timeoutMs'>>
): Promise<void> {
  if (binding.rails.length === 0) {
    return;
  }
  let state = binding.getState();
  if (state.status !== 'within') {
    return;
  }
  const timeoutMs = binding.budget?.railTimeoutMs ?? AX_DEFAULT_RAIL_TIMEOUT_MS;
  for (const rail of binding.rails) {
    if (state.disabledRails.includes(rail.id)) {
      continue;
    }
    if (binding.budget) {
      state = axApplyVerificationBudget(state, binding.budget);
      binding.setState(state);
      binding.onStateChange?.(state);
    }
    const outcome = await axRunVerifierRail(rail, context, timeoutMs);
    if (outcome.disable) {
      state = Object.freeze({
        rounds: state.rounds,
        status: state.status,
        disabledRails: Object.freeze([...state.disabledRails, rail.id]),
      });
      binding.setState(state);
      binding.onStateChange?.(state);
    }
    const { novel } = axDedupeRailDiagnostics(
      binding.seen,
      outcome.diagnostics
    );
    // Dedupe alone does not bound a rail that emits a FRESH signature every
    // call, and the guidance log neither caps nor truncates.
    const headroom = Math.max(
      0,
      AX_MAX_RAIL_DIAGNOSTICS_PER_RUN - binding.seen.size
    );
    const admitted = novel.slice(0, headroom);
    for (const diagnostic of admitted) {
      binding.seen.add(diagnostic.signature);
    }
    if (admitted.length > 0) {
      binding.emit(admitted);
    }
    if (state.status !== 'within') {
      break;
    }
  }
}

/**
 * A bounded per-run join of authorization receipts, ready for
 * `axExtractSkillProvenance`. Deduped by operation plus sorted grant ids and
 * capped; over-cap input drops the oldest entry and flags truncation, so a
 * weaker record is visible rather than silently smaller.
 */
export type AxAgentSkillProvenanceAccumulator = Readonly<{
  capture: (receipt: Readonly<AxAuthorizationReceipt>) => void;
  snapshot: () => Readonly<{
    receipts: readonly Readonly<AxAuthorizationReceipt>[];
    truncated: boolean;
  }>;
}>;

export function axCreateSkillProvenanceAccumulator(
  maxAuthorizations = AX_SKILL_PROVENANCE_MAX_AUTHORIZATIONS
): AxAgentSkillProvenanceAccumulator {
  const byKey = new Map<string, Readonly<AxAuthorizationReceipt>>();
  let truncated = false;
  const cap = Math.max(1, maxAuthorizations);
  return Object.freeze({
    capture: (receipt: Readonly<AxAuthorizationReceipt>) => {
      if (!receipt || typeof receipt.receiptId !== 'string') {
        return;
      }
      const key = `${receipt.operation} ${[...(receipt.grantIds ?? [])]
        .slice()
        .sort()
        .join(',')}`;
      if (byKey.has(key)) {
        return;
      }
      byKey.set(key, receipt);
      while (byKey.size > cap) {
        const oldest = byKey.keys().next().value as string;
        byKey.delete(oldest);
        truncated = true;
      }
    },
    snapshot: () =>
      Object.freeze({
        receipts: Object.freeze([...byKey.values()]),
        truncated,
      }),
  });
}
