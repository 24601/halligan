/**
 * Promotion authority for `agent.playbook().evolve()`.
 *
 * The judge NOMINATES. It does not promote.
 *
 * Two host channels decide whether a nomination becomes a promotion, and they
 * answer two different questions:
 *
 *   the GRANT  — "may this principal promote into this playbook?"
 *   the VETO   — "not this candidate."
 *
 * That split is forced by the authority surface, not chosen for elegance.
 * `axAuthorize` filters the host's pre-issued grants by exact `type`/`id`/
 * `tenantId` equality BEFORE it calls the host authorizer, and throws
 * `no_matching_grant` when the filter is empty — so `resource.id` must be a
 * value the host could have written into a grant before the run started. No
 * host can enumerate the digests of candidates that do not exist yet, so
 * binding `resource.id` to a per-candidate digest would ship a mechanism that
 * can never fire. `resourceId` is therefore caller-supplied and never derived,
 * `promotionDigest` is receipt metadata plus a post-hoc integrity value, and
 * per-candidate consent lives in the veto — which is the only channel that ever
 * sees the nomination, because `AxAuthorizationRequestContext` has no
 * free-form payload and widening it is out of scope.
 *
 * Both channels FAIL CLOSED. A veto that throws, times out, or returns anything
 * that is not `false` / `{ vetoed: false }` is a veto — `undefined`, the value a
 * host that forgot a `return` produces, included. An authorizer that denies, is
 * cancelled, times out, fails a guard, or hands back a receipt bound to some
 * other resource does not promote.
 */

import {
  AxAuthorizationDeniedError,
  axAuthorize,
} from '../../../authority/authority.js';
import type { AxAuthorizationReceipt } from '../../../authority/types.js';
import type {
  AxAgentPlaybookNomination,
  AxAgentPlaybookPromotionAuthority,
  AxAgentPlaybookPromotionDenialCode,
  AxAgentPlaybookPromotionRecord,
  AxAgentPlaybookPromotionVeto,
  AxAgentPlaybookVetoResult,
} from './playbookEvidenceTypes.js';
import { AxAgentPlaybookEvolveError } from './playbookEvidenceTypes.js';

/** Matches `axAuthorize`'s own default so one deadline governs both channels. */
export const DEFAULT_PROMOTION_VETO_TIMEOUT_MS = 30_000;
export const DEFAULT_PROMOTION_OPERATION = 'ax.agent.playbook.promote';
export const DEFAULT_PROMOTION_RESOURCE_TYPE = 'ax.agent.playbook.candidate';

/**
 * The fail-closed interpretation table, in one place so the conformance kit and
 * the gate chain cannot disagree about it.
 *
 * Only `false` and `{ vetoed: false }` decline. Everything else — `undefined`,
 * `null`, `0`, `''`, `{}`, `{ vetoed: 'yes' }` — is a veto, because a host that
 * returned one of those did not say "allow"; it said nothing, and a promotion
 * is not a thing to grant on silence.
 */
export function interpretVetoValue(
  value: unknown
): Readonly<{ vetoed: boolean; reason?: string }> {
  if (value === false) return { vetoed: false };
  if (value === true) {
    return { vetoed: true, reason: 'the veto returned true' };
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const candidate = value as { vetoed?: unknown; reason?: unknown };
    if (typeof candidate.vetoed === 'boolean') {
      return {
        vetoed: candidate.vetoed,
        ...(typeof candidate.reason === 'string'
          ? { reason: candidate.reason }
          : {}),
      };
    }
  }
  return {
    vetoed: true,
    reason: `the veto returned ${describeValue(value)}, which is neither a boolean nor { vetoed: boolean }; a promotion is never granted on an unreadable answer`,
  };
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return 'an array';
  return `an object with keys [${Object.keys(value as object)
    .sort()
    .join(', ')}]`;
}

