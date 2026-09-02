/**
 * Verifier-gated typed working state for the actor loop.
 *
 * A compact typed state document maintained beside the transcript, whose every
 * mutation must be supported by host-owned evidence before it commits. The
 * document carries a goal ledger keyed by stable goal id plus a host-declared
 * fact space. Each turn a proposer emits an RFC-6902-subset patch; the commit
 * kernel classifies every op against a CLOSED table; the host checker (sharing
 * `AxEventVerifierResult` verbatim with the event runtime) may only make the
 * kernel stricter; and unsupported deltas park visibly against a bounded
 * budget instead of silently vanishing.
 *
 * The load-bearing rule: a goal flips to `done` only on a structured tool
 * receipt minted by the harness at the dispatch site — never on model
 * self-report, and a checker `pass` cannot loosen that.
 *
 * Everything here is off by default. With no `workingState` option configured
 * nothing in this module is constructed, imported at runtime, or observed.
 *
 * See `docs/AGENT_WORKING_STATE.md` for the normative contract and
 * `src/ax/skills/ax-agent-state.md` for the codegen rules.
 */

import type { AxAIService } from '../ai/types.js';
import type { AxGen } from '../dsp/generate.js';
import { AxSignature } from '../dsp/sig.js';
import { ax } from '../dsp/template.js';
import type { AxProgramForwardOptions } from '../dsp/types.js';
import { AxInMemoryProgramStateStore } from '../event/memoryStore.js';
import {
  type AxEventClock,
  type AxEventVerificationUsage,
  type AxEventVerifierResult,
  type AxProgramStateStore,
  AxSystemEventClock,
} from '../event/types.js';
import { axEventCanonicalDigest, axEventCanonicalJson } from '../event/util.js';
import { mergeAbortSignals } from '../util/abort.js';
import type { AxAgentContextStage } from './contextEvents.js';
import {
  type AxStatePatch,
  type AxStatePatchOp,
  axApplyStatePatch,
  parseStatePatchPointer,
} from './statePatch.js';

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export type AxWorkingStateGoalStatus = 'pending' | 'done' | 'blocked';

/**
 * A structured environment receipt. Only the harness can mint one, and only
 * from a receipt-eligible dispatch site.
 */
export type AxWorkingStateReceipt = Readonly<{
  kind: 'tool_receipt';
  /**
   * Short, stable, model-citable handle assigned in mint order: `r1`, `r2`, …
   * This is what the model sees and cites; it is NOT a secret. The protection
   * is membership in the harness-owned receipt list, not secrecy of a hash.
   */
  ref: string;
  /** Namespaced callable, e.g. `inventory.adjustStock`. */
  qualifiedName: string;
  /** 1-based actor turn that produced it (joins to `ActionLogEntry.turn`). */
  turn: number;
  /** SHA-256 over canonical {qualifiedName, arguments, result}. Audit only. */
  fingerprint: string;
  /** Clock time captured at the dispatch site when the call returned. */
  at: number;
  /**
   * How many recorder observations collapsed into this receipt. >1 means the
   * runtime's deterministic-speculation path reported one physical effect as
   * two logical calls; receipts dedupe by fingerprint so one environment
   * change is one receipt.
   */
  observations: number;
}>;

/** A model-citable reference to a harness-minted receipt. */
export type AxWorkingStateEvidenceRef = Readonly<{
  kind: 'tool_receipt';
  /** Must be present in `AxWorkingState.receipts()`; unknown refs park. */
  ref: string;
}>;

export type AxWorkingStateGoal = Readonly<{
  /** Stable, immutable. Must match `^[A-Za-z0-9_.:-]{1,64}$`. */
  id: string;
  goal: string;
  status: AxWorkingStateGoalStatus;
  evidence: readonly AxWorkingStateEvidenceRef[];
  blocker?: string;
  /**
   * Immutable-after-creation allowlist of qualified callables whose receipts
   * can support `done` for this goal. Empty is legal ONLY on a host-seeded
   * goal and means any receipt in the run qualifies; a model-authored goal
   * must declare a non-empty `expects` that is a subset of `expectsAllowlist`.
   */
  expects?: readonly string[];
  createdTurn: number;
  updatedTurn: number;
}>;

/**
 * The committed document. `S` is the host's typed fact space, declared by the
 * `stateSignature` and validated by the checker; ax never interprets it.
 *
 * `goals` is a KEYED OBJECT, not an array: sequential RFC-6902 application
 * shifts array indices, so an index-addressed goal op could be classified
 * against one goal and applied to another. Keying by id removes the bug class.
 */
export type AxWorkingStateDocument<S = Record<string, unknown>> = Readonly<{
  schemaVersion: number;
  goals: Readonly<Record<string, AxWorkingStateGoal>>;
  facts: Readonly<S>;
  /** Deltas the checker did not support, kept visible. Bounded by the budget. */
  parked: readonly AxWorkingStateParkedDelta[];
}>;

export type AxWorkingStateParkReason =
  | 'no_supporting_receipt'
  | 'unknown_receipt_ref'
  | 'receipt_not_expected'
  | 'model_goals_disabled'
  | 'expects_not_allowed'
  | 'undeclared_fact_path'
  | 'checker_failed'
  | 'checker_error'
  | 'checker_timeout'
  | 'revision_conflict'
  | 'blocker_missing';

export type AxWorkingStateParkedDelta = Readonly<{
  /** Op KIND and sanitized path only — the model's `value` is never retained. */
  op: Readonly<{ op: AxStatePatchOp['op']; path: string }>;
  reason: AxWorkingStateParkReason;
  /** Checker-supplied failure code when `reason` is `checker_failed`. */
  failureCode?: string;
  /** Bounded, host-supplied evidence, capped at `maxEvidenceBytes`. */
  evidence?: unknown;
  parkedTurn: number;
  parkedAt: number;
  attempt: number;
}>;

// ---------------------------------------------------------------------------
// Classification and checking
// ---------------------------------------------------------------------------

export type AxWorkingStateDeltaClass =
  | 'goal_add'
  | 'goal_complete'
  | 'goal_block'
  | 'goal_retract'
  | 'goal_remove'
  | 'goal_edit'
  | 'evidence_append'
  | 'fact_write'
  | 'guard'
  | 'reserved';

export type AxWorkingStateClassifiedOp = Readonly<{
  op: AxStatePatchOp;
  class: AxWorkingStateDeltaClass;
  /** Goal id the op targets, resolved from the PATH, when goal-scoped. */
  goalId?: string;
  /**
   * Harness-authored pointer built from the CLASSIFICATION, never from the
   * model's own path text. This is the only pointer that may reach the
   * trusted guidance channel or the read-only roster: every segment comes
   * from a closed vocabulary (`goals`, `facts`, the enumerated goal fields,
   * a `GOAL_ID_PATTERN`-validated goal id, a host-declared fact root, or a
   * `<...>` placeholder), so a hostile path cannot launder text into the
   * highest-authority prompt region.
   */
  canonicalPath: string;
  /** Kernel verdict before the checker runs. */
  kernelVerdict: 'admissible' | 'park' | 'forbidden';
  kernelReason?:
    | AxWorkingStateParkReason
    | 'reserved_path'
    | 'immutable_field'
    | 'unclassified';
}>;

export type AxWorkingStateCheckContext<S = Record<string, unknown>> = Readonly<{
  /** Committed state at the start of this turn. */
  readonly believedState: AxWorkingStateDocument<S>;
  /** Kernel-admissible proposal — forbidden and parked ops are already gone. */
  readonly proposedState: AxWorkingStateDocument<S>;
  /** Ops the kernel is asking about. `guard` ops are excluded. */
  readonly deltas: readonly AxWorkingStateClassifiedOp[];
  /** Every receipt minted so far this run. Host-owned; the model cannot add. */
  readonly receipts: readonly AxWorkingStateReceipt[];
  /** Code the actor executed this turn. */
  readonly action: string;
  /** Truncated runtime output for this turn. */
  readonly observation: string;
  readonly turn: number;
  readonly stage: AxAgentContextStage;
  readonly signal: AbortSignal;
}>;

/**
 * Host-owned gate on a state mutation. Returns the same verdict type the event
 * runtime's verifier returns. It may only make the kernel STRICTER: a `pass`
 * on a `goal_complete` whose kernel verdict was `park` does not commit it.
 */
export type AxWorkingStateChecker<S = Record<string, unknown>> = (
  context: Readonly<AxWorkingStateCheckContext<S>>
) => AxEventVerifierResult | Promise<AxEventVerifierResult>;

/**
 * Mirrors every limit field of `AxEventVerifierPolicy`; all limits fail
 * closed. The `verify` BODY is not portable — `check` is arity-1 over an
 * agent-turn context, by design.
 */
export interface AxWorkingStateCheckerPolicy<S = Record<string, unknown>> {
  id: string;
  check: AxWorkingStateChecker<S>;
  /** Optional stable fingerprint of the proposal, recorded on the trace. */
  fingerprint?: (
    proposed: Readonly<AxWorkingStateDocument<S>>
  ) => string | Promise<string>;
  /** Optional usage report for a model-backed checker; feeds the caps below. */
  usage?: (
    context: Readonly<AxWorkingStateCheckContext<S>>
  ) =>
    | Readonly<AxEventVerificationUsage>
    | Promise<Readonly<AxEventVerificationUsage>>;
  /** Wall-clock cap for one check. Exceeded ⇒ every delta parks. */
  timeoutMs?: number;
  /** Checker invocations tolerated in one run. Exceeded ⇒ deltas park. */
  maxChecksPerRun?: number;
  /** Cumulative caps for a model-backed checker; each is fail-closed. */
  maxTokens?: number;
  maxWallTimeMs?: number;
  maxCostUSD?: number;
  /** Cap on serialized `failure.evidence` retained on a parked delta. */
  maxEvidenceBytes?: number;
  /** Parked deltas tolerated for one goal before the goal is force-blocked. */
  maxParksPerGoal?: number;
  /** Parked deltas tolerated in one run before the run fails closed. */
  maxParksPerRun?: number;
  backoffMs?:
    | number
    | ((attempt: number, failure: Readonly<{ code: string }>) => number);
}

