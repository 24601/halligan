/**
 * Executable contract for the four host-supplied callbacks the playbook
 * evidence machinery accepts: the trajectory classifier, the reach probe, the
 * promotion veto, and the `AxAuthorizer` behind promotion authority.
 *
 * These are not a durability port, so this kit deliberately does NOT restate
 * Ax's own guarantees. It asserts only properties a HOST can violate, and it
 * exists because three of the four decide fail-closed semantics: a classifier
 * removes runs from the score denominator, a veto blocks a promotion, and an
 * authorizer that fails its echo obligation is rejected with `invalid_receipt`
 * — indistinguishable from a real denial without a test that separates them. A
 * host that gets any of these subtly wrong produces evidence that is WRONG
 * rather than absent, which is the one failure mode this whole subsystem is
 * built to prevent.
 *
 * Two assertions from the first draft are gone on purpose. "A veto returning
 * `{vetoed:false}` never causes a promotion" is a property of Ax's own gate
 * chain that no host implementation can fail. And the receipt-matching rules
 * are `receiptMatches`, already covered by `authority.test.ts`; what a host can
 * actually get wrong is the echo it is responsible for producing, so that is
 * the only part restated here.
 *
 * RUNNING THIS KIT HAS REAL HOST-SIDE EFFECTS. It invokes the supplied veto
 * twice and performs ONE genuine `axAuthorize` against the caller's live
 * `AxAuthorityContext` — which calls the host authorizer, and therefore whatever
 * approval system, audit log or policy engine sits behind it. Point it at a
 * staging authority, or at a principal whose grants are scoped to
 * `axPlaybookEvidenceConformanceResource`, unless a real approval record per run
 * is acceptable. The classifier and reach probe are pure by contract, so those
 * calls are free.
 */

import { axAuthorize } from '../../../authority/authority.js';
import type {
  AxAuthorityContext,
  AxAuthorizationReceipt,
} from '../../../authority/types.js';
import type { AxAgentEvalTask } from '../agentOptimizeTypes.js';
import type {
  AxAgentPlaybookNomination,
  AxAgentPlaybookPromotionVeto,
  AxAgentPlaybookReachProbe,
  AxAgentTrajectoryClassifier,
} from './playbookEvidenceTypes.js';

class AxConformanceFailure extends Error {
  constructor(message: string) {
    super(`playbook evidence conformance: ${message}`);
    this.name = 'AxConformanceFailure';
  }
}

const require_ = (condition: boolean, message: string): void => {
  if (!condition) throw new AxConformanceFailure(message);
};

/**
 * DEEP, not `Object.freeze`. A shallow freeze leaves every nested object
 * writable, so "the classifier is handed frozen args" would have been a claim
 * about the top level only — and `args.task.input.seen = true` is exactly the
 * bookkeeping write a host classifier makes.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value);
  }
  return value;
}

/** A runtime's way of saying "you tried to write to something frozen". */
function isFrozenWriteError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return /read.?only|not extensible|frozen|immutable/i.test(error.message);
}

const TASK: Readonly<AxAgentEvalTask> = deepFreeze({
  input: { conformance: true },
  criteria: 'conformance probe task',
  id: 'ax-conformance-1',
}) as Readonly<AxAgentEvalTask>;

const CLEAN_PREDICTION = deepFreeze({
  completionType: 'final' as const,
  output: { answer: 'ok' },
  actionLog: '',
  functionCalls: [],
  toolErrors: [],
  turnCount: 1,
});

/**
 * The exact `AxResourceScope` this kit asks `axAuthorize` about. A host must
 * hold a grant naming it, because grant matching is by exact identity and runs
 * BEFORE the authorizer — without a matching grant the echo assertion would
 * test nothing at all.
 */
export const axPlaybookEvidenceConformanceResource = Object.freeze({
  type: 'ax.agent.playbook.candidate',
  id: 'ax-conformance-resource',
});

/** The operation this kit asks about. Pair it with the resource above. */
export const axPlaybookEvidenceConformanceOperation =
  'ax.agent.playbook.promote';

const NOMINATION: Readonly<AxAgentPlaybookNomination> = deepFreeze({
  candidateDigest: 'conformance-candidate',
  splitDigests: {
    current: 'conformance-current',
    slices: [],
  },
  splitDigestBasis: 'task_ids' as const,
  promotionDigest: 'conformance-promotion',
  resourceId: axPlaybookEvidenceConformanceResource.id,
  gatesPassed: [],
  gatesFailed: [],
  nominated: true,
}) as Readonly<AxAgentPlaybookNomination>;

