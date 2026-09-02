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

const TASK: Readonly<AxAgentEvalTask> = Object.freeze({
  input: Object.freeze({ conformance: true }),
  criteria: 'conformance probe task',
  id: 'ax-conformance-1',
}) as Readonly<AxAgentEvalTask>;

const CLEAN_PREDICTION = Object.freeze({
  completionType: 'final' as const,
  output: Object.freeze({ answer: 'ok' }),
  actionLog: '',
  functionCalls: Object.freeze([]),
  toolErrors: Object.freeze([]),
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

const NOMINATION: Readonly<AxAgentPlaybookNomination> = Object.freeze({
  candidateDigest: 'conformance-candidate',
  splitDigests: Object.freeze({
    current: 'conformance-current',
    slices: Object.freeze([]),
  }),
  splitDigestBasis: 'task_ids' as const,
  promotionDigest: 'conformance-promotion',
  resourceId: axPlaybookEvidenceConformanceResource.id,
  gatesPassed: Object.freeze([]),
  gatesFailed: Object.freeze([]),
  nominated: true,
}) as Readonly<AxAgentPlaybookNomination>;

async function assertClassifier(
  classifier: AxAgentTrajectoryClassifier,
  count: () => void
): Promise<void> {
  const unknownArgs = Object.freeze({
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
  count();
  require_(
    JSON.stringify(unknownArgs.task) === JSON.stringify(TASK),
    'the classifier mutated its input'
  );

  const clean = classifier(
    Object.freeze({
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
    Object.freeze({
      candidateBulletIds: Object.freeze([]),
      renderedBulletIds: Object.freeze(['other-bullet']),
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
    Object.freeze({
      candidateBulletIds: Object.freeze(['ax-conformance-bullet']),
      renderedBulletIds: Object.freeze(['ax-conformance-bullet']),
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

async function settleWithin<T>(
  work: () => T | Promise<T>,
  budgetMs: number
): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), budgetMs);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(work)
        .then(
          (value) => ({ settled: true as const, value }),
          () => ({ settled: true as const, value: undefined as T })
        ),
      hung,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  const answered = await settleWithin(
    () => veto(NOMINATION, new AbortController().signal),
    VETO_SETTLE_BUDGET_MS
  );
  count();
  require_(
    answered.settled,
    `the veto did not settle within ${VETO_SETTLE_BUDGET_MS}ms on an un-aborted call`
  );
  const answer = answered.settled ? answered.value : undefined;
  count();
  require_(
    answer === true ||
      answer === false ||
      (typeof answer === 'object' &&
        answer !== null &&
        typeof (answer as { vetoed?: unknown }).vetoed === 'boolean'),
    `the veto returned ${answer === undefined ? 'undefined' : JSON.stringify(answer)}, which Ax's fail-closed table reads as a VETO. Only false or { vetoed: false } declines; a host that meant to allow must say so explicitly.`
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
 */
export async function runAxAgentPlaybookEvidenceConformance(args: {
  classifier?: AxAgentTrajectoryClassifier;
  reachProbe?: AxAgentPlaybookReachProbe;
  veto?: AxAgentPlaybookPromotionVeto;
  authority?: Readonly<AxAuthorityContext>;
  now?: () => number;
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