// ---------------------------------------------------------------------------
// Trace (Gamma)
// ---------------------------------------------------------------------------

/**
 * The structured execution trace: one record per actor turn under
 * `workingState.trace: true`. Bounded and fingerprinted like causal evidence —
 * never raw payloads, never PII. Digests are SHA-256 over canonical bytes.
 */
export type AxWorkingStateTraceStep = Readonly<{
  /** Per-`forward()` run id, NOT the program id. */
  runId: string;
  stage: AxAgentContextStage;
  /** 1-based; joins to `ActionLogEntry.turn` and `AxAgentRecursiveTurn.turn`. */
  turn: number;
  believedStateDigest: string;
  /** Skill ids in scope for this turn, sorted. */
  selectedSkills: readonly string[];
  action: Readonly<{
    codeDigest: string;
    codeChars: number;
    /** False when a call-time skill injection suppressed execution. */
    executed: boolean;
    /** Qualified callables the turn actually invoked, sorted, deduped. */
    calls: readonly string[];
  }>;
  observation: Readonly<{
    digest: string;
    chars: number;
    isError: boolean;
    /** Receipt refs minted this turn, in mint order. */
    receipts: readonly string[];
  }>;
  proposedStateDigest?: string;
  proposal: 'none' | 'emitted' | 'invalid' | 'error';
  checkerVerdict:
    | Readonly<{ status: 'skipped' }>
    | Readonly<{ status: 'pass'; policyId: string }>
    | Readonly<{ status: 'fail'; policyId: string; code: string }>
    | Readonly<{
        status: 'error';
        policyId: string;
        code: 'checker_error' | 'checker_timeout';
      }>;
  committedStateDigest: string;
  committedRevision: number;
  committed: readonly AxWorkingStateDeltaClass[];
  parked: readonly AxWorkingStateParkReason[];
  outcome: 'committed' | 'partially_committed' | 'unchanged' | 'rejected';
  /** Set when a completion interlock fired or was exhausted this turn. */
  completionInterlock?: 'converted' | 'exhausted';
  /** Optional bounded human summary; retained only when `trace.summaries`. */
  summary?: string;
  at: number;
}>;

export type AxWorkingStateTraceSink = (
  step: Readonly<AxWorkingStateTraceStep>
) => void | Promise<void>;

/**
 * Stable digest of a Gamma step's DETERMINISTIC fields — every field except
 * `runId`, `at` and `summary`. This is the value the portability/determinism
 * assertions compare across runs; the wall-clock and run-identity fields are
 * deliberately excluded because they are not reproducible by construction.
 */
export const axWorkingStateTraceDigest = (
  step: Readonly<AxWorkingStateTraceStep>
): Promise<string> => {
  const { runId: _runId, at: _at, summary: _summary, ...deterministic } = step;
  return axEventCanonicalDigest(deterministic);
};

/** Stable digest for a state document. Exported so hosts can join records. */
export const axWorkingStateFingerprint = (
  document: Readonly<AxWorkingStateDocument<any>>
): Promise<string> => axEventCanonicalDigest(document);

/** Stable digest for a tool receipt; the same function the harness mints with. */
export const axWorkingStateReceiptFingerprint = (
  call: Readonly<{
    qualifiedName: string;
    arguments: unknown;
    result: unknown;
  }>
): Promise<string> =>
  axEventCanonicalDigest({
    qualifiedName: call.qualifiedName,
    arguments: call.arguments,
    result: call.result,
  });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type AxWorkingStateProposerMode =
  /** Run the proposer program every turn. Highest cost, highest fidelity. */
  | 'every-turn'
  /** Run it only on turns that produced a receipt or an error. Default. */
  | 'on-change'
  /** Never run it: the actor emits the patch itself. */
  | 'actor';

/** The proposer's declared I/O. Both the built-in program and a host override. */
export type AxWorkingStateProposerInput = Readonly<{
  /** Rendered field contract derived from `stateSignature`. */
  stateContract: string;
  /** Rendered writable document: goals + facts. */
  workingState: string;
  /** Rendered READ-ONLY harness region: receipt roster + parked ledger. */
  receiptRoster: string;
  action: string;
  observation: string;
  isError: boolean;
  turn: number;
}>;

export type AxWorkingStateProposal = Readonly<{
  /** Untrusted document; goes through `axValidateStatePatch` before anything. */
  statePatch: unknown;
  rationale?: string;
}>;

/** Host override for the proposer. Omitted ⇒ the built-in ax program. */
export type AxWorkingStateProposer = (
  input: AxWorkingStateProposerInput,
  signal?: AbortSignal
) => Promise<AxWorkingStateProposal>;

export interface AxWorkingStateConfig<S = Record<string, unknown>> {
  /**
   * Declares the host's fact space. Either a full signature
   * (`'task:string -> orderId:string, shipped:boolean'`) or a bare output-field
   * list (`'orderId:string, shipped:boolean'`), which is normalized to
   * `'state:string -> <list>'`. Only the OUTPUT fields declare the fact space;
   * they are the legal root segments for a `fact_write`.
   */
  stateSignature: string | AxSignature;
  /**
   * Maximum pointer depth below a declared fact root, default 4. Writes deeper
   * than this park `undeclared_fact_path`. Nested shape below the root is NOT
   * otherwise validated — a host wanting tighter bounds enforces it in the
   * checker.
   */
  factDepthLimit?: number;
  /** Initial document. Host-seeded goals are the strongest configuration. */
  initial?: Readonly<Partial<AxWorkingStateDocument<S>>>;
  /** Host gate. Omitted ⇒ a permissive default that still enforces the kernel. */
  checker?: AxWorkingStateCheckerPolicy<S>;
  proposer?: AxWorkingStateProposerMode;
  /** Replaces the built-in proposer program entirely. */
  proposeWith?: AxWorkingStateProposer;
  /** Overrides the built-in proposer instruction. */
  proposerInstruction?: string;
  /** Forward options for the built-in proposer program (model, temperature…). */
  proposerOptions?: Omit<AxProgramForwardOptions<string>, 'functions'>;
  /**
   * Durable commit port. Defaults to a fresh `AxInMemoryProgramStateStore`, so
   * `compareAndSet`, the revision and the fence path ALWAYS exist.
   */
  store?: AxProgramStateStore;
  /** Store key. Defaults to `ax.workingState:<runId>`. */
  storeKey?: string;
  /** Optional delivery fence forwarded to `compareAndSet`. */
  fence?: Readonly<{ deliveryId: string; fencingToken: number }>;
  clock?: AxEventClock;
  /** Injectable per-`forward()` run-id factory. Tests inject a deterministic one. */
  runIdFactory?: () => string;
  /** Emit Gamma records. Default false. */
  trace?: boolean | Readonly<{ enabled: boolean; summaries?: boolean }>;
  onTrace?: AxWorkingStateTraceSink;
  /** Chars of runtime output shown to the proposer/checker. Default 2000. */
  maxObservationChars?: number;
  /**
   * Whether the model may add goals. Default **false** — the shipped default
   * must not be farmable. When `true`, `expectsAllowlist` is REQUIRED and
   * every model-authored goal's `expects` must be non-empty and a subset of
   * it; otherwise construction throws `AxWorkingStateSchemaError`.
   */
  allowModelAuthoredGoals?: boolean;
  /** Required when `allowModelAuthoredGoals` is true. */
  expectsAllowlist?: readonly string[];
  /**
   * Exact qualified names or `namespace.*` prefixes whose calls may mint a
   * receipt. Omitted ⇒ every receipt-eligible dispatch site.
   */
  receiptSources?: readonly string[];
  /**
   * Whether working state gates the run's report.
   * - `'observe'` (default): it does NOT. The ledger is a side document.
   * - `'interlock'`: a `final()` with pending goals is converted to
   *   `guide_agent` with harness-generated guidance, up to
   *   `maxCompletionInterlocks` times.
   */
  completionPolicy?: 'observe' | 'interlock';
  /** Interlock conversions allowed per run. Default 2. */
  maxCompletionInterlocks?: number;
  /** Max chars for the rendered writable region. Default 4000. */
  maxRenderChars?: number;
  /** Receipts shown in the roster, most recent first. Default 40. */
  maxRosterEntries?: number;
}

/** Harness-authored, enum-coded guidance. No model-supplied value ever appears. */
export type AxWorkingStateGuidanceNote = Readonly<{
  code:
    | AxWorkingStateParkReason
    | 'patch_invalid'
    | 'forbidden_path'
    | 'guard_failed';
  opKind: AxStatePatchOp['op'];
  /** Sanitized, length-bounded (128) JSON Pointer. Values are NEVER included. */
  path: string;
  goalId?: string;
  /** Only for receipt failures: the expected callables. */
  expects?: readonly string[];
}>;

export type AxWorkingStateCommitOutcome<S = Record<string, unknown>> =
  Readonly<{
    state: AxWorkingStateDocument<S>;
    revision: number;
    committed: readonly AxWorkingStateClassifiedOp[];
    parked: readonly AxWorkingStateParkedDelta[];
    outcome: 'committed' | 'partially_committed' | 'unchanged' | 'rejected';
    /** Harness-generated guidance codes the actor loop renders. Never model text. */
    guidance?: readonly AxWorkingStateGuidanceNote[];
  }>;