const MUTATION_FAILURE =
  'the classifier mutated its input. A classifier that writes into the task it is handed makes the discard denominator depend on evaluation order, which no receipt can disclose and no reader can reproduce';

async function assertClassifier(
  classifier: AxAgentTrajectoryClassifier,
  count: () => void
): Promise<void> {
  const unknownArgs = deepFreeze({
    task: TASK,
    attempt: 0,
    redraw: 0,
    split: 'current' as const,
    error: new Error('an error shape this classifier has never seen'),
    errorName: 'AxConformanceUnknownError',
  });
  let first: unknown;
  try {
    first = classifier(unknownArgs);
  } catch (error) {
    // A write to a deep-frozen argument surfaces here as a TypeError. Reporting
    // that as "the classifier threw on an unrecognized input" would send a host
    // to fix a totality bug it does not have, so the two are separated.
    if (isFrozenWriteError(error)) {
      throw new AxConformanceFailure(
        `${MUTATION_FAILURE} (${(error as Error).message})`
      );
    }
    throw new AxConformanceFailure(
      `the classifier threw on an unrecognized input (${error instanceof Error ? error.message : String(error)}); a classifier that cannot classify must RETURN UNDEFINED, because a throw aborts the whole run with classifier_invalid`
    );
  }
  count();
  require_(
    first === undefined,
    'the classifier must return undefined for an input it does not recognize, so Ax falls back to policy_failure rather than laundering an unknown failure out of the score denominator'
  );

  // Purity. A stateful classifier makes the denominator depend on evaluation
  // order, which no receipt can disclose and no reader can reproduce.
  const second = classifier(unknownArgs);
  count();
  require_(
    JSON.stringify(second ?? null) === JSON.stringify(first ?? null),
    'the classifier is not pure: the same frozen input produced two different verdicts'
  );

  // The write itself, on a MUTABLE copy — and snapshotted BEFORE the call, not
  // compared against the same live reference the classifier was handed, which
  // is a comparison of an object with itself that no mutation can ever fail.
  // The copy exists because the frozen args above turn an unconditional write
  // into a throw; a host that stamps bookkeeping inside a `try/catch` writes
  // successfully here and nowhere else, and that write is the whole point.
  const mutableArgs = {
    task: JSON.parse(JSON.stringify(TASK)) as AxAgentEvalTask,
    attempt: 0,
    redraw: 0,
    split: 'current' as const,
    error: new Error('an error shape this classifier has never seen'),
    errorName: 'AxConformanceUnknownError',
  };
  const taskBefore = JSON.stringify(mutableArgs.task);
  try {
    classifier(mutableArgs);
  } catch {
    // Totality is already asserted above against the frozen args; a throw here
    // adds nothing and must not mask the mutation reading.
  }
  count();
  require_(JSON.stringify(mutableArgs.task) === taskBefore, MUTATION_FAILURE);

  const clean = classifier(
    deepFreeze({
      task: TASK,
      prediction: CLEAN_PREDICTION as never,
      attempt: 0,
      redraw: 0,
      split: 'current' as const,
    })
  );
  count();
  require_(
    clean?.kind !== 'environment_failure',
    'the classifier called a run with a final prediction and no error an environment_failure; discarding a completed run removes real evidence from the denominator'
  );
}

function assertReachProbe(
  probe: AxAgentPlaybookReachProbe,
  count: () => void
): void {
  const empty = probe(
    deepFreeze({
      candidateBulletIds: [],
      renderedBulletIds: ['other-bullet'],
      task: TASK,
      prediction: CLEAN_PREDICTION as never,
      split: 'current' as const,
    })
  );
  count();
  require_(
    empty === undefined || empty.applicableAtDecidingStep === false,
    'the reach probe reported a candidate bullet as applicable at the deciding step while the proposal changed no bullets; reach would then be satisfied by the prompt getting longer, which is exactly what the reach gate exists to refute'
  );

  const observed = probe(
    deepFreeze({
      candidateBulletIds: ['ax-conformance-bullet'],
      renderedBulletIds: ['ax-conformance-bullet'],
      task: TASK,
      prediction: CLEAN_PREDICTION as never,
      split: 'current' as const,
    })
  );
  count();
  require_(
    observed === undefined ||
      (Number.isSafeInteger(observed.invocations) && observed.invocations >= 0),
    `the reach probe returned invocations ${String(observed?.invocations)}; it must be a non-negative safe integer or the split reads unmeasured`
  );
}