function vetoIdOf(value: unknown, index: number): string {
  if (typeof value === 'object' && value !== null) {
    const id = (value as { vetoId?: unknown }).vetoId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return `veto[${index}]`;
}

/**
 * Invoke one veto under a deadline, with its own controller so the callback can
 * observe cancellation, and with the caller's abort listener removed in a
 * `finally` — the listener-leak pattern `callAuthorizer` already uses. A run
 * that evaluates many candidates would otherwise accumulate one listener per
 * veto per candidate on a long-lived signal.
 */
async function callVeto(args: {
  veto: AxAgentPlaybookPromotionVeto;
  nomination: Readonly<AxAgentPlaybookNomination>;
  index: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<AxAgentPlaybookVetoResult> {
  const { veto, nomination, index, timeoutMs, signal } = args;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const TIMED_OUT = Symbol('veto-timeout');
  const ABORTED = Symbol('veto-aborted');
  let settleAbort!: (value: typeof ABORTED) => void;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    settleAbort = resolve;
  });
  const onAbort = () => {
    controller.abort(signal?.reason);
    settleAbort(ABORTED);
  };
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort(new Error('promotion veto timed out'));
      resolve(TIMED_OUT);
    }, timeoutMs);
  });
  const callback = Promise.resolve().then(() =>
    veto(nomination, controller.signal)
  );
  // The race drops this promise on a timeout or an abort; swallow a late
  // rejection so it cannot surface as an unhandledRejection after the fact.
  const guarded = callback.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );
  try {
    const settled = await Promise.race([guarded, aborted, timedOut]);
    if (settled === TIMED_OUT) {
      return {
        vetoId: `veto[${index}]`,
        vetoed: true,
        reason: `the veto did not settle within ${timeoutMs}ms; a promotion is never granted on a hung host callback`,
      };
    }
    if (settled === ABORTED) {
      return {
        vetoId: `veto[${index}]`,
        vetoed: true,
        reason: 'the run was aborted while the veto was in flight',
      };
    }
    if (!settled.ok) {
      const error = settled.error;
      return {
        vetoId: `veto[${index}]`,
        vetoed: true,
        reason: `the veto threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const interpreted = interpretVetoValue(settled.value);
    return {
      vetoId: vetoIdOf(settled.value, index),
      vetoed: interpreted.vetoed,
      ...(interpreted.reason ? { reason: interpreted.reason } : {}),
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

export type AxPromotionVetoOutcome = Readonly<{
  vetoed: boolean;
  results: readonly AxAgentPlaybookVetoResult[];
  detail: string;
}>;

/**
 * Conjunctive: EVERY veto is invoked and recorded, and any one of them blocks.
 *
 * Short-circuiting on the first veto would be cheaper and would destroy the
 * receipt — a reader could not tell whether the second and third vetoes agreed,
 * disagreed, or were never asked. The cost is bounded (one host call per veto
 * per nominated candidate) and the candidate has already passed every free gate
 * by the time this runs.
 */
export async function runPromotionVetoes(args: {
  vetoes: readonly AxAgentPlaybookPromotionVeto[];
  nomination: Readonly<AxAgentPlaybookNomination>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<AxPromotionVetoOutcome> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_PROMOTION_VETO_TIMEOUT_MS;
  const results: AxAgentPlaybookVetoResult[] = [];
  for (const [index, veto] of args.vetoes.entries()) {
    results.push(
      await callVeto({
        veto,
        nomination: args.nomination,
        index,
        timeoutMs,
        ...(args.signal ? { signal: args.signal } : {}),
      })
    );
  }
  const blocking = results.filter((result) => result.vetoed);
  return {
    vetoed: blocking.length > 0,
    results,
    detail:
      blocking.length > 0
        ? `${blocking.length}/${results.length} veto(es) blocked this candidate: ${blocking
            .map(
              (result) =>
                `${result.vetoId}${result.reason ? ` (${result.reason})` : ''}`
            )
            .join('; ')}`
        : `${results.length} veto(es) declined to block`,
  };
}

export type AxPromotionAuthorityOutcome =
  | Readonly<{ status: 'promoted'; receipt: Readonly<AxAuthorizationReceipt> }>
  | Readonly<{
      status: 'denied';
      code: AxAgentPlaybookPromotionDenialCode;
      reason: string;
    }>;

/**
 * Reject a promotion configuration that could never produce a receipt, BEFORE
 * any evaluation. Ax never invents a `resourceId`: a derived id is one the host
 * cannot have pre-granted, and `matchingGrants` runs before the host authorizer
 * does — so a derived id denies every candidate with `no_matching_grant` while
 * looking configured.
 */
export function validatePromotionAuthority(
  promotionAuthority: Readonly<AxAgentPlaybookPromotionAuthority> | undefined
): void {
  if (!promotionAuthority) return;
  const fail = (message: string): never => {
    throw new AxAgentPlaybookEvolveError(
      'promotion_authority_invalid',
      'authority',
      message
    );
  };
  const { resourceId, authority } = promotionAuthority;
  if (typeof resourceId !== 'string' || resourceId.trim().length === 0) {
    fail(
      'promotionAuthority.resourceId must be a non-empty, host-grantable identity (an agent id, playbook id, deployment id, or retentionPolicy.evaluatorId). Ax never derives one: grants are matched by exact resource identity before the host authorizer runs, so a derived id is one no host could have granted.'
    );
  }
  if (!authority || typeof authority.authorize !== 'function') {
    fail(
      'promotionAuthority.authority must be an AxAuthorityContext with an authorize callback.'
    );
  }
  if (!Array.isArray(authority.grants) || authority.grants.length === 0) {
    fail(
      'promotionAuthority.authority carries no grants, so every promotion would be denied with no_matching_grant before the host authorizer was ever consulted.'
    );
  }
}

function denialCodeOf(error: unknown): AxAgentPlaybookPromotionDenialCode {
  const code = (error as { code?: unknown })?.code;
  return code === 'host_denied' ||
    code === 'no_matching_grant' ||
    code === 'invalid_receipt' ||
    code === 'cancelled' ||
    code === 'timeout' ||
    code === 'guard_predicate_failed'
    ? code
    : 'host_denied';
}

/**
 * One `axAuthorize` call, bound to the nomination's `resourceId`.
 *
 * The post-return checks are defence in depth, not the guarantee: `axAuthorize`
 * already enforces exact receipt binding (`receiptMatches`) and throws on a
 * `deny` decision, so the only non-throw return is an allow receipt bound to
 * this exact request. They exist so a future refactor there cannot quietly
 * relax the binding here.
 *
 * A supplied authority that returns `undefined` is a CONFIGURATION BUG, not a
 * denial, and throws — reporting it as `denied` would tell a reader that a host
 * refused this candidate when no host was ever asked.
 */
export async function requestPromotionAuthority(args: {
  promotionAuthority: Readonly<AxAgentPlaybookPromotionAuthority>;
  nomination: Readonly<AxAgentPlaybookNomination>;
  signal?: AbortSignal;
}): Promise<AxPromotionAuthorityOutcome> {
  const { promotionAuthority, nomination } = args;
  const operation = promotionAuthority.operation ?? DEFAULT_PROMOTION_OPERATION;
  const resource = {
    type: promotionAuthority.resourceType ?? DEFAULT_PROMOTION_RESOURCE_TYPE,
    id: nomination.resourceId,
    ...(promotionAuthority.tenantId
      ? { tenantId: promotionAuthority.tenantId }
      : {}),
  };
  let receipt: Readonly<AxAuthorizationReceipt> | undefined;
  try {
    receipt = await axAuthorize(
      promotionAuthority.authority,
      operation,
      resource,
      args.signal
    );
  } catch (error) {
    if (error instanceof AxAuthorizationDeniedError) {
      return {
        status: 'denied',
        code: denialCodeOf(error),
        reason: error.message,
      };
    }
    throw error;
  }
  if (!receipt) {
    throw new AxAgentPlaybookEvolveError(
      'promotion_authority_invalid',
      'authority',
      'promotionAuthority was supplied but axAuthorize produced no receipt; an authority that yields nothing is a configuration bug, not a denial.'
    );
  }
  if (receipt.decision !== 'allow') {
    return {
      status: 'denied',
      code: 'invalid_receipt',
      reason: `the host receipt carries decision '${receipt.decision}' rather than 'allow'`,
    };
  }
  if (receipt.resource?.id !== nomination.resourceId) {
    return {
      status: 'denied',
      code: 'invalid_receipt',
      reason: `the host receipt is bound to resource id '${String(receipt.resource?.id)}', not the requested '${nomination.resourceId}'`,
    };
  }
  return { status: 'promoted', receipt };
}

/**
 * Fold the two host channels into one record.
 *
 * Order matters and is the mechanism, not a formatting choice: a candidate the
 * free gates never nominated is `not_nominated` (no host was asked), a vetoed
 * candidate is `vetoed` even when an authorizer would have allowed it, and a
 * promotion requires BOTH an un-vetoed nomination and an allow receipt. There
 * is no path on which a veto causes a promotion.
 */
export function promotionRecordOf(args: {
  nomination: Readonly<AxAgentPlaybookNomination>;
  vetoes: readonly AxAgentPlaybookVetoResult[];
  authority?: AxPromotionAuthorityOutcome;
  authorityConfigured: boolean;
}): AxAgentPlaybookPromotionRecord {
  const nomination = args.nomination as AxAgentPlaybookNomination;
  if (!nomination.nominated) {
    return { status: 'not_nominated', nomination };
  }
  if (args.vetoes.some((result) => result.vetoed)) {
    return { status: 'vetoed', nomination, vetoes: args.vetoes };
  }
  if (args.authority?.status === 'denied') {
    return {
      status: 'denied',
      nomination,
      code: args.authority.code,
      reason: args.authority.reason,
    };
  }
  if (args.authority?.status === 'promoted') {
    return {
      status: 'promoted',
      nomination,
      receipt: args.authority.receipt,
      vetoes: args.vetoes,
    };
  }
  // No authority was configured (or the chain never reached it). The default
  // stays permissive; the absence of a receipt is on the record as a warning,
  // never as a fabricated 'promoted'.
  return args.authorityConfigured
    ? { status: 'not_nominated', nomination }
    : { status: 'not_required', nomination };
}