/** Serializable snapshot carried on `AxAgentState`. */
export type AxAgentStateWorkingState = {
  schemaVersion: number;
  revision: number;
  runId: string;
  document: AxWorkingStateDocument<any>;
  receipts: AxWorkingStateReceipt[];
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base for every typed failure in this subsystem. Sets `this.name`. */
export class AxWorkingStateError extends Error {
  public readonly code: string = 'working_state_error';
  public readonly turn?: number;

  constructor(message: string, turn?: number) {
    super(message);
    this.name = 'AxWorkingStateError';
    this.turn = turn;
  }
}

export class AxWorkingStateForbiddenPathError extends AxWorkingStateError {
  public override readonly code = 'working_state_forbidden_path';
  public readonly path: string;
  public readonly deltaClass: AxWorkingStateDeltaClass;

  constructor(
    path: string,
    deltaClass: AxWorkingStateDeltaClass,
    turn?: number
  ) {
    super(`Working state refuses a write at ${path}`, turn);
    this.name = 'AxWorkingStateForbiddenPathError';
    this.path = path;
    this.deltaClass = deltaClass;
  }
}

export class AxWorkingStateParkBudgetError extends AxWorkingStateError {
  public override readonly code = 'working_state_park_budget_exhausted';
  public readonly scope: 'goal' | 'run';
  public readonly goalId?: string;
  public readonly parked: readonly AxWorkingStateParkedDelta[];

  constructor(
    scope: 'goal' | 'run',
    parked: readonly AxWorkingStateParkedDelta[],
    goalId?: string,
    turn?: number
  ) {
    super(`Working state park budget exhausted for the ${scope}`, turn);
    this.name = 'AxWorkingStateParkBudgetError';
    this.scope = scope;
    this.goalId = goalId;
    this.parked = parked;
  }
}

export class AxWorkingStateConflictError extends AxWorkingStateError {
  public override readonly code = 'state_revision_conflict';
  public readonly expectedRevision?: number;
  public readonly storeKey: string;

  constructor(storeKey: string, expectedRevision?: number, turn?: number) {
    super(
      `Working state compare-and-set conflicted for ${storeKey} at revision ${String(expectedRevision)}`,
      turn
    );
    this.name = 'AxWorkingStateConflictError';
    this.storeKey = storeKey;
    this.expectedRevision = expectedRevision;
  }
}

export class AxWorkingStateStoreError extends AxWorkingStateError {
  public override readonly code = 'state_store_failed';
  public readonly storeKey: string;
  public readonly phase: 'load' | 'commit' | 'delete';

  constructor(
    storeKey: string,
    phase: 'load' | 'commit' | 'delete',
    cause?: unknown,
    turn?: number
  ) {
    super(
      `Working state store ${phase} failed for ${storeKey}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      turn
    );
    this.name = 'AxWorkingStateStoreError';
    this.storeKey = storeKey;
    this.phase = phase;
  }
}

export class AxWorkingStateSchemaError extends AxWorkingStateError {
  public override readonly code = 'working_state_schema_invalid';
  public readonly detail: string;

  constructor(detail: string) {
    super(`Working state configuration is invalid: ${detail}`);
    this.name = 'AxWorkingStateSchemaError';
    this.detail = detail;
  }
}

const WORKING_STATE_ERROR_CODES = new Set([
  'working_state_error',
  'working_state_forbidden_path',
  'working_state_park_budget_exhausted',
  'state_revision_conflict',
  'state_store_failed',
  'working_state_schema_invalid',
]);

/** Cross-realm structural guard — `instanceof` breaks across package copies. */
export const axIsWorkingStateError = (
  error: unknown
): error is AxWorkingStateError => {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && WORKING_STATE_ERROR_CODES.has(code);
};

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

const GOAL_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const DEFAULT_FACT_DEPTH_LIMIT = 4;
const DEFAULT_MAX_OBSERVATION_CHARS = 2_000;
const DEFAULT_MAX_RENDER_CHARS = 4_000;
const DEFAULT_MAX_ROSTER_ENTRIES = 40;
const DEFAULT_MAX_PARKS_PER_GOAL = 3;
const DEFAULT_MAX_PARKS_PER_RUN = 12;
const DEFAULT_MAX_EVIDENCE_BYTES = 4_096;
const DEFAULT_MAX_COMPLETION_INTERLOCKS = 2;
const CANONICAL_GUARD_PATH = '/<guard>';
const CANONICAL_RESERVED_PATH = '/<reserved>';
const CANONICAL_UNDECLARED_FACT_PATH = '/facts/<undeclared>';
const MAX_GOAL_TEXT_CHARS = 512;

const RESERVED_ROOTS = new Set(['schemaVersion', 'parked']);
const IMMUTABLE_GOAL_FIELDS = new Set([
  'id',
  'createdTurn',
  'updatedTurn',
  'expects',
]);

const DEFAULT_PROPOSER_INSTRUCTION =
  'You maintain a typed working state. Emit an RFC-6902 patch (add/remove/replace/test only) ' +
  'that makes the state match what the observation proves. A goal may be marked done ONLY by ' +
  'appending a receipt ref from the Receipts roster to its evidence in the same patch. ' +
  'Never invent a ref. If nothing is proven, emit [].';

const PROPOSER_SIGNATURE =
  'stateContract:string, workingState:string, receiptRoster:string, action:string, observation:string -> statePatch:json, rationale:string';

function truncate(value: string, max: number): string {
  return value.length <= max
    ? value
    : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function evidenceRefsOf(goal: AxWorkingStateGoal | undefined): string[] {
  return (goal?.evidence ?? [])
    .filter((entry) => entry?.kind === 'tool_receipt')
    .map((entry) => entry.ref);
}

function matchesReceiptSource(
  qualifiedName: string,
  sources: readonly string[] | undefined
): boolean {
  if (!sources || sources.length === 0) return true;
  return sources.some((source) => {
    if (source.endsWith('.*')) {
      return qualifiedName.startsWith(source.slice(0, -1));
    }
    return source === qualifiedName;
  });
}

/**
 * Normalize `stateSignature` to a signature and read its declared fact roots.
 * A bare output-field list is prefixed with `state:string -> `.
 */
function resolveStateSignature(stateSignature: string | AxSignature): {
  signature: AxSignature;
  roots: string[];
} {
  const signature =
    typeof stateSignature === 'string'
      ? AxSignature.create(
          stateSignature.includes('->')
            ? stateSignature
            : `state:string -> ${stateSignature}`
        )
      : stateSignature;
  const roots = signature.getOutputFields().map((field) => field.name);
  return { signature, roots };
}

function renderStateContract(signature: AxSignature): string {
  const lines = signature.getOutputFields().map((field) => {
    const type = field.type?.name ?? 'string';
    const array = field.type?.isArray ? '[]' : '';
    const description = field.description ? ` — ${field.description}` : '';
    return `- facts.${field.name}: ${type}${array}${description}`;
  });
  return [
    'Declared fact fields (the only legal roots under /facts):',
    ...lines,
    'Goal statuses: pending | done | blocked.',
    'Legal paths: /goals/<id>, /goals/<id>/status, /goals/<id>/goal, /goals/<id>/blocker, /goals/<id>/evidence/-, /facts/<field>/...',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

type ClassifierDeps = Readonly<{
  believed: AxWorkingStateDocument<any>;
  receipts: readonly AxWorkingStateReceipt[];
  factRoots: ReadonlySet<string>;
  factDepthLimit: number;
  allowModelAuthoredGoals: boolean;
  expectsAllowlist: readonly string[];
}>;

/** A classification before its harness-authored pointer is derived. */
type ClassifiedShape = Omit<AxWorkingStateClassifiedOp, 'canonicalPath'>;

function forbid(
  op: AxStatePatchOp,
  reason: AxWorkingStateClassifiedOp['kernelReason'],
  goalId?: string
): ClassifiedShape {
  return {
    op,
    class: 'reserved',
    kernelVerdict: 'forbidden',
    kernelReason: reason,
    ...(goalId ? { goalId } : {}),
  };
}

/**
 * Derive the pointer the harness is willing to show, from the CLASSIFICATION
 * rather than from the model's path string. Every segment is harness- or
 * host-owned: a literal, a `GOAL_ID_PATTERN`-validated goal id, one of the
 * enumerated goal fields, a fact root declared by `stateSignature`, or a
 * `<...>` placeholder. Nothing the model authored survives.
 */
function canonicalPathFor(
  entry: ClassifiedShape,
  deps: ClassifierDeps
): string {
  if (entry.class === 'guard') return CANONICAL_GUARD_PATH;
  const segments = parseStatePatchPointer(entry.op.path) ?? [];
  if (entry.class === 'fact_write') {
    const root = segments[1];
    return entry.kernelVerdict === 'admissible' &&
      root !== undefined &&
      deps.factRoots.has(root)
      ? `/facts/${root}`
      : CANONICAL_UNDECLARED_FACT_PATH;
  }
  const goalId =
    entry.goalId !== undefined && GOAL_ID_PATTERN.test(entry.goalId)
      ? entry.goalId
      : undefined;
  if (goalId === undefined) return CANONICAL_RESERVED_PATH;
  switch (entry.class) {
    case 'goal_add':
    case 'goal_remove':
      return `/goals/${goalId}`;
    case 'goal_complete':
    case 'goal_block':
    case 'goal_retract':
      return `/goals/${goalId}/status`;
    case 'goal_edit': {
      const field = segments[2];
      return field === 'goal' || field === 'blocker'
        ? `/goals/${goalId}/${field}`
        : `/goals/${goalId}/<reserved>`;
    }
    case 'evidence_append':
      return `/goals/${goalId}/evidence/-`;
    default:
      return `/goals/${goalId}/<reserved>`;
  }
}

/**
 * Classify one op against the CLOSED delta table and attach its harness-owned
 * pointer. Anything no row matches is `forbidden` — the table is closed, not
 * open, so an unrecognized path shape can never be silently admitted.
 */
function classifyOp(
  op: AxStatePatchOp,
  deps: ClassifierDeps,
  citedRefsByGoal: ReadonlyMap<string, readonly string[]>
): AxWorkingStateClassifiedOp {
  const shape = classifyOpShape(op, deps, citedRefsByGoal);
  return { ...shape, canonicalPath: canonicalPathFor(shape, deps) };
}

function classifyOpShape(
  op: AxStatePatchOp,
  deps: ClassifierDeps,
  citedRefsByGoal: ReadonlyMap<string, readonly string[]>
): ClassifiedShape {
  // `test` is a guard: always admissible, never checker-visible, never parked.
  if (op.op === 'test') {
    return { op, class: 'guard', kernelVerdict: 'admissible' };
  }

  const segments = parseStatePatchPointer(op.path);
  if (!segments || segments.length === 0) {
    return forbid(op, 'reserved_path');
  }

  const [root, ...rest] = segments as [string, ...string[]];

  if (RESERVED_ROOTS.has(root)) return forbid(op, 'reserved_path');

  // Wholesale `/goals` or `/facts` would rewrite every id, createdTurn and
  // expects in one op no other row classifies.
  if ((root === 'goals' || root === 'facts') && rest.length === 0) {
    return forbid(op, 'reserved_path');
  }

  if (root === 'facts') {
    const [factRoot, ...deeper] = rest as [string, ...string[]];
    if (!deps.factRoots.has(factRoot) || deeper.length > deps.factDepthLimit) {
      return {
        op,
        class: 'fact_write',
        kernelVerdict: 'park',
        kernelReason: 'undeclared_fact_path',
      };
    }
    return { op, class: 'fact_write', kernelVerdict: 'admissible' };
  }

  if (root !== 'goals') return forbid(op, 'unclassified');

  const goalId = rest[0]!;
  if (!GOAL_ID_PATTERN.test(goalId)) return forbid(op, 'unclassified');
  const tail = rest.slice(1);
  const believedGoal = deps.believed.goals[goalId];

  // `/goals/<id>` — add or remove the whole goal.
  if (tail.length === 0) {
    if (op.op === 'add') {
      const value = (op as { value: unknown }).value;
      const status = isRecord(value) ? value.status : undefined;
      const evidence = isRecord(value) ? value.evidence : undefined;
      const declaredId = isRecord(value) ? value.id : undefined;
      // Adding an already-done goal is the single most attractive forgery.
      if (
        status !== 'pending' ||
        (Array.isArray(evidence) && evidence.length > 0)
      ) {
        return forbid(op, 'immutable_field', goalId);
      }
      if (believedGoal !== undefined || declaredId !== goalId) {
        return forbid(op, 'unclassified', goalId);
      }
      if (!deps.allowModelAuthoredGoals) {
        return {
          op,
          class: 'goal_add',
          goalId,
          kernelVerdict: 'park',
          kernelReason: 'model_goals_disabled',
        };
      }
      const expects = isRecord(value) ? value.expects : undefined;
      const expectsList = Array.isArray(expects)
        ? (expects as unknown[]).filter(
            (entry): entry is string => typeof entry === 'string'
          )
        : [];
      if (
        expectsList.length === 0 ||
        !expectsList.every((entry) => deps.expectsAllowlist.includes(entry))
      ) {
        return {
          op,
          class: 'goal_add',
          goalId,
          kernelVerdict: 'park',
          kernelReason: 'expects_not_allowed',
        };
      }
      return { op, class: 'goal_add', goalId, kernelVerdict: 'admissible' };
    }
    if (op.op === 'remove') {
      // A completed goal is part of the audit record.
      if (believedGoal?.status === 'done') {
        return forbid(op, 'immutable_field', goalId);
      }
      return { op, class: 'goal_remove', goalId, kernelVerdict: 'admissible' };
    }
    return forbid(op, 'unclassified', goalId);
  }

  const field = tail[0]!;
  if (IMMUTABLE_GOAL_FIELDS.has(field)) {
    return forbid(op, 'immutable_field', goalId);
  }

  if (field === 'status' && tail.length === 1 && op.op === 'replace') {
    const next = (op as { value: unknown }).value;
    if (next === 'pending') {
      // Retraction is safe and must never be harder than assertion.
      return { op, class: 'goal_retract', goalId, kernelVerdict: 'admissible' };
    }
    if (next === 'blocked') {
      return { op, class: 'goal_block', goalId, kernelVerdict: 'admissible' };
    }
    if (next !== 'done') return forbid(op, 'unclassified', goalId);

    const cited = new Set<string>([
      ...evidenceRefsOf(believedGoal),
      ...(citedRefsByGoal.get(goalId) ?? []),
    ]);
    if (cited.size === 0) {
      return {
        op,
        class: 'goal_complete',
        goalId,
        kernelVerdict: 'park',
        kernelReason: 'no_supporting_receipt',
      };
    }
    const known = deps.receipts.filter((receipt) => cited.has(receipt.ref));
    if (known.length !== cited.size) {
      return {
        op,
        class: 'goal_complete',
        goalId,
        kernelVerdict: 'park',
        kernelReason: 'unknown_receipt_ref',
      };
    }
    const expects = believedGoal?.expects ?? [];
    if (
      expects.length > 0 &&
      !known.some((receipt) => expects.includes(receipt.qualifiedName))
    ) {
      return {
        op,
        class: 'goal_complete',
        goalId,
        kernelVerdict: 'park',
        kernelReason: 'receipt_not_expected',
      };
    }
    return { op, class: 'goal_complete', goalId, kernelVerdict: 'admissible' };
  }

  if (
    (field === 'blocker' || field === 'goal') &&
    tail.length === 1 &&
    (op.op === 'add' || op.op === 'replace')
  ) {
    const value = (op as { value: unknown }).value;
    if (typeof value !== 'string' || value.length > MAX_GOAL_TEXT_CHARS) {
      return forbid(op, 'unclassified', goalId);
    }
    return { op, class: 'goal_edit', goalId, kernelVerdict: 'admissible' };
  }

  if (
    field === 'evidence' &&
    tail.length === 2 &&
    tail[1] === '-' &&
    op.op === 'add'
  ) {
    const value = (op as { value: unknown }).value;
    const ref = isRecord(value) ? value.ref : undefined;
    const kind = isRecord(value) ? value.kind : undefined;
    if (
      kind !== 'tool_receipt' ||
      typeof ref !== 'string' ||
      !deps.receipts.some((receipt) => receipt.ref === ref)
    ) {
      return {
        op,
        class: 'evidence_append',
        goalId,
        kernelVerdict: 'park',
        kernelReason: 'unknown_receipt_ref',
      };
    }
    return {
      op,
      class: 'evidence_append',
      goalId,
      kernelVerdict: 'admissible',
    };
  }

  // Catch-all: the table is closed.
  return forbid(op, 'unclassified', goalId);
}

/**
 * Classify a whole patch against the believed document. Runs before any
 * application, so a `goal_complete` can be supported by an `evidence_append`
 * appearing LATER in the same patch.
 */
function classifyPatch(
  patch: AxStatePatch,
  deps: ClassifierDeps
): AxWorkingStateClassifiedOp[] {
  const citedRefsByGoal = new Map<string, string[]>();
  for (const op of patch) {
    if (op.op !== 'add') continue;
    const segments = parseStatePatchPointer(op.path);
    if (
      !segments ||
      segments.length !== 4 ||
      segments[0] !== 'goals' ||
      segments[2] !== 'evidence' ||
      segments[3] !== '-'
    ) {
      continue;
    }
    const value = (op as { value: unknown }).value;
    if (!isRecord(value) || typeof value.ref !== 'string') continue;
    const goalId = segments[1]!;
    const list = citedRefsByGoal.get(goalId) ?? [];
    list.push(value.ref);
    citedRefsByGoal.set(goalId, list);
  }

  // A goal_block is admissible only when the same patch also sets a non-empty
  // blocker: "blocked" is a claim that needs content.
  const blockersSet = new Set<string>();
  for (const op of patch) {
    if (op.op !== 'add' && op.op !== 'replace') continue;
    const segments = parseStatePatchPointer(op.path);
    if (
      !segments ||
      segments.length !== 3 ||
      segments[0] !== 'goals' ||
      segments[2] !== 'blocker'
    ) {
      continue;
    }
    const value = (op as { value: unknown }).value;
    if (typeof value === 'string' && value.trim().length > 0) {
      blockersSet.add(segments[1]!);
    }
  }

  return patch.map((op) => {
    const classified = classifyOp(op, deps, citedRefsByGoal);
    if (
      classified.class === 'goal_block' &&
      classified.kernelVerdict === 'admissible' &&
      !blockersSet.has(classified.goalId!)
    ) {
      return {
        ...classified,
        kernelVerdict: 'park',
        kernelReason: 'blocker_missing',
      } satisfies AxWorkingStateClassifiedOp;
    }
    return classified;
  });
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

type ResolvedConfig<S> = Readonly<{
  signature: AxSignature;
  stateContract: string;
  factRoots: ReadonlySet<string>;
  factDepthLimit: number;
  checker?: AxWorkingStateCheckerPolicy<S>;
  proposerMode: AxWorkingStateProposerMode;
  proposeWith?: AxWorkingStateProposer;
  proposerInstruction: string;
  proposerOptions?: Omit<AxProgramForwardOptions<string>, 'functions'>;
  store: AxProgramStateStore;
  storeKey: string;
  fence?: Readonly<{ deliveryId: string; fencingToken: number }>;
  clock: AxEventClock;
  traceEnabled: boolean;
  traceSummaries: boolean;
  onTrace?: AxWorkingStateTraceSink;
  maxObservationChars: number;
  allowModelAuthoredGoals: boolean;
  expectsAllowlist: readonly string[];
  receiptSources?: readonly string[];
  completionPolicy: 'observe' | 'interlock';
  maxCompletionInterlocks: number;
  maxRenderChars: number;
  maxRosterEntries: number;
  maxParksPerGoal: number;
  maxParksPerRun: number;
  maxEvidenceBytes: number;
}>;

export type AxWorkingStateCommitContext = Readonly<{
  action: string;
  observation: string;
  turn: number;
  isError: boolean;
  /** Skill ids in scope this turn; recorded on the trace. */
  selectedSkills?: readonly string[];
  /** Qualified callables the turn invoked; recorded on the trace. */
  calls?: readonly string[];
  /** False when a call-time skill injection suppressed execution. */
  executed?: boolean;
  /** Receipt refs minted this turn, in mint order. */
  receiptRefs?: readonly string[];
  /** How the proposal arrived. Defaults to `'emitted'`. */
  proposal?: 'none' | 'emitted' | 'invalid' | 'error';
  /** Optional bounded summary, retained only under `trace.summaries`. */
  summary?: string;
  /**
   * Resolved once, immediately before the Gamma step is built, so the
   * completion interlock decides against the COMMITTED ledger rather than the
   * believed one — a patch in this same turn may have just completed the last
   * pending goal. Returning `'converted'` consumes one budget slot.
   */
  resolveCompletionInterlock?: () => 'converted' | 'exhausted' | undefined;
}>;

/**
 * The per-run kernel. Constructed by the actor loop; hosts normally reach it
 * through `agent.getWorkingState()` rather than building one.
 */
export class AxWorkingState<S = Record<string, unknown>> {
  private readonly config: ResolvedConfig<S>;
  private readonly runIdValue: string;
  private readonly stage: AxAgentContextStage;
  private readonly ai?: AxAIService;

  private document: AxWorkingStateDocument<S>;
  private revision: number | undefined;
  private readonly receiptList: AxWorkingStateReceipt[] = [];
  private readonly receiptByFingerprint = new Map<string, number>();
  private readonly parkCountByGoal = new Map<string, number>();
  private parkCountForRun = 0;
  private checksUsed = 0;
  private checkerTokens = 0;
  private checkerCostUSD = 0;
  private checkerWallTimeMs = 0;
  private interlocksUsed = 0;
  private proposerProgram?: AxGen<any, any>;

  private constructor(args: {
    config: ResolvedConfig<S>;
    runId: string;
    stage: AxAgentContextStage;
    ai?: AxAIService;
    document: AxWorkingStateDocument<S>;
    revision: number | undefined;
    receipts: readonly AxWorkingStateReceipt[];
  }) {
    this.config = args.config;
    this.runIdValue = args.runId;
    this.stage = args.stage;
    this.ai = args.ai;
    this.document = args.document;
    this.revision = args.revision;
    for (const receipt of args.receipts) {
      this.receiptList.push(receipt);
      this.receiptByFingerprint.set(
        receipt.fingerprint,
        this.receiptList.length - 1
      );
    }
  }

  /** @internal Constructed by `axWorkingState`. */
  static async open<S>(
    config: Readonly<AxWorkingStateConfig<S>>,
    deps: Readonly<{
      runId: string;
      stage: AxAgentContextStage;
      ai?: AxAIService;
    }>,
    restored?: Readonly<AxAgentStateWorkingState>
  ): Promise<AxWorkingState<S>> {
    const resolved = resolveWorkingStateConfig(config, deps.runId);
    let document = seedDocument(config, resolved);
    let revision: number | undefined;
    let receipts: readonly AxWorkingStateReceipt[] = [];

    if (restored) {
      document = restored.document as AxWorkingStateDocument<S>;
      receipts = restored.receipts;
    }

    let loaded: Awaited<ReturnType<AxProgramStateStore['load']>>;
    try {
      loaded = await resolved.store.load(resolved.storeKey);
    } catch (err) {
      throw new AxWorkingStateStoreError(resolved.storeKey, 'load', err);
    }
    if (loaded) {
      revision = loaded.revision;
      if (!restored && isRecord(loaded.state)) {
        document = loaded.state as AxWorkingStateDocument<S>;
      }
    }

    return new AxWorkingState<S>({
      config: resolved,
      runId: deps.runId,
      stage: deps.stage,
      ai: deps.ai,
      document,
      revision,
      receipts,
    });
  }

  /** Per-`forward()` run id used for the store key and every Gamma record. */
  public runId(): string {
    return this.runIdValue;
  }

  /** Committed document. Never a proposal. */
  public current(): Readonly<AxWorkingStateDocument<S>> {
    return this.document;
  }

  public currentRevision(): number {
    return this.revision ?? 0;
  }

  /** Every receipt minted this run, oldest first. */
  public receipts(): readonly AxWorkingStateReceipt[] {
    return this.receiptList;
  }

  /** How many interlock conversions this run has spent. */
  public completionInterlocksUsed(): number {
    return this.interlocksUsed;
  }

  public completionPolicy(): 'observe' | 'interlock' {
    return this.config.completionPolicy;
  }

  public maxCompletionInterlocks(): number {
    return this.config.maxCompletionInterlocks;
  }

  /** True when `receiptSources` (if configured) admits this callable. */
  public receiptEligibleSource(qualifiedName: string): boolean {
    return matchesReceiptSource(qualifiedName, this.config.receiptSources);
  }

  public proposerMode(): AxWorkingStateProposerMode {
    return this.config.proposerMode;
  }

  /** The injected clock's current time. No `Date.now()` anywhere downstream. */
  public now(): number {
    return this.config.clock.now();
  }

  public maxObservationChars(): number {
    return this.config.maxObservationChars;
  }

  public stateContract(): string {
    return this.config.stateContract;
  }

  /**
   * Harness-only: mint a receipt from an observed successful call. Deduped by
   * fingerprint — a repeat observation of an identical call increments
   * `observations` and returns the existing receipt.
   */
  public async recordReceipt(
    call: Readonly<{
      qualifiedName: string;
      arguments: unknown;
      result: unknown;
      turn: number;
      at: number;
    }>
  ): Promise<AxWorkingStateReceipt> {
    const fingerprint = await axWorkingStateReceiptFingerprint(call);
    const existingIndex = this.receiptByFingerprint.get(fingerprint);
    if (existingIndex !== undefined) {
      const existing = this.receiptList[existingIndex]!;
      const updated: AxWorkingStateReceipt = {
        ...existing,
        observations: existing.observations + 1,
      };
      this.receiptList[existingIndex] = updated;
      return updated;
    }
    const receipt: AxWorkingStateReceipt = {
      kind: 'tool_receipt',
      ref: `r${this.receiptList.length + 1}`,
      qualifiedName: call.qualifiedName,
      turn: call.turn,
      fingerprint,
      at: call.at,
      observations: 1,
    };
    this.receiptList.push(receipt);
    this.receiptByFingerprint.set(fingerprint, this.receiptList.length - 1);
    return receipt;
  }

  /** Classify → check → commit → park. The one mutation entry point. */
  public async commit(
    patch: AxStatePatch,
    context: AxWorkingStateCommitContext,
    signal?: AbortSignal
  ): Promise<AxWorkingStateCommitOutcome<S>> {
    const believed = this.document;
    const guidance: AxWorkingStateGuidanceNote[] = [];
    const parked: AxWorkingStateParkedDelta[] = [];

    const classified = classifyPatch(patch, {
      believed,
      receipts: this.receiptList,
      factRoots: this.config.factRoots,
      factDepthLimit: this.config.factDepthLimit,
      allowModelAuthoredGoals: this.config.allowModelAuthoredGoals,
      expectsAllowlist: this.config.expectsAllowlist,
    });

    // A forbidden op short-circuits the entire patch.
    const forbidden = classified.find(
      (entry) => entry.kernelVerdict === 'forbidden'
    );
    if (forbidden) {
      guidance.push(this.guidanceNote('forbidden_path', forbidden));
      const outcome = await this.finish({
        believed,
        context,
        classified: [],
        parked,
        guidance,
        outcome: 'rejected',
        proposedDigest: undefined,
        checkerVerdict: { status: 'skipped' },
        forbiddenError: new AxWorkingStateForbiddenPathError(
          forbidden.op.path,
          forbidden.class,
          context.turn
        ),
      });
      return outcome;
    }

    for (const entry of classified) {
      if (entry.kernelVerdict !== 'park') continue;
      parked.push(
        this.buildParkedDelta(
          entry,
          entry.kernelReason as AxWorkingStateParkReason,
          context
        )
      );
      guidance.push(
        this.guidanceNote(entry.kernelReason as AxWorkingStateParkReason, entry)
      );
    }

    const guards = classified.filter((entry) => entry.class === 'guard');
    let survivors = classified.filter(
      (entry) => entry.kernelVerdict === 'admissible'
    );

    if (survivors.length === guards.length && guards.length === 0) {
      const finished = await this.finish({
        believed,
        context,
        classified: [],
        parked,
        guidance,
        outcome: parked.length > 0 ? 'rejected' : 'unchanged',
        proposedDigest: undefined,
        checkerVerdict: { status: 'skipped' },
      });
      return finished;
    }

    // Pre-apply: guards run with the admissible ops so a guard failure is
    // decided against the same document the checker will see.
    const preApplied = axApplyStatePatch(
      believed,
      survivors.map((entry) => entry.op)
    );
    if (preApplied.status === 'rejected') {
      const offending = survivors[preApplied.index];
      guidance.push(
        this.guidanceNote(
          preApplied.code === 'test_failed' ? 'guard_failed' : 'patch_invalid',
          offending
        )
      );
      return this.finish({
        believed,
        context,
        classified: [],
        parked,
        guidance,
        outcome: 'rejected',
        proposedDigest: undefined,
        checkerVerdict: { status: 'skipped' },
      });
    }

    const proposedState = preApplied.value as AxWorkingStateDocument<S>;
    const proposedDigest = await axWorkingStateFingerprint(proposedState);

    const checkable = survivors.filter((entry) => entry.class !== 'guard');
    let checkerVerdict: AxWorkingStateTraceStep['checkerVerdict'] = {
      status: 'skipped',
    };

    if (checkable.length > 0 && this.config.checker) {
      const policy = this.config.checker;
      const verdict = await this.runChecker(policy, {
        believedState: believed,
        proposedState,
        deltas: checkable,
        action: context.action,
        observation: truncate(
          context.observation,
          this.config.maxObservationChars
        ),
        turn: context.turn,
        signal,
      });
      if (verdict.kind === 'pass') {
        checkerVerdict = { status: 'pass', policyId: policy.id };
      } else if (verdict.kind === 'fail') {
        checkerVerdict = {
          status: 'fail',
          policyId: policy.id,
          code: verdict.code,
        };
        for (const entry of checkable) {
          parked.push(
            this.buildParkedDelta(entry, 'checker_failed', context, {
              failureCode: verdict.code,
              evidence: verdict.evidence,
            })
          );
          guidance.push(this.guidanceNote('checker_failed', entry));
        }
        survivors = guards;
      } else {
        checkerVerdict = {
          status: 'error',
          policyId: policy.id,
          code: verdict.code,
        };
        for (const entry of checkable) {
          parked.push(this.buildParkedDelta(entry, verdict.code, context));
          guidance.push(this.guidanceNote(verdict.code, entry));
        }
        survivors = guards;
      }
    }

    const committable = survivors.filter((entry) => entry.class !== 'guard');
    if (committable.length === 0) {
      return this.finish({
        believed,
        context,
        classified: [],
        parked,
        guidance,
        outcome: parked.length > 0 ? 'rejected' : 'unchanged',
        proposedDigest,
        checkerVerdict,
      });
    }

    const committed = await this.applyAndStore(
      survivors,
      context,
      parked,
      guidance
    );

    return this.finish({
      believed,
      context,
      classified: committed,
      parked,
      guidance,
      outcome:
        committed.length === 0
          ? 'rejected'
          : parked.length > 0
            ? 'partially_committed'
            : 'committed',
      proposedDigest,
      checkerVerdict,
    });
  }

  /**
   * Record a turn whose proposal never reached classification: an invalid
   * patch document, a proposer error, or no proposal at all.
   */
  public async recordNonCommit(
    context: AxWorkingStateCommitContext,
    reason: 'patch_invalid' | 'proposer_error' | 'none'
  ): Promise<AxWorkingStateCommitOutcome<S>> {
    const guidance: AxWorkingStateGuidanceNote[] =
      reason === 'patch_invalid'
        ? [
            {
              code: 'patch_invalid',
              opKind: 'add',
              path: '/',
            },
          ]
        : [];
    return this.finish({
      believed: this.document,
      context: {
        ...context,
        proposal:
          reason === 'patch_invalid'
            ? 'invalid'
            : reason === 'proposer_error'
              ? 'error'
              : 'none',
      },
      classified: [],
      parked: [],
      guidance,
      outcome: reason === 'patch_invalid' ? 'rejected' : 'unchanged',
      proposedDigest: undefined,
      checkerVerdict: { status: 'skipped' },
    });
  }

  /**
   * Consume one completion-interlock budget slot. Returns `'converted'` when
   * the caller should convert a `final` payload into `guide_agent`, and
   * `'exhausted'` when the budget is spent and the `final` must stand.
   */
  public consumeCompletionInterlock(): 'converted' | 'exhausted' {
    if (this.interlocksUsed >= this.config.maxCompletionInterlocks) {
      return 'exhausted';
    }
    this.interlocksUsed += 1;
    return 'converted';
  }

  /** Goal ids still `pending`, sorted by creation then id. */
  public pendingGoalIds(): readonly string[] {
    return Object.values(this.document.goals)
      .filter((goal) => goal.status === 'pending')
      .sort((a, b) => a.createdTurn - b.createdTurn || a.id.localeCompare(b.id))
      .map((goal) => goal.id);
  }

  /** Run the configured proposer for one turn. */
  public async propose(
    input: AxWorkingStateProposerInput,
    signal?: AbortSignal
  ): Promise<AxWorkingStateProposal> {
    if (this.config.proposeWith) {
      return this.config.proposeWith(input, signal);
    }
    if (!this.ai) {
      throw new AxWorkingStateSchemaError(
        'the built-in proposer requires an AI service; pass `proposeWith` instead'
      );
    }
    if (!this.proposerProgram) {
      this.proposerProgram = ax(PROPOSER_SIGNATURE);
      this.proposerProgram.setDescription(this.config.proposerInstruction);
    }
    // The proposer is a second long-lived wait inside the turn, so its signal
    // is composed with `mergeAbortSignals` and the composed listener is
    // removed on settle.
    const controller = new AbortController();
    const composed = mergeAbortSignals(signal, controller.signal);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = (await this.proposerProgram.forward(
        this.ai,
        {
          stateContract: input.stateContract,
          workingState: input.workingState,
          receiptRoster: input.receiptRoster,
          action: input.action,
          observation: input.observation,
        },
        {
          ...(this.config.proposerOptions ?? {}),
          ...(composed ? { abortSignal: composed } : {}),
        } as AxProgramForwardOptions<string>
      )) as { statePatch?: unknown; rationale?: unknown };
      return {
        statePatch: result.statePatch,
        ...(typeof result.rationale === 'string'
          ? { rationale: result.rationale }
          : {}),
      };
    } finally {
      controller.abort();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** The model-writable region: state contract + goals + facts. Bounded. */
  public renderWritable(maxChars?: number): string {
    const limit = maxChars ?? this.config.maxRenderChars;
    const goals = Object.values(this.document.goals).sort(
      (a, b) => a.createdTurn - b.createdTurn || a.id.localeCompare(b.id)
    );
    // Ids and statuses are printed for EVERY goal before any text is
    // truncated, so truncation can never hide a goal.
    const header = [this.config.stateContract, '', 'Goals:'];
    const goalLines = goals.map((goal) => {
      const refs = evidenceRefsOf(goal);
      const evidence = refs.length > 0 ? ` evidence=[${refs.join(',')}]` : '';
      const expects =
        goal.expects && goal.expects.length > 0
          ? ` expects=[${goal.expects.join(',')}]`
          : '';
      const blocker = goal.blocker
        ? ` blocker=${truncate(goal.blocker, 120)}`
        : '';
      return `- ${goal.id} [${goal.status}]${evidence}${expects}${blocker}`;
    });
    const goalText = goals.map(
      (goal, index) => `${goalLines[index]}\n    ${truncate(goal.goal, 200)}`
    );
    const factsBlock = [
      '',
      'Facts:',
      axEventCanonicalJson(this.document.facts),
    ];

    const full = [...header, ...goalText, ...factsBlock].join('\n');
    if (full.length <= limit) return full;
    // Fall back to the id/status-only rendering, which is what the budget must
    // always fit.
    const compact = [...header, ...goalLines, ...factsBlock].join('\n');
    return truncate(compact, limit);
  }

  /** The read-only harness region: receipt roster + parked ledger. Bounded. */
  public renderReadOnly(maxChars?: number): string {
    const limit = maxChars ?? this.config.maxRenderChars;
    const roster = this.receiptList
      .slice(-this.config.maxRosterEntries)
      .reverse()
      .map(
        (receipt) =>
          `${receipt.ref}  ${receipt.qualifiedName}  turn ${receipt.turn}`
      );
    const parked = this.document.parked.map(
      (entry) =>
        `${entry.op.op} ${entry.op.path} -> ${entry.reason} (turn ${entry.parkedTurn})`
    );
    const lines = [
      'Receipts (harness-owned, read-only). Cite a ref to support a goal:',
      ...(roster.length > 0 ? roster : ['(none yet)']),
      '',
      'Parked deltas (recorded, not applied):',
      ...(parked.length > 0 ? parked : ['(none)']),
    ];
    return truncate(lines.join('\n'), limit);
  }

  /** Serializable snapshot for `AxAgentState`. */
  public snapshot(): AxAgentStateWorkingState {
    return {
      schemaVersion: this.document.schemaVersion,
      revision: this.currentRevision(),
      runId: this.runIdValue,
      document: structuredClone(this.document) as AxWorkingStateDocument<any>,
      receipts: this.receiptList.map((receipt) => ({ ...receipt })),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private guidanceNote(
    code: AxWorkingStateGuidanceNote['code'],
    entry: AxWorkingStateClassifiedOp | undefined
  ): AxWorkingStateGuidanceNote {
    // Only harness-owned values reach the trusted guidance channel: an enum
    // code, the op KIND, a sanitized bounded pointer and the goal id. The
    // model's `value` never appears, because `guidanceLog` is the highest
    // authority prompt region.
    const path = entry ? entry.canonicalPath : '/';
    const goalId =
      entry?.goalId && GOAL_ID_PATTERN.test(entry.goalId)
        ? entry.goalId
        : undefined;
    const expects =
      goalId &&
      (code === 'no_supporting_receipt' || code === 'receipt_not_expected')
        ? this.document.goals[goalId]?.expects
        : undefined;
    return {
      code,
      opKind: entry?.op.op ?? 'add',
      path,
      ...(goalId ? { goalId } : {}),
      ...(expects && expects.length > 0 ? { expects } : {}),
    };
  }

  private buildParkedDelta(
    entry: AxWorkingStateClassifiedOp,
    reason: AxWorkingStateParkReason,
    context: AxWorkingStateCommitContext,
    extra?: Readonly<{ failureCode?: string; evidence?: unknown }>
  ): AxWorkingStateParkedDelta {
    const attempt = entry.goalId
      ? (this.parkCountByGoal.get(entry.goalId) ?? 0) + 1
      : 1;
    return {
      // The model's `value` is deliberately not retained.
      op: { op: entry.op.op, path: entry.canonicalPath },
      reason,
      ...(extra?.failureCode ? { failureCode: extra.failureCode } : {}),
      ...(extra?.evidence !== undefined
        ? {
            evidence: boundEvidence(
              extra.evidence,
              this.config.maxEvidenceBytes
            ),
          }
        : {}),
      parkedTurn: context.turn,
      parkedAt: this.config.clock.now(),
      attempt,
    };
  }

  private async runChecker(
    policy: AxWorkingStateCheckerPolicy<S>,
    partial: Readonly<{
      believedState: AxWorkingStateDocument<S>;
      proposedState: AxWorkingStateDocument<S>;
      deltas: readonly AxWorkingStateClassifiedOp[];
      action: string;
      observation: string;
      turn: number;
      signal?: AbortSignal;
    }>
  ): Promise<
    | { kind: 'pass' }
    | { kind: 'fail'; code: string; evidence?: unknown }
    | { kind: 'error'; code: 'checker_error' | 'checker_timeout' }
  > {
    const maxChecks = policy.maxChecksPerRun;
    if (maxChecks !== undefined && this.checksUsed >= maxChecks) {
      return { kind: 'error', code: 'checker_error' };
    }
    if (
      policy.maxWallTimeMs !== undefined &&
      this.checkerWallTimeMs >= policy.maxWallTimeMs
    ) {
      return { kind: 'error', code: 'checker_error' };
    }
    if (
      policy.maxTokens !== undefined &&
      this.checkerTokens >= policy.maxTokens
    ) {
      return { kind: 'error', code: 'checker_error' };
    }
    if (
      policy.maxCostUSD !== undefined &&
      this.checkerCostUSD >= policy.maxCostUSD
    ) {
      return { kind: 'error', code: 'checker_error' };
    }
    if (partial.signal?.aborted === true) {
      // Fail closed: a run that is already aborted never gets a verdict.
      return { kind: 'error', code: 'checker_error' };
    }
    this.checksUsed += 1;

    const timeoutController = new AbortController();
    const checkSignal =
      mergeAbortSignals(partial.signal, timeoutController.signal) ??
      timeoutController.signal;
    const sleepCancel = new AbortController();
    const onRunAbort = () => {
      timeoutController.abort(partial.signal?.reason);
      sleepCancel.abort();
    };
    partial.signal?.addEventListener('abort', onRunAbort, { once: true });

    const startedAt = this.config.clock.now();
    const context: AxWorkingStateCheckContext<S> = {
      believedState: partial.believedState,
      proposedState: partial.proposedState,
      deltas: partial.deltas,
      receipts: this.receiptList,
      action: partial.action,
      observation: partial.observation,
      turn: partial.turn,
      stage: this.stage,
      signal: checkSignal,
    };

    try {
      const racers: Promise<
        | { kind: 'settled'; value: AxEventVerifierResult }
        | { kind: 'threw'; error: unknown }
        | { kind: 'timeout' }
      >[] = [];
      // The deadline is registered BEFORE the check starts, so the elapsed
      // window covers the whole call and a manual-clock test can advance time
      // from inside the checker deterministically.
      if (policy.timeoutMs !== undefined) {
        racers.push(
          this.config.clock.sleep(policy.timeoutMs, sleepCancel.signal).then(
            () => ({ kind: 'timeout' as const }),
            // A cancelled sleep must never win the race.
            () => new Promise<never>(() => {})
          )
        );
      }
      racers.push(
        Promise.resolve(policy.check(context)).then(
          (value) => ({ kind: 'settled' as const, value }),
          (error) => ({ kind: 'threw' as const, error })
        )
      );
      const outcome = await Promise.race(racers);
      this.checkerWallTimeMs += Math.max(
        0,
        this.config.clock.now() - startedAt
      );

      if (outcome.kind === 'timeout') {
        timeoutController.abort(new Error('working state checker timed out'));
        return { kind: 'error', code: 'checker_timeout' };
      }
      if (outcome.kind === 'threw') {
        return { kind: 'error', code: 'checker_error' };
      }

      if (policy.usage) {
        try {
          const usage = await policy.usage(context);
          this.checkerTokens += usage.tokens ?? 0;
          this.checkerCostUSD += usage.costUSD ?? 0;
        } catch {
          // A usage reporter that throws must not fabricate a verdict.
          return { kind: 'error', code: 'checker_error' };
        }
      }

      const verdict = outcome.value;
      if (verdict?.status === 'pass') return { kind: 'pass' };
      if (verdict?.status === 'fail') {
        return {
          kind: 'fail',
          code: verdict.failure.code,
          ...(verdict.failure.evidence !== undefined
            ? { evidence: verdict.failure.evidence }
            : {}),
        };
      }
      // An unrecognized verdict fails closed.
      return { kind: 'error', code: 'checker_error' };
    } finally {
      sleepCancel.abort();
      partial.signal?.removeEventListener('abort', onRunAbort);
    }
  }

  /**
   * Apply the surviving ops and persist through `compareAndSet`. On a revision
   * conflict, reload, re-classify the surviving ops against the reloaded
   * document (goal ids make this well-defined) and retry exactly once.
   */
  private async applyAndStore(
    survivors: readonly AxWorkingStateClassifiedOp[],
    context: AxWorkingStateCommitContext,
    parked: AxWorkingStateParkedDelta[],
    guidance: AxWorkingStateGuidanceNote[]
  ): Promise<AxWorkingStateClassifiedOp[]> {
    let attempt = 0;
    let working = survivors;
    while (attempt < 2) {
      attempt += 1;
      const applied = axApplyStatePatch(
        this.document,
        working.map((entry) => entry.op)
      );
      if (applied.status === 'rejected') {
        guidance.push(
          this.guidanceNote('patch_invalid', working[applied.index])
        );
        return [];
      }
      const next = this.stampTurns(
        applied.value as AxWorkingStateDocument<S>,
        working,
        context.turn
      );
      const withParks = this.appendParks(next, parked);
      try {
        const envelope = await this.config.store.compareAndSet(
          this.config.storeKey,
          this.revision,
          {
            schemaVersion: withParks.schemaVersion,
            programVersion: this.runIdValue,
            state: withParks,
            updatedAt: this.config.clock.now(),
          },
          this.config.fence
        );
        this.document = withParks;
        this.revision = envelope.revision;
        return working.filter((entry) => entry.class !== 'guard');
      } catch (err) {
        // A host store may throw anything, so "conflict" is decided by
        // EVIDENCE rather than by the error's shape: reload and see whether
        // the stored revision actually moved. A store that failed without
        // moving is an outage, not a conflict, and an outage is not a
        // recoverable in-run condition.
        let reloaded: Awaited<ReturnType<AxProgramStateStore['load']>>;
        try {
          reloaded = await this.config.store.load(this.config.storeKey);
        } catch (loadErr) {
          throw new AxWorkingStateStoreError(
            this.config.storeKey,
            'load',
            loadErr,
            context.turn
          );
        }
        if (!reloaded || reloaded.revision === this.revision) {
          throw new AxWorkingStateStoreError(
            this.config.storeKey,
            'commit',
            err,
            context.turn
          );
        }
        if (attempt >= 2) {
          for (const entry of working) {
            if (entry.class === 'guard') continue;
            parked.push(
              this.buildParkedDelta(entry, 'revision_conflict', context)
            );
            guidance.push(this.guidanceNote('revision_conflict', entry));
          }
          // Recorded, not thrown: a conflict is an in-run condition, and the
          // retry is bounded at one rebase.
          void new AxWorkingStateConflictError(
            this.config.storeKey,
            this.revision,
            context.turn
          );
          return [];
        }
        this.revision = reloaded.revision;
        if (isRecord(reloaded.state)) {
          this.document = reloaded.state as AxWorkingStateDocument<S>;
        }
        const reclassified = classifyPatch(
          working.map((entry) => entry.op),
          {
            believed: this.document,
            receipts: this.receiptList,
            factRoots: this.config.factRoots,
            factDepthLimit: this.config.factDepthLimit,
            allowModelAuthoredGoals: this.config.allowModelAuthoredGoals,
            expectsAllowlist: this.config.expectsAllowlist,
          }
        );
        working = reclassified.filter(
          (entry) => entry.kernelVerdict === 'admissible'
        );
        if (working.filter((entry) => entry.class !== 'guard').length === 0) {
          return [];
        }
      }
    }
    return [];
  }

  private stampTurns(
    document: AxWorkingStateDocument<S>,
    survivors: readonly AxWorkingStateClassifiedOp[],
    turn: number
  ): AxWorkingStateDocument<S> {
    const touched = new Set(
      survivors
        .filter((entry) => entry.goalId !== undefined)
        .map((entry) => entry.goalId!)
    );
    if (touched.size === 0) return document;
    const goals: Record<string, AxWorkingStateGoal> = { ...document.goals };
    for (const goalId of touched) {
      const goal = goals[goalId];
      if (!goal) continue;
      const created = survivors.some(
        (entry) => entry.goalId === goalId && entry.class === 'goal_add'
      );
      goals[goalId] = {
        ...goal,
        ...(created ? { createdTurn: turn } : {}),
        updatedTurn: turn,
      };
    }
    return { ...document, goals };
  }

  private appendParks(
    document: AxWorkingStateDocument<S>,
    parked: readonly AxWorkingStateParkedDelta[]
  ): AxWorkingStateDocument<S> {
    if (parked.length === 0) return document;
    const merged = [...document.parked, ...parked];
    return {
      ...document,
      parked: merged.slice(-this.config.maxParksPerRun),
    };
  }

  /**
   * Apply the park budgets, persist a parks-only commit when nothing else
   * committed, emit the Gamma record and return the outcome.
   */
  private async finish(args: {
    believed: AxWorkingStateDocument<S>;
    context: AxWorkingStateCommitContext;
    classified: readonly AxWorkingStateClassifiedOp[];
    parked: AxWorkingStateParkedDelta[];
    guidance: AxWorkingStateGuidanceNote[];
    outcome: AxWorkingStateCommitOutcome<S>['outcome'];
    proposedDigest: string | undefined;
    checkerVerdict: AxWorkingStateTraceStep['checkerVerdict'];
    forbiddenError?: AxWorkingStateForbiddenPathError;
  }): Promise<AxWorkingStateCommitOutcome<S>> {
    const { context, parked, guidance } = args;

    if (parked.length > 0 && args.classified.length === 0) {
      // The parked ledger is model-visible even when nothing else committed.
      this.document = this.appendParks(this.document, parked);
    }

    // Per-goal budget: force-block the goal with a HARNESS-authored blocker.
    for (const entry of parked) {
      const goalId = goalIdFromPointer(entry.op.path);
      if (!goalId) continue;
      const next = (this.parkCountByGoal.get(goalId) ?? 0) + 1;
      this.parkCountByGoal.set(goalId, next);
      if (next > this.config.maxParksPerGoal) {
        const goal = this.document.goals[goalId];
        if (goal && goal.status !== 'done') {
          this.document = {
            ...this.document,
            goals: {
              ...this.document.goals,
              [goalId]: {
                ...goal,
                status: 'blocked',
                blocker: `park budget exhausted: ${entry.reason}`,
                updatedTurn: context.turn,
              },
            },
          };
        }
      }
    }

    this.parkCountForRun += parked.length;

    // The interlock is resolved here, after every commit and park for the
    // turn has landed, so one Gamma record still describes the whole turn.
    const completionInterlock = context.resolveCompletionInterlock?.();
    await this.emitTrace({ ...args, completionInterlock });

    if (this.parkCountForRun > this.config.maxParksPerRun) {
      throw new AxWorkingStateParkBudgetError(
        'run',
        parked,
        undefined,
        context.turn
      );
    }

    return {
      state: this.document,
      revision: this.currentRevision(),
      committed: args.classified,
      parked,
      outcome: args.outcome,
      ...(guidance.length > 0 ? { guidance } : {}),
    };
  }

  private async emitTrace(args: {
    believed: AxWorkingStateDocument<S>;
    context: AxWorkingStateCommitContext;
    classified: readonly AxWorkingStateClassifiedOp[];
    parked: readonly AxWorkingStateParkedDelta[];
    outcome: AxWorkingStateCommitOutcome<S>['outcome'];
    proposedDigest: string | undefined;
    checkerVerdict: AxWorkingStateTraceStep['checkerVerdict'];
    completionInterlock?: 'converted' | 'exhausted';
  }): Promise<void> {
    if (!this.config.traceEnabled || !this.config.onTrace) return;
    const { context } = args;
    const step: AxWorkingStateTraceStep = {
      runId: this.runIdValue,
      stage: this.stage,
      turn: context.turn,
      believedStateDigest: await axWorkingStateFingerprint(args.believed),
      selectedSkills: [...(context.selectedSkills ?? [])].sort(),
      action: {
        codeDigest: await axEventCanonicalDigest(context.action),
        codeChars: context.action.length,
        executed: context.executed !== false,
        calls: [...new Set(context.calls ?? [])].sort(),
      },
      observation: {
        digest: await axEventCanonicalDigest(context.observation),
        chars: context.observation.length,
        isError: context.isError,
        receipts: [...(context.receiptRefs ?? [])],
      },
      ...(args.proposedDigest
        ? { proposedStateDigest: args.proposedDigest }
        : {}),
      proposal: context.proposal ?? 'emitted',
      checkerVerdict: args.checkerVerdict,
      committedStateDigest: await axWorkingStateFingerprint(this.document),
      committedRevision: this.currentRevision(),
      committed: args.classified.map((entry) => entry.class),
      parked: args.parked.map((entry) => entry.reason),
      outcome: args.outcome,
      ...(args.completionInterlock
        ? { completionInterlock: args.completionInterlock }
        : {}),
      ...(this.config.traceSummaries && context.summary
        ? { summary: context.summary }
        : {}),
      at: this.config.clock.now(),
    };
    try {
      await this.config.onTrace(step);
    } catch {
      // Observability is fail-soft, like `onFunctionCall`.
    }
  }
}

function goalIdFromPointer(pointer: string): string | undefined {
  const segments = parseStatePatchPointer(pointer);
  if (!segments || segments[0] !== 'goals' || segments.length < 2) {
    return undefined;
  }
  const candidate = segments[1]!;
  return GOAL_ID_PATTERN.test(candidate) ? candidate : undefined;
}

function boundEvidence(evidence: unknown, maxBytes: number): unknown {
  const serialized = axEventCanonicalJson(evidence);
  if (serialized.length <= maxBytes) return evidence;
  return { truncated: true, bytes: serialized.length };
}

function seedDocument<S>(
  config: Readonly<AxWorkingStateConfig<S>>,
  resolved: ResolvedConfig<S>
): AxWorkingStateDocument<S> {
  const seededGoals = config.initial?.goals ?? {};
  const goals: Record<string, AxWorkingStateGoal> = {};
  for (const [id, goal] of Object.entries(seededGoals)) {
    if (!GOAL_ID_PATTERN.test(id)) {
      throw new AxWorkingStateSchemaError(`invalid_goal_id: ${id}`);
    }
    if (goal.id !== id) {
      throw new AxWorkingStateSchemaError(
        `invalid_goal_id: seeded goal ${id} declares id ${goal.id}`
      );
    }
    if (goal.status !== 'pending' && (goal.evidence?.length ?? 0) > 0) {
      throw new AxWorkingStateSchemaError(
        `invalid_seed_evidence: goal ${id} cites evidence with no receipts minted`
      );
    }
    goals[id] = {
      ...goal,
      evidence: goal.evidence ?? [],
      createdTurn: goal.createdTurn ?? 0,
      updatedTurn: goal.updatedTurn ?? 0,
    };
  }
  void resolved;
  return {
    schemaVersion: config.initial?.schemaVersion ?? 1,
    goals,
    facts: (config.initial?.facts ?? ({} as S)) as Readonly<S>,
    parked: config.initial?.parked ?? [],
  };
}

function resolveWorkingStateConfig<S>(
  config: Readonly<AxWorkingStateConfig<S>>,
  runId: string
): ResolvedConfig<S> {
  const { signature, roots } = resolveStateSignature(config.stateSignature);
  if (roots.length === 0) {
    throw new AxWorkingStateSchemaError('empty_fact_space');
  }
  if (
    config.allowModelAuthoredGoals === true &&
    (config.expectsAllowlist?.length ?? 0) === 0
  ) {
    throw new AxWorkingStateSchemaError('model_goals_require_allowlist');
  }
  const trace =
    typeof config.trace === 'boolean'
      ? { enabled: config.trace, summaries: false }
      : (config.trace ?? { enabled: false, summaries: false });

  return {
    signature,
    stateContract: renderStateContract(signature),
    factRoots: new Set(roots),
    factDepthLimit: config.factDepthLimit ?? DEFAULT_FACT_DEPTH_LIMIT,
    ...(config.checker ? { checker: config.checker } : {}),
    proposerMode: config.proposer ?? 'on-change',
    ...(config.proposeWith ? { proposeWith: config.proposeWith } : {}),
    proposerInstruction:
      config.proposerInstruction ?? DEFAULT_PROPOSER_INSTRUCTION,
    ...(config.proposerOptions
      ? { proposerOptions: config.proposerOptions }
      : {}),
    store: config.store ?? new AxInMemoryProgramStateStore(),
    storeKey: config.storeKey ?? `ax.workingState:${runId}`,
    ...(config.fence ? { fence: config.fence } : {}),
    clock: config.clock ?? new AxSystemEventClock(),
    traceEnabled: trace.enabled === true,
    traceSummaries: trace.summaries === true,
    ...(config.onTrace ? { onTrace: config.onTrace } : {}),
    maxObservationChars:
      config.maxObservationChars ?? DEFAULT_MAX_OBSERVATION_CHARS,
    allowModelAuthoredGoals: config.allowModelAuthoredGoals === true,
    expectsAllowlist: config.expectsAllowlist ?? [],
    ...(config.receiptSources ? { receiptSources: config.receiptSources } : {}),
    completionPolicy: config.completionPolicy ?? 'observe',
    maxCompletionInterlocks:
      config.maxCompletionInterlocks ?? DEFAULT_MAX_COMPLETION_INTERLOCKS,
    maxRenderChars: config.maxRenderChars ?? DEFAULT_MAX_RENDER_CHARS,
    maxRosterEntries: config.maxRosterEntries ?? DEFAULT_MAX_ROSTER_ENTRIES,
    maxParksPerGoal:
      config.checker?.maxParksPerGoal ?? DEFAULT_MAX_PARKS_PER_GOAL,
    maxParksPerRun: config.checker?.maxParksPerRun ?? DEFAULT_MAX_PARKS_PER_RUN,
    maxEvidenceBytes:
      config.checker?.maxEvidenceBytes ?? DEFAULT_MAX_EVIDENCE_BYTES,
  };
}

/**
 * Open a working state for one `forward()`. Validates the config at
 * construction (never at turn 40) and loads any persisted document.
 */
export const axWorkingState = async <S = Record<string, unknown>>(
  config: Readonly<AxWorkingStateConfig<S>>,
  deps: Readonly<{
    runId: string;
    stage: AxAgentContextStage;
    ai?: AxAIService;
    restored?: Readonly<AxAgentStateWorkingState>;
  }>
): Promise<AxWorkingState<S>> =>
  AxWorkingState.open<S>(config, deps, deps.restored);
