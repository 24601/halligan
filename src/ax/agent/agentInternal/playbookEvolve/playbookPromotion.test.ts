import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'vitest';
import type {
  AxAuthorityContext,
  AxAuthorizationRequestContext,
  AxCapabilityGrant,
} from '../../../authority/types.js';
import {
  axPlaybookEvidenceConformanceOperation,
  axPlaybookEvidenceConformanceResource,
  runAxAgentPlaybookEvidenceConformance,
} from './evidenceConformance.js';
import type { AxAgentPlaybookNomination } from './playbookEvidenceTypes.js';
import { axIsAgentPlaybookEvolveError } from './playbookEvidenceTypes.js';
import {
  interpretVetoValue,
  promotionRecordOf,
  requestPromotionAuthority,
  runPromotionVetoes,
  validatePromotionAuthority,
} from './promotion.js';

// --- local factories -------------------------------------------------------

const NOW = 10_000;
const RESOURCE_ID = 'playbook:support-agent';
const PROMOTE_OPERATION = 'ax.agent.playbook.promote';
const CANDIDATE_TYPE = 'ax.agent.playbook.candidate';

const NOMINATION: AxAgentPlaybookNomination = {
  candidateDigest: 'cand-1',
  splitDigests: { current: 'cur-1', slices: [] },
  splitDigestBasis: 'task_ids',
  promotionDigest: 'promo-1',
  resourceId: RESOURCE_ID,
  gatesPassed: ['gain'],
  gatesFailed: [],
  nominated: true,
};

const grantOf = (
  override: Partial<AxCapabilityGrant> = {}
): AxCapabilityGrant => ({
  version: 1,
  id: 'grant-1',
  principalId: 'principal-a',
  actor: { id: 'actor-a', kind: 'agent' },
  operations: [PROMOTE_OPERATION],
  resources: [{ type: CANDIDATE_TYPE, id: RESOURCE_ID }],
  issuedAt: NOW - 100,
  expiresAt: NOW + 100,
  leaseEpoch: 3,
  ...override,
});

const echoReceipt = (
  operation: string,
  context: Readonly<AxAuthorizationRequestContext>,
  override: Record<string, unknown> = {}
) => ({
  version: 1 as const,
  receiptId: 'receipt-1',
  requestId: context.requestId,
  decision: 'allow' as const,
  operation,
  resource: context.resource,
  principalId: context.principal.id,
  actor: { id: context.actor.id, kind: context.actor.kind },
  grantIds: context.grants.map((value) => value.id),
  leaseEpoch: context.leaseEpoch,
  authorizedAt: context.now,
  ...override,
});

const authorityOf = (
  override: Partial<AxAuthorityContext> = {}
): AxAuthorityContext => ({
  principal: { id: 'principal-a' },
  actor: { id: 'actor-a', kind: 'agent' },
  grants: [grantOf()],
  leaseEpoch: 3,
  now: () => NOW,
  authorize: (operation, context) => echoReceipt(operation, context),
  ...override,
});

// --- the fail-closed interpretation table ----------------------------------

describe('veto interpretation', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['empty string', ''],
    ['an empty object', {}],
    ['a non-boolean vetoed field', { vetoed: 'yes' }],
    ['an array', []],
    ['true', true],
    ['{ vetoed: true }', { vetoed: true }],
  ])('treats %s as a veto', (_label, value) => {
    // `undefined` is THE case a permissive reading gets wrong: it is falsy, so
    // a host that forgot a `return` would silently approve every candidate.
    expect(interpretVetoValue(value).vetoed).toBe(true);
  });

  it.each([
    ['false', false],
    ['{ vetoed: false }', { vetoed: false }],
  ])('only %s declines to veto', (_label, value) => {
    expect(interpretVetoValue(value).vetoed).toBe(false);
  });

  it('names what it could not read, so a host can fix its return', () => {
    expect(interpretVetoValue(undefined).reason).toContain('undefined');
    expect(interpretVetoValue({ nope: 1 }).reason).toContain(
      'an object with keys [nope]'
    );
    expect(interpretVetoValue('maybe').reason).toContain('the string "maybe"');
    expect(interpretVetoValue({ vetoed: false, reason: 'fine' }).reason).toBe(
      'fine'
    );
  });
});