/** Bounded so an unresponsive host callback fails the contract, not the run. */
const VETO_SETTLE_BUDGET_MS = 250;

/**
 * A settlement that keeps THREW and RESOLVED apart.
 *
 * Collapsing a rejection into `value: undefined` made a throwing veto — a
 * supported, documented fail-closed answer this subsystem implements and tests
 * — indistinguishable from a host that forgot its `return`, and the kit then
 * told it to fix a bug it did not have.
 */
type AxConformanceSettlement<T> =
  | Readonly<{ settled: true; threw: false; value: T }>
  | Readonly<{ settled: true; threw: true; error: unknown }>
  | Readonly<{ settled: false }>;

async function settleWithin<T>(
  work: () => T | Promise<T>,
  budgetMs: number
): Promise<AxConformanceSettlement<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<AxConformanceSettlement<T>>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), budgetMs);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(work)
        .then(
          (value): AxConformanceSettlement<T> => ({
            settled: true,
            threw: false,
            value,
          }),
          (error): AxConformanceSettlement<T> => ({
            settled: true,
            threw: true,
            error,
          })
        ),
      hung,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * An `AbortSignal` that counts the abort listeners attached to it and not
 * removed. There is no portable `getEventListeners`, so the signal itself is
 * instrumented — which is enough for item 8, because the leak that matters is a
 * host callback attaching to the CALLER's long-lived run signal once per veto
 * per candidate and never detaching.
 *
 * Only checked on a call that settles normally: a listener registered with
 * `{ once: true }` is detached by the runtime after firing, without a
 * `removeEventListener` this counter could observe, so asserting the balance
 * around an abort would report a false leak.
 */
function countingAbortSignal(): Readonly<{
  signal: AbortSignal;
  outstanding: () => number;
}> {
  const controller = new AbortController();
  const signal = controller.signal;
  let outstanding = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  Object.defineProperty(signal, 'addEventListener', {
    configurable: true,
    value: (type: string, ...rest: readonly unknown[]) => {
      if (type === 'abort') outstanding++;
      return (add as (...args: readonly unknown[]) => unknown)(type, ...rest);
    },
  });
  Object.defineProperty(signal, 'removeEventListener', {
    configurable: true,
    value: (type: string, ...rest: readonly unknown[]) => {
      if (type === 'abort') outstanding--;
      return (remove as (...args: readonly unknown[]) => unknown)(
        type,
        ...rest
      );
    },
  });
  return { signal, outstanding: () => outstanding };
}

async function assertVeto(
  veto: AxAgentPlaybookPromotionVeto,
  count: () => void
): Promise<void> {
  // The host's callback must SETTLE after its signal aborts. Checked FIRST,
  // because a veto that never settles would otherwise hang the contract itself
  // — and "the kit hung" is a much worse report than "the veto ignores its
  // signal".
  const controller = new AbortController();
  const aborting = settleWithin(
    () => veto(NOMINATION, controller.signal),
    VETO_SETTLE_BUDGET_MS
  );
  controller.abort(new Error('conformance abort'));
  count();
  require_(
    (await aborting).settled,
    `the veto did not settle within ${VETO_SETTLE_BUDGET_MS}ms of its signal aborting`
  );

  // D4, the one place a permissive reading fails open: `undefined` is falsy, so
  // a host that forgot a `return` would silently approve every candidate under
  // a naive implementation. Ax reads it as a VETO — which means a host that
  // MEANT to allow and returned nothing blocks its own promotions with no way
  // to see why. This assertion is the only place that distinction surfaces.
  const listeners = countingAbortSignal();
  const answered = await settleWithin(
    () => veto(NOMINATION, listeners.signal),
    VETO_SETTLE_BUDGET_MS
  );
  count();
  require_(
    answered.settled,
    `the veto did not settle within ${VETO_SETTLE_BUDGET_MS}ms on an un-aborted call`
  );
  count();
  // A veto that THROWS is a documented, conforming fail-closed answer: Ax reads
  // it as a veto and names the error in the receipt. The kit asserts that Ax's
  // interpretation matches the table (§4.9); it does not ask hosts to stop
  // throwing. So only a RESOLVED value has to be readable.
  if (answered.settled && !answered.threw) {
    const answer = answered.value;
    require_(
      answer === true ||
        answer === false ||
        (typeof answer === 'object' &&
          answer !== null &&
          typeof (answer as { vetoed?: unknown }).vetoed === 'boolean'),
      `the veto RESOLVED with ${answer === undefined ? 'undefined' : JSON.stringify(answer)}, which Ax's fail-closed table reads as a VETO. Only false or { vetoed: false } declines; a host that meant to allow must say so explicitly. (A veto that THROWS is fine — that is a deliberate fail-closed answer.)`
    );
  }

  // Item 8. A veto that attaches to the caller's run signal and never detaches
  // accumulates one listener per veto per candidate on a signal that outlives
  // the whole run.
  count();
  require_(
    listeners.outstanding() === 0,
    `the veto left ${listeners.outstanding()} abort listener(s) attached to a signal that never aborted; a run evaluating many candidates accumulates one per veto per candidate on the caller's long-lived signal`
  );
}