// --- the conjunctive veto race ---------------------------------------------

describe('promotion vetoes', () => {
  it('invokes and records every veto, and any one of them blocks', async () => {
    const calls: string[] = [];
    const outcome = await runPromotionVetoes({
      vetoes: [
        () => {
          calls.push('a');
          return false;
        },
        () => {
          calls.push('b');
          return { vetoId: 'policy', vetoed: true, reason: 'off policy' };
        },
        () => {
          calls.push('c');
          return { vetoed: false };
        },
      ],
      nomination: NOMINATION,
    });
    expect(outcome.vetoed).toBe(true);
    // Short-circuiting on the first veto would be cheaper and would destroy the
    // receipt: a reader could not tell whether the third veto agreed or was
    // never asked.
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(outcome.results).toHaveLength(3);
    expect(outcome.results[1]).toEqual({
      vetoId: 'policy',
      vetoed: true,
      reason: 'off policy',
    });
    expect(outcome.detail).toContain('1/3');
  });

  it('declines only when every veto explicitly declines', async () => {
    const outcome = await runPromotionVetoes({
      vetoes: [() => false, () => ({ vetoed: false })],
      nomination: NOMINATION,
    });
    expect(outcome.vetoed).toBe(false);
    expect(outcome.detail).toBe('2 veto(es) declined to block');
  });

  it('treats a throwing veto as a veto and names the error', async () => {
    const outcome = await runPromotionVetoes({
      vetoes: [
        () => {
          throw new Error('policy service unreachable');
        },
      ],
      nomination: NOMINATION,
    });
    expect(outcome.vetoed).toBe(true);
    expect(outcome.results[0]?.reason).toContain('policy service unreachable');
  });

  it('treats a hung veto as a veto rather than hanging the run', async () => {
    const started = Date.now();
    const outcome = await runPromotionVetoes({
      vetoes: [() => new Promise<boolean>(() => {})],
      nomination: NOMINATION,
      timeoutMs: 20,
    });
    expect(outcome.vetoed).toBe(true);
    expect(outcome.results[0]?.reason).toContain('did not settle within 20ms');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('hands the veto a signal that aborts on the deadline', async () => {
    let observed: AbortSignal | undefined;
    await runPromotionVetoes({
      vetoes: [
        (_nomination, signal) => {
          observed = signal;
          return new Promise<boolean>(() => {});
        },
      ],
      nomination: NOMINATION,
      timeoutMs: 10,
    });
    expect(observed?.aborted).toBe(true);
  });

  it('leaves no abort listener on the run signal after many races', async () => {
    const controller = new AbortController();
    const before = getEventListeners(controller.signal, 'abort').length;
    for (let round = 0; round < 25; round++) {
      await runPromotionVetoes({
        vetoes: [() => false, () => ({ vetoed: false })],
        nomination: NOMINATION,
        signal: controller.signal,
      });
    }
    // One listener per veto per candidate would accumulate over a real run.
    expect(getEventListeners(controller.signal, 'abort').length).toBe(before);
  });

  it('records an in-flight abort as a veto and detaches its listener', async () => {
    const controller = new AbortController();
    const outcome = runPromotionVetoes({
      vetoes: [() => new Promise<boolean>(() => {})],
      nomination: NOMINATION,
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    controller.abort(new Error('run aborted'));
    const settled = await outcome;
    expect(settled.vetoed).toBe(true);
    expect(settled.results[0]?.reason).toContain('aborted');
    expect(getEventListeners(controller.signal, 'abort').length).toBe(0);
  });
});

// --- option validation -----------------------------------------------------

describe('promotion authority validation', () => {
  it.each([
    [
      'a blank resourceId',
      { authority: authorityOf(), resourceId: '  ' },
      /non-empty, host-grantable identity/,
    ],
    [
      'no authorize callback',
      { authority: { grants: [grantOf()] } as any, resourceId: RESOURCE_ID },
      /must be an AxAuthorityContext/,
    ],
    [
      'an authority with no grants',
      { authority: authorityOf({ grants: [] }), resourceId: RESOURCE_ID },
      /every promotion would be denied with no_matching_grant/,
    ],
  ])('refuses %s before any evaluation', (_label, config, pattern) => {
    try {
      validatePromotionAuthority(config as any);
      expect.unreachable('validation should have refused');
    } catch (error) {
      expect(axIsAgentPlaybookEvolveError(error)).toBe(true);
      expect((error as { code: string }).code).toBe(
        'promotion_authority_invalid'
      );
      expect((error as Error).message).toMatch(pattern);
    }
  });

  it('accepts a host-grantable identity', () => {
    expect(() =>
      validatePromotionAuthority({
        authority: authorityOf(),
        resourceId: RESOURCE_ID,
      })
    ).not.toThrow();
    expect(() => validatePromotionAuthority(undefined)).not.toThrow();
  });
});

// --- the authority call ----------------------------------------------------

describe('promotion authority', () => {
  it('promotes on a real pre-issued grant bound to resourceId', async () => {
    const seen: { resourceId?: string; operation?: string } = {};
    const outcome = await requestPromotionAuthority({
      promotionAuthority: {
        authority: authorityOf({
          authorize: (operation, context) => {
            seen.operation = operation;
            seen.resourceId = context.resource.id;
            return echoReceipt(operation, context);
          },
        }),
        resourceId: RESOURCE_ID,
      },
      nomination: NOMINATION,
    });
    expect(outcome.status).toBe('promoted');
    expect(outcome.status === 'promoted' && outcome.receipt.resource.id).toBe(
      RESOURCE_ID
    );
    // The GRANT binds the playbook. The per-candidate digest is receipt
    // metadata and is never what `axAuthorize` was asked about.
    expect(seen.resourceId).toBe(RESOURCE_ID);
    expect(seen.resourceId).not.toBe(NOMINATION.promotionDigest);
    expect(seen.operation).toBe(PROMOTE_OPERATION);
  });

  it('denies a digest-shaped resourceId with no_matching_grant', async () => {
    // The regression guard: binding `resource.id` to a per-candidate value
    // cannot be reintroduced without this going red, because no host can
    // pre-grant the digest of a candidate that does not exist yet.
    const outcome = await requestPromotionAuthority({
      promotionAuthority: {
        authority: authorityOf(),
        resourceId: 'fnv1a64:9d3c0f11aa22bb33',
      },
      nomination: { ...NOMINATION, resourceId: 'fnv1a64:9d3c0f11aa22bb33' },
    });
    expect(outcome).toMatchObject({
      status: 'denied',
      code: 'no_matching_grant',
    });
  });

  it('maps a host deny, a guard failure and a cancellation to their own codes', async () => {
    const denied = await requestPromotionAuthority({
      promotionAuthority: {
        authority: authorityOf({
          authorize: (operation, context) =>
            echoReceipt(operation, context, { decision: 'deny' }),
        }),
        resourceId: RESOURCE_ID,
      },
      nomination: NOMINATION,
    });
    expect(denied).toMatchObject({ status: 'denied', code: 'host_denied' });

    const guarded = await requestPromotionAuthority({
      promotionAuthority: {
        authority: authorityOf({
          grants: [
            grantOf({
              requirements: [
                {
                  kind: 'session.mfa',
                  trustedSources: ['idp'],
                  match: { op: 'eq', value: true },
                },
              ],
            }),
          ],
        }),
        resourceId: RESOURCE_ID,
      },
      nomination: NOMINATION,
    });
    // Folding this into `host_denied` would report a host decision that never
    // happened: the guard runs BEFORE the authorizer is called.
    expect(guarded).toMatchObject({
      status: 'denied',
      code: 'guard_predicate_failed',
    });

    const controller = new AbortController();
    controller.abort(new Error('run aborted'));
    const cancelled = await requestPromotionAuthority({
      promotionAuthority: { authority: authorityOf(), resourceId: RESOURCE_ID },
      nomination: NOMINATION,
      signal: controller.signal,
    });
    expect(cancelled).toMatchObject({ status: 'denied', code: 'cancelled' });
  });

  it('denies a receipt bound to some other resource', async () => {
    const outcome = await requestPromotionAuthority({
      promotionAuthority: {
        authority: authorityOf({
          authorize: (operation, context) =>
            echoReceipt(operation, context, {
              resource: { type: CANDIDATE_TYPE, id: 'someone-elses-playbook' },
            }),
        }),
        resourceId: RESOURCE_ID,
      },
      nomination: NOMINATION,
    });
    expect(outcome).toMatchObject({
      status: 'denied',
      code: 'invalid_receipt',
    });
  });

  it('throws rather than reporting a denial when the authority yields nothing', async () => {
    // A supplied authority that produces no receipt is a configuration bug.
    // Reporting it as `denied` would say a host refused this candidate when no
    // host was ever asked.
    await expect(
      requestPromotionAuthority({
        promotionAuthority: {
          authority: undefined as unknown as AxAuthorityContext,
          resourceId: RESOURCE_ID,
        },
        nomination: NOMINATION,
      })
    ).rejects.toThrow(/axAuthorize produced no receipt/);
  });

  it('leaves no abort listener behind', async () => {
    const controller = new AbortController();
    const before = getEventListeners(controller.signal, 'abort').length;
    for (let round = 0; round < 25; round++) {
      await requestPromotionAuthority({
        promotionAuthority: {
          authority: authorityOf(),
          resourceId: RESOURCE_ID,
        },
        nomination: NOMINATION,
        signal: controller.signal,
      });
    }
    expect(getEventListeners(controller.signal, 'abort').length).toBe(before);
  });
});

// --- folding the two channels ---------------------------------------------

describe('promotion record', () => {
  const receipt = {
    version: 1 as const,
    receiptId: 'r',
    requestId: 'q',
    decision: 'allow' as const,
    operation: PROMOTE_OPERATION,
    resource: { type: CANDIDATE_TYPE, id: RESOURCE_ID },
    principalId: 'principal-a',
    actor: { id: 'actor-a', kind: 'agent' as const },
    grantIds: ['grant-1'],
    leaseEpoch: 3,
    authorizedAt: NOW,
  };

  it('never promotes a candidate the free gates did not nominate', () => {
    expect(
      promotionRecordOf({
        nomination: { ...NOMINATION, nominated: false },
        vetoes: [],
        authority: { status: 'promoted', receipt },
        authorityConfigured: true,
      }).status
    ).toBe('not_nominated');
  });

  it('a veto beats an allow receipt', () => {
    // A veto can only ever REJECT; there is no ordering in which it causes a
    // promotion, and an authorizer that said yes cannot overturn it.
    expect(
      promotionRecordOf({
        nomination: NOMINATION,
        vetoes: [{ vetoId: 'v', vetoed: true }],
        authority: { status: 'promoted', receipt },
        authorityConfigured: true,
      }).status
    ).toBe('vetoed');
  });

  it('a declining veto alone never produces a promoted record', () => {
    const record = promotionRecordOf({
      nomination: NOMINATION,
      vetoes: [{ vetoId: 'v', vetoed: false }],
      authorityConfigured: false,
    });
    expect(record.status).toBe('not_required');
  });

  it('refuses to fabricate a status when a configured authority never answered', () => {
    // Unreachable through the gate chain — gate 9 always runs once the free
    // gates pass — so this pins the invariant rather than a code path. The old
    // fallback reported `not_nominated` for a candidate the free gates DID
    // nominate, which is a falsehood a reader would have trusted.
    let thrown: unknown;
    try {
      promotionRecordOf({
        nomination: NOMINATION,
        vetoes: [{ vetoId: 'v', vetoed: false }],
        authorityConfigured: true,
      });
    } catch (error) {
      thrown = error;
    }
    expect(axIsAgentPlaybookEvolveError(thrown)).toBe(true);
    expect((thrown as any).code).toBe('promotion_authority_invalid');
    expect((thrown as Error).message).toContain('no authority outcome');
  });

  it('promotes only on an un-vetoed nomination with an allow receipt', () => {
    const record = promotionRecordOf({
      nomination: NOMINATION,
      vetoes: [{ vetoId: 'v', vetoed: false }],
      authority: { status: 'promoted', receipt },
      authorityConfigured: true,
    });
    expect(record).toMatchObject({ status: 'promoted', receipt });
    expect(
      promotionRecordOf({
        nomination: NOMINATION,
        vetoes: [],
        authority: { status: 'denied', code: 'host_denied', reason: 'no' },
        authorityConfigured: true,
      })
    ).toMatchObject({ status: 'denied', code: 'host_denied' });
  });
});

// --- the host-callback conformance kit ------------------------------------

describe('runAxAgentPlaybookEvidenceConformance', () => {
  it('reports which capabilities it actually covered', async () => {
    const empty = await runAxAgentPlaybookEvidenceConformance({});
    expect(empty).toEqual({ assertions: 0, capability: [] });
  });

  const conformanceAuthority = (
    override: Partial<AxAuthorityContext> = {}
  ): AxAuthorityContext =>
    authorityOf({
      grants: [
        grantOf({
          operations: [axPlaybookEvidenceConformanceOperation],
          resources: [axPlaybookEvidenceConformanceResource],
        }),
      ],
      ...override,
    });

  it('accepts a conforming classifier, probe, veto and authorizer', async () => {
    const outcome = await runAxAgentPlaybookEvidenceConformance({
      classifier: (args) =>
        args.errorName === 'AxAIServiceStatusError'
          ? { kind: 'environment_failure', cause: 'provider_unavailable' }
          : undefined,
      reachProbe: (args) =>
        args.candidateBulletIds.length === 0
          ? { applicableAtDecidingStep: false, invocations: 0 }
          : { applicableAtDecidingStep: true, invocations: 2 },
      veto: () => false,
      authority: conformanceAuthority(),
    });
    expect(outcome.capability).toEqual([
      'classifier',
      'reachProbe',
      'veto',
      'authority',
    ]);
    expect(outcome.assertions).toBeGreaterThan(8);
  });

  it('rejects a classifier that throws instead of returning undefined', async () => {
    await expect(
      runAxAgentPlaybookEvidenceConformance({
        classifier: () => {
          throw new Error('unhandled shape');
        },
      })
    ).rejects.toThrow(/must RETURN UNDEFINED/);
  });

  it('rejects an impure classifier', async () => {
    let seen = 0;
    await expect(
      runAxAgentPlaybookEvidenceConformance({
        classifier: () =>
          seen++ === 0
            ? { kind: 'environment_failure', cause: 'network' }
            : undefined,
      })
    ).rejects.toThrow(/must return undefined for an input it does not/);
  });

  it('rejects a classifier that writes into the frozen task it is handed', async () => {
    await expect(
      runAxAgentPlaybookEvidenceConformance({
        classifier: (args) => {
          // A deep-frozen argument turns this into a TypeError. Reporting it as
          // "the classifier threw on an unrecognized input" would send a host to
          // fix a totality bug it does not have.
          (args.task as { id: string }).id = 'stamped';
          return undefined;
        },
      })
    ).rejects.toThrow(/mutated its input/);
  });

  it('rejects a classifier that mutates whenever the input is writable', async () => {
    await expect(
      runAxAgentPlaybookEvidenceConformance({
        classifier: (args) => {
          try {
            (args.task as { id: string }).id = 'stamped';
          } catch {
            // A host that stamps bookkeeping defensively writes only where it
            // can — which is precisely the case a same-reference comparison
            // could never catch.
          }
          return undefined;
        },
      })
    ).rejects.toThrow(/mutated its input/);
  });

  it('accepts a veto that throws, because a throw is a fail-closed answer', async () => {
    // `promotion.ts` reads a throwing veto as a veto and names the error. A kit
    // that reported it as "returned undefined" would tell a host whose policy
    // engine throws to fix a non-bug.
    const outcome = await runAxAgentPlaybookEvidenceConformance({
      veto: () => {
        throw new Error('PolicyDenied');
      },
    });
    expect(outcome.capability).toEqual(['veto']);
    expect(outcome.assertions).toBeGreaterThan(0);
  });

  it('rejects a veto that leaves an abort listener on the run signal', async () => {
    await expect(
      runAxAgentPlaybookEvidenceConformance({
        veto: (_nomination, signal) => {
          signal?.addEventListener('abort', () => {});
          return false;
        },
      })
    ).rejects.toThrow(/abort listener\(s\) attached to a signal that never/);
  });

  it('accepts a veto that removes the listener it attached', async () => {
    const outcome = await runAxAgentPlaybookEvidenceConformance({
      veto: (_nomination, signal) => {
        const onAbort = () => {};
        signal?.addEventListener('abort', onAbort);
        signal?.removeEventListener('abort', onAbort);
        return false;
      },
    });
    expect(outcome.capability).toEqual(['veto']);
  });

  it('rejects a classifier that discards a completed run', async () => {
    await expect(
      runAxAgentPlaybookEvidenceConformance({
        classifier: (args) =>
          args.prediction
            ? { kind: 'environment_failure', cause: 'host_declared' }
            : undefined,
      })
    ).rejects.toThrow(/discarding a completed run removes real evidence/);
  });

  it('rejects a probe that claims reach with no candidate bullet', async () => {
    await expect(
      runAxAgentPlaybookEvidenceConformance({
        reachProbe: () => ({ applicableAtDecidingStep: true, invocations: 1 }),
      })
    ).rejects.toThrow(/exactly what the reach gate exists to refute/);
  });

  it('rejects a probe with a non-integer invocation count', async () => {
    await expect(
      runAxAgentPlaybookEvidenceConformance({
        reachProbe: (args) => ({
          applicableAtDecidingStep: args.candidateBulletIds.length > 0,
          invocations: 1.5,
        }),
      })
    ).rejects.toThrow(/non-negative safe integer/);
  });

  it('rejects the forgotten return: undefined is a veto, not an allow', async () => {
    await expect(
      runAxAgentPlaybookEvidenceConformance({
        veto: () => undefined as unknown as boolean,
      })
    ).rejects.toThrow(/reads as a VETO/);
  });

  it('rejects a veto that ignores its signal', async () => {
    await expect(
      runAxAgentPlaybookEvidenceConformance({
        veto: (_nomination, signal) =>
          signal?.aborted
            ? new Promise<boolean>(() => {})
            : new Promise<boolean>(() => {}),
      })
    ).rejects.toThrow(/did not settle within 250ms/);
  });

  it('rejects an authorizer that does not echo its request', async () => {
    await expect(
      runAxAgentPlaybookEvidenceConformance({
        authority: conformanceAuthority({
          authorize: (operation, context) =>
            echoReceipt(operation, context, { requestId: 'invented' }),
        }),
      })
    ).rejects.toThrow(/axAuthorize refused the conformance request/);
  });

  it('says so when the grant does not name the conformance resource', async () => {
    await expect(
      runAxAgentPlaybookEvidenceConformance({
        authority: authorityOf({
          grants: [
            grantOf({
              resources: [{ type: CANDIDATE_TYPE, id: 'some-other-playbook' }],
            }),
          ],
        }),
      })
    ).rejects.toThrow(/testing no echo at all/);
  });
});