async function assertAuthorizer(
  authority: Readonly<AxAuthorityContext>,
  count: () => void
): Promise<void> {
  const seen: { requestId?: string; operation?: string; resourceId?: string } =
    {};
  const operation = axPlaybookEvidenceConformanceOperation;
  // Exactly the resource shape the run builds by default. A tenant-scoped
  // deployment sets `promotionAuthority.tenantId`; the kit does not guess one,
  // because a mismatched scope would fail the grant filter and report the host
  // authorizer as broken when nothing was ever asked of it.
  const resource = axPlaybookEvidenceConformanceResource;
  const observing: Readonly<AxAuthorityContext> = {
    ...authority,
    authorize: async (op, context) => {
      seen.requestId = context.requestId;
      seen.operation = op;
      seen.resourceId = context.resource.id;
      return (await authority.authorize(
        op,
        context
      )) as Readonly<AxAuthorizationReceipt>;
    },
  };
  let receipt: Readonly<AxAuthorizationReceipt> | undefined;
  try {
    receipt = await axAuthorize(observing, operation, resource);
  } catch (error) {
    throw new AxConformanceFailure(
      `axAuthorize refused the conformance request (${error instanceof Error ? error.message : String(error)}); the kit needs a grant naming { type: '${resource.type}', id: '${resource.id}' } so the ECHO can be observed — a host whose grant does not match is testing no echo at all`
    );
  }
  count();
  require_(
    receipt !== undefined,
    'axAuthorize produced no receipt for a request the host was given a matching grant for'
  );
  count();
  require_(
    receipt?.requestId === seen.requestId &&
      receipt?.operation === seen.operation &&
      receipt?.resource?.id === seen.resourceId,
    `the host authorizer did not echo its request exactly (requestId ${String(receipt?.requestId)} vs ${String(seen.requestId)}, operation ${String(receipt?.operation)} vs ${String(seen.operation)}, resource id ${String(receipt?.resource?.id)} vs ${String(seen.resourceId)}). Ax rejects this with invalid_receipt, which is indistinguishable from a real host denial without this test`
  );
}

/**
 * Run the contract for whichever callbacks the host supplies.
 *
 * Returns the number of assertions actually executed and the capabilities they
 * covered, so a host cannot pass this by supplying nothing: a caller that
 * expects four capabilities and receives one has been told so.
 *
 * The RFC's signature carried a `now?: () => number`. Nothing here reads a
 * clock — the settle budget is a real `setTimeout` a host callback must beat,
 * and an injected clock cannot make a hung callback return — so accepting one
 * would be an accepted-but-inert option, which is the exact silent absence this
 * subsystem refuses everywhere else. Recorded as a deviation rather than
 * shipped as decoration.
 */
export async function runAxAgentPlaybookEvidenceConformance(args: {
  classifier?: AxAgentTrajectoryClassifier;
  reachProbe?: AxAgentPlaybookReachProbe;
  veto?: AxAgentPlaybookPromotionVeto;
  authority?: Readonly<AxAuthorityContext>;
}): Promise<{ assertions: number; capability: readonly string[] }> {
  let assertions = 0;
  const count = () => {
    assertions++;
  };
  const capability: string[] = [];
  if (args.classifier) {
    await assertClassifier(args.classifier, count);
    capability.push('classifier');
  }
  if (args.reachProbe) {
    assertReachProbe(args.reachProbe, count);
    capability.push('reachProbe');
  }
  if (args.veto) {
    await assertVeto(args.veto, count);
    capability.push('veto');
  }
  if (args.authority) {
    await assertAuthorizer(args.authority, count);
    capability.push('authority');
  }
  return { assertions, capability };
}
