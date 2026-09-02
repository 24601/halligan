import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { rankDocuments } from '../src/ax/agent/agentInternal/relevanceRanker.js';
import type { AxAgentCatalogSkill } from '../src/ax/agent/agentInternal/skillsTypes.js';
import type { AxExecutableSkillArtifact } from '../src/ax/agent/executableSkills.js';
import { axSelectExecutableSkills } from '../src/ax/agent/executableSkills.js';
import type {
  AxAgentSkillCostProfile,
  AxAgentVerifierRail,
} from '../src/ax/agent/skillCost.js';
import {
  axApplyVerificationBudget,
  axAttributeSkillCost,
  axDedupeRailDiagnostics,
  axFireVerifierRails,
  axInitialVerificationBudgetState,
  axSkillValueScore,
} from '../src/ax/agent/skillCost.js';
import type {
  AxSkillAuthoritySnapshot,
  AxSkillProvenance,
} from '../src/ax/authority/skillProvenance.js';
import { axExtractSkillProvenance } from '../src/ax/authority/skillProvenance.js';
import { AxACE, AxACEOptimizedProgram } from '../src/ax/dsp/optimizers/ace.js';
import {
  applyCuratorOperations,
  axProjectActorPlaybook,
  axRedactPlaybookForModel,
  axRenderActorPlaybook,
  createEmptyPlaybook,
  createExecutablePlaybookView,
  renderPlaybook,
} from '../src/ax/dsp/optimizers/acePlaybook.js';
import type {
  AxACEBullet,
  AxACEPlaybook,
} from '../src/ax/dsp/optimizers/aceTypes.js';
import { AxPlaybook } from '../src/ax/dsp/playbook.js';
import { ax, f } from '../src/ax/index.js';

/**
 * Deterministic, zero-cost mechanism evaluation. No provider calls, no network,
 * no tokens, no dollars. The fixture is inline and digest-pinned.
 */
const HONESTY = [
  'This is a deterministic mechanism evaluation over an authored fixture. It is',
  'not a held-out model evaluation and makes no claim about answer quality.',
  "C3's token reduction is a property of the fixture's cost profiles, not",
  "evidence that cost-aware ranking improves real workloads. C2's guarantee is",
  'artifact-level: a curator that paraphrases optimizer-tier content produces',
  'actor-visible text, and the evaluation reports that case as unblocked.',
].join(' ');

const NOW = '2026-01-01T00:00:00.000Z';
const LEASE = 5;

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`skill-provenance evaluation failed: ${message}`);
}

function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index++) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

// ---------------------------------------------------------------- fixture ---

type DriftScenario =
  | 'grant_revoked'
  | 'lease_epoch_changed'
  | 'verifier_decision_changed'
  | 'verifier_decision_missing'
  | 'environment_drift'
  | 'effect_unsettled'
  | 'provenance_truncated';

const DRIFT_SCENARIOS: readonly DriftScenario[] = [
  'grant_revoked',
  'lease_epoch_changed',
  'verifier_decision_changed',
  'verifier_decision_missing',
  'environment_drift',
  'effect_unsettled',
  'provenance_truncated',
];

const ARTIFACT_COUNT = 24;

function provenanceFor(
  index: number,
  scenario?: DriftScenario
): AxSkillProvenance {
  return axExtractSkillProvenance({
    effects: [
      {
        id: `effect-${index}`,
        deliveryId: `delivery-${index}`,
        runId: `run-${index}`,
        identityScope: 'scope',
        operation: 'files.read',
        idempotencyKey: `key-${index}`,
        replaySafety: 'idempotent',
        requestDigest: `sha256:digest-${index}`,
        status: scenario === 'effect_unsettled' ? 'parked' : 'succeeded',
        createdAt: index,
        updatedAt: index,
        dispatchCount: 1,
        version: 1,
      },
    ],
    receipts: [
      {
        version: 1,
        receiptId: `receipt-${index}`,
        requestId: `request-${index}`,
        decision: 'allow',
        operation: 'files.read',
        resource: { type: 'file', id: `file-${index}` },
        principalId: 'principal',
        actor: { id: 'actor', kind: 'agent' },
        grantIds: [`grant-${index}`],
        leaseEpoch: LEASE,
        authorizedAt: index,
      },
    ],
    verifierDecisions: [{ verifier: 'policy', verdict: 'allowed' }],
    environment: { sandbox: 'true' },
    leaseEpoch: LEASE,
    capturedAt: NOW,
    ...(scenario === 'provenance_truncated' ? { truncated: true } : {}),
  });
}

/** Current authority, drifted along exactly one axis. */
function snapshotFor(
  index: number,
  scenario?: DriftScenario
): AxSkillAuthoritySnapshot {
  return {
    grantIds: scenario === 'grant_revoked' ? [] : [`grant-${index}`],
    leaseEpoch: scenario === 'lease_epoch_changed' ? LEASE + 1 : LEASE,
    verifierDecisions:
      scenario === 'verifier_decision_missing'
        ? []
        : [
            {
              verifier: 'policy',
              verdict:
                scenario === 'verifier_decision_changed' ? 'parked' : 'allowed',
            },
          ],
    environment: {
      sandbox: scenario === 'environment_drift' ? 'false' : 'true',
    },
  };
}

function executableArtifact(
  index: number,
  provenance: AxSkillProvenance
): AxExecutableSkillArtifact {
  return {
    id: `artifact-${index}`,
    version: '1',
    name: `Artifact ${index}`,
    description: 'A host-owned executable skill artifact',
    functionRef: 'functions/probe/1',
    verification: { mode: 'receiptless' },
    authorityProvenance: provenance,
  };
}

const PROBE_FUNCTION = {
  name: 'probe',
  description: 'probe',
  parameters: { type: 'object' as const, properties: {} },
  func: async () => ({ ok: true }),
};

// ------------------------------------------------------------------- C1 ---

function evaluateRecheck(): Record<string, unknown> {
  let detected = 0;
  let baselineAdmitted = 0;
  let falseParks = 0;
  const durations: number[] = [];

  for (let index = 0; index < ARTIFACT_COUNT; index++) {
    for (const scenario of DRIFT_SCENARIOS) {
      const provenance = provenanceFor(index, scenario);
      const artifact = executableArtifact(index, provenance);
      // Baseline: today's selection has no re-check at all, so it admits every
      // drifted artifact by construction.
      const baseline = axSelectExecutableSkills(
        [artifact],
        {
          admittedArtifacts: [{ id: artifact.id, version: artifact.version }],
          principal: 'principal',
          audience: 'audience',
          now: NOW,
          resolveFunction: () => PROBE_FUNCTION,
        },
        { topK: 1 }
      );
      if (baseline.artifacts.length === 1) baselineAdmitted += 1;

      const started = performance.now();
      const selection = axSelectExecutableSkills(
        [artifact],
        {
          admittedArtifacts: [{ id: artifact.id, version: artifact.version }],
          principal: 'principal',
          audience: 'audience',
          now: NOW,
          authoritySnapshot: snapshotFor(index, scenario),
          resolveFunction: () => PROBE_FUNCTION,
        },
        { topK: 1 }
      );
      durations.push(performance.now() - started);
      if (
        selection.artifacts.length === 0 &&
        selection.inspection[0]?.reasons.includes(
          'provenance_precondition_failed'
        )
      ) {
        detected += 1;
      }
    }

    // Control: an undrifted artifact must still be selected.
    const control = executableArtifact(index, provenanceFor(index));
    const selection = axSelectExecutableSkills(
      [control],
      {
        admittedArtifacts: [{ id: control.id, version: control.version }],
        principal: 'principal',
        audience: 'audience',
        now: NOW,
        authoritySnapshot: snapshotFor(index),
        resolveFunction: () => PROBE_FUNCTION,
      },
      { topK: 1 }
    );
    if (selection.artifacts.length !== 1) falseParks += 1;
  }

  const total = ARTIFACT_COUNT * DRIFT_SCENARIOS.length;
  const meanMs =
    durations.reduce((sum, value) => sum + value, 0) / durations.length;
  assert(detected === total, `drift detection ${detected}/${total}`);
  // The baseline admits every drifted artifact, which is what "0/168 by
  // construction" means: it has no re-check to detect anything with.
  assert(
    baselineAdmitted === total,
    `baseline admitted ${baselineAdmitted}/${total}`
  );
  assert(falseParks === 0, `false parks ${falseParks}/${ARTIFACT_COUNT}`);
  assert(meanMs < 2, `per-artifact overhead ${meanMs}ms exceeds 2ms`);

  return {
    baseline: {
      name: 'axSelectExecutableSkills with no re-check',
      detected: 0,
      admittedDriftedArtifacts: baselineAdmitted,
    },
    detected,
    total,
    falseParks,
    controls: ARTIFACT_COUNT,
    perArtifactMeanMs: Number(meanMs.toFixed(6)),
  };
}

// ------------------------------------------------------------------- C2 ---

function tieredPlaybook(): AxACEPlaybook {
  const playbook = createEmptyPlaybook('Evaluation playbook');
  const bullet = (
    over: Partial<AxACEBullet> & { id: string }
  ): AxACEBullet => ({
    section: 'Guidelines',
    content: `content ${over.id}`,
    helpfulCount: 0,
    harmfulCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
  playbook.sections.Guidelines = Array.from({ length: 12 }, (_unused, index) =>
    bullet({ id: `actor-${index}`, content: `actor visible text ${index}` })
  );
  playbook.sections['Common Pitfalls'] = Array.from(
    { length: 8 },
    (_unused, index) =>
      bullet({
        id: `optimizer-${index}`,
        section: 'Common Pitfalls',
        content: `optimizer only text ${index}`,
        visibility: 'optimizer',
      })
  );
  playbook.sections.Guidelines.push(
    bullet({
      id: 'provenanced',
      content: 'guidance from an authorized trajectory',
      evidence: { authorityProvenance: provenanceFor(0) },
    })
  );
  return playbook;
}

function evaluateVisibility(): Record<string, unknown> {
  const playbook = tieredPlaybook();
  const optimizerBullets = Object.values(playbook.sections)
    .flat()
    .filter((bullet) => bullet.visibility === 'optimizer');
  const contents = optimizerBullets.map((bullet) => bullet.content);
  const ids = optimizerBullets.map((bullet) => bullet.id);

  // Real water through real pipes: each surface is produced by the call site a
  // host actually reaches, not by re-rendering one projection under four names.
  // Rerouting `applyTo` or `composeInstruction` back to `renderPlaybook` has to
  // move these numbers, or the metric is measuring nothing.
  const signature = () =>
    ax(f().input('question', f.string()).output('answer', f.string()).build());

  const applied = signature();
  new AxACEOptimizedProgram({
    bestScore: 1,
    stats: {} as never,
    playbook,
    artifact: { playbook, feedback: [], history: [] },
    baseInstruction: 'base instruction',
  }).applyTo(applied);

  const ace = new AxACE(
    { studentAI: {} as never, teacherAI: {} as never },
    { initialPlaybook: playbook }
  );
  const live = new AxPlaybook(signature(), {
    studentAI: {} as never,
    initialPlaybook: playbook,
  });

  const actorSurfaces: Record<string, string> = {
    projection: axRenderActorPlaybook(
      axProjectActorPlaybook(playbook, { includeInapplicable: true, now: NOW })
    ),
    applyTo: applied.getSignature().getDescription() ?? '',
    composeInstruction: (
      ace as unknown as {
        composeInstruction: (
          base: string,
          playbook: AxACEPlaybook,
          options: Readonly<{ includeInapplicable: boolean; now: string }>
        ) => string;
      }
    ).composeInstruction('base instruction', playbook, {
      includeInapplicable: true,
      now: NOW,
    }),
    playbookRender: live.render({ includeInapplicable: true, now: NOW }),
  };
  for (const [name, surface] of Object.entries(actorSurfaces)) {
    // A renderer that dropped everything would pass every leak assertion.
    assert(
      surface.includes('actor visible text 0'),
      `actor path ${name} rendered no actor guidance`
    );
  }

  let leakedContent = 0;
  for (const surface of Object.values(actorSurfaces)) {
    for (const content of contents) {
      if (surface.includes(content)) leakedContent += 1;
    }
  }
  assert(leakedContent === 0, `actor paths leaked ${leakedContent} contents`);

  const optimizerView = createExecutablePlaybookView(playbook, NOW);
  const optimizerMarkdown = renderPlaybook(optimizerView, {
    includeInapplicable: true,
    now: NOW,
  });
  const optimizerVisible = ids.filter((id) =>
    optimizerMarkdown.includes(id)
  ).length;
  assert(
    optimizerVisible === ids.length,
    `optimizer render lost ${ids.length - optimizerVisible} ids`
  );

  const serialized = JSON.stringify({
    markdown: optimizerMarkdown,
    structured: axRedactPlaybookForModel(optimizerView),
  });
  const provenanceMarkers = ['receipt-0', 'grant-0', 'sha256:digest-0'];
  const leakedIdentifiers = provenanceMarkers.filter((marker) =>
    serialized.includes(marker)
  ).length;
  assert(leakedIdentifiers === 0, 'provenance identifiers reached the model');

  // Laundering: verbatim copy and supersede-swap are blocked; paraphrase is not,
  // and that is reported rather than asserted.
  const copyTarget = tieredPlaybook();
  applyCuratorOperations(copyTarget, [
    {
      type: 'ADD',
      section: 'Guidelines',
      content: 'optimizer only text 0',
    },
  ]);
  const copyBlocked =
    copyTarget.sections.Guidelines?.some(
      (bullet) =>
        bullet.content === 'optimizer only text 0' &&
        bullet.visibility === 'optimizer'
    ) ?? false;

  const supersedeTarget = tieredPlaybook();
  applyCuratorOperations(supersedeTarget, [
    {
      type: 'ADD',
      section: 'Common Pitfalls',
      content: 'a replacement for the diagnostic',
      supersedes: ['optimizer-0'],
    },
  ]);
  const supersedeBlocked =
    supersedeTarget.sections['Common Pitfalls']?.some(
      (bullet) =>
        bullet.content === 'a replacement for the diagnostic' &&
        bullet.visibility === 'optimizer'
    ) ?? false;

  const paraphraseTarget = tieredPlaybook();
  applyCuratorOperations(paraphraseTarget, [
    {
      type: 'ADD',
      section: 'Guidelines',
      content: 'Optimizer-only text zero, restated in the curator words.',
    },
  ]);
  const paraphraseBlocked =
    paraphraseTarget.sections.Guidelines?.some(
      (bullet) =>
        bullet.content.startsWith('Optimizer-only text zero') &&
        bullet.visibility === 'optimizer'
    ) ?? false;

  assert(copyBlocked, 'verbatim copy must inherit the optimizer tier');
  assert(supersedeBlocked, 'supersede-swap must inherit the optimizer tier');

  // Legacy byte identity: a playbook with no new field renders exactly as before.
  const legacy = createEmptyPlaybook('Legacy');
  legacy.sections.Guidelines = [
    {
      id: 'legacy-0',
      section: 'Guidelines',
      content: 'legacy guidance',
      helpfulCount: 0,
      harmfulCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  const legacyIdentical =
    axRenderActorPlaybook(axProjectActorPlaybook(legacy, { now: NOW })) ===
    renderPlaybook(legacy, { now: NOW });
  assert(legacyIdentical, 'legacy render is no longer byte-identical');

  return {
    baseline: {
      name: "today's render, where the tier does not exist",
      structurallyPrevented: false,
    },
    actorPaths: Object.keys(actorSurfaces).length,
    leakedOptimizerContents: leakedContent,
    optimizerVisibleIds: `${optimizerVisible}/${ids.length}`,
    leakedProvenanceIdentifiers: leakedIdentifiers,
    launderingBlocked: `${[copyBlocked, supersedeBlocked].filter(Boolean).length}/2`,
    paraphraseBlocked: `${paraphraseBlocked ? 1 : 0}/1 (known non-guarantee, reported not asserted)`,
    legacyRenderDigest: fnv1a64(renderPlaybook(legacy, { now: NOW })),
    legacyByteIdentical: legacyIdentical,
  };
}

// ------------------------------------------------------------------- C3 ---

const QUERY_COUNT = 40;
/** Queries whose correct skill is deliberately expensive. */
const ADVERSE_QUERIES = new Set([3, 11, 22, 33]);

function catalogFor(index: number): {
  catalog: AxAgentCatalogSkill[];
  profiles: AxAgentSkillCostProfile[];
  correct: string;
  query: string;
} {
  const topic = `topic${index}`;
  const correct = `skill-correct-${index}`;
  const adverse = ADVERSE_QUERIES.has(index);
  const catalog: AxAgentCatalogSkill[] = [
    {
      id: correct,
      name: `Handle ${topic} correctly`,
      description: `The right procedure for ${topic}`,
      content: `Steps for ${topic}. `.repeat(4),
    },
    {
      id: `skill-cheap-${index}`,
      name: `Adjacent ${topic} note`,
      description: `A cheaper but wrong note about ${topic}`,
      content: `Notes on ${topic}. `.repeat(4),
    },
    {
      id: `skill-unprofiled-a-${index}`,
      name: `Background ${topic} reading`,
      description: `Background about ${topic}`,
      content: `Background for ${topic}. `.repeat(4),
    },
    {
      id: `skill-unprofiled-b-${index}`,
      name: `Legacy ${topic} appendix`,
      description: `Legacy appendix for ${topic}`,
      content: `Appendix for ${topic}. `.repeat(4),
    },
  ];
  const profile = (
    id: string,
    uses: number,
    successes: number,
    tokensTotal: number
  ): AxAgentSkillCostProfile => ({
    id,
    loads: uses,
    uses,
    successes,
    tokensTotal,
    wallMsTotal: 0,
    verificationRoundsTotal: 0,
    updatedAt: NOW,
  });
  // Half the catalogs mix profiled and profile-less skills.
  const profiles =
    index % 2 === 0
      ? [
          profile(correct, 10, adverse ? 10 : 9, adverse ? 200_000 : 1000),
          profile(`skill-cheap-${index}`, 10, adverse ? 9 : 3, 500),
        ]
      : [
          profile(correct, 10, adverse ? 10 : 9, adverse ? 200_000 : 1000),
          profile(`skill-cheap-${index}`, 10, adverse ? 9 : 3, 500),
          profile(`skill-unprofiled-a-${index}`, 4, 2, 1500),
          profile(`skill-unprofiled-b-${index}`, 4, 2, 1500),
        ];
  return { catalog, profiles, correct, query: `how do I handle ${topic}` };
}

function similarityRanking(
  query: string,
  catalog: readonly AxAgentCatalogSkill[]
): { id: string; score: number }[] {
  return rankDocuments(
    query,
    catalog.map((skill) => ({
      id: skill.id,
      fields: [
        { text: skill.id, identifier: true },
        { text: skill.name, weight: 2 },
        ...(skill.description ? [{ text: skill.description, weight: 2 }] : []),
        { text: skill.content.slice(0, 600) },
      ],
    })),
    { topK: catalog.length, minScore: 0, marginRatio: 0, minDocs: 1 }
  ).map((entry) => ({ id: entry.id, score: entry.score }));
}

function evaluateRanking(): Record<string, unknown> {
  let similarityTokens = 0;
  let valueTokens = 0;
  let similarityTop1 = 0;
  let valueTop1 = 0;
  let mixedOrderPreserved = 0;
  let mixedCatalogs = 0;
  const adverseDemotions: string[] = [];

  for (let index = 0; index < QUERY_COUNT; index++) {
    const { catalog, profiles, correct, query } = catalogFor(index);
    const profileById = new Map(profiles.map((p) => [p.id, p]));
    const similarity = similarityRanking(query, catalog);
    const value = [...similarity]
      .map((entry) => ({
        id: entry.id,
        score: axSkillValueScore(entry.score, profileById.get(entry.id)),
      }))
      .sort((left, right) => right.score - left.score);

    const tokensOf = (ids: readonly string[]) =>
      ids.reduce((total, id) => {
        const profile = profileById.get(id);
        return (
          total + (profile ? profile.tokensTotal / (profile.uses || 1) : 0)
        );
      }, 0);

    similarityTokens += tokensOf(similarity.slice(0, 3).map((e) => e.id));
    valueTokens += tokensOf(value.slice(0, 3).map((e) => e.id));
    if (similarity[0]?.id === correct) similarityTop1 += 1;
    if (value[0]?.id === correct) valueTop1 += 1;
    if (ADVERSE_QUERIES.has(index) && value[0]?.id !== correct) {
      adverseDemotions.push(query);
    }

    if (index % 2 === 0) {
      mixedCatalogs += 1;
      const unprofiled = ['a', 'b'].map(
        (suffix) => `skill-unprofiled-${suffix}-${index}`
      );
      const bySimilarity = similarity
        .filter((entry) => unprofiled.includes(entry.id))
        .map((entry) => entry.id);
      const byValue = value
        .filter((entry) => unprofiled.includes(entry.id))
        .map((entry) => entry.id);
      if (JSON.stringify(bySimilarity) === JSON.stringify(byValue)) {
        mixedOrderPreserved += 1;
      }
    }
  }

  assert(
    mixedOrderPreserved === mixedCatalogs,
    `profile-less order changed in ${mixedCatalogs - mixedOrderPreserved} mixed catalogs`
  );

  return {
    baseline: { name: 'similarity-only rankDocuments' },
    similarityTop3AttributedTokens: Math.round(similarityTokens),
    valueTop3AttributedTokens: Math.round(valueTokens),
    similarityTop1Correct: similarityTop1,
    valueTop1Correct: valueTop1,
    profilelessOrderPreserved: `${mixedOrderPreserved}/${mixedCatalogs}`,
    adverseQueriesWhereCostDemotedTheCorrectSkill: adverseDemotions.length,
    adverseQueries: adverseDemotions,
    top1Delta: valueTop1 - similarityTop1,
  };
}

// ------------------------------------------------------------------- C4 ---

async function evaluateRails(): Promise<Record<string, unknown>> {
  const rails: AxAgentVerifierRail[] = [
    {
      id: 'novel',
      stage: 'afterToolCall',
      verify: (() => {
        let counter = 0;
        return () => {
          counter += 1;
          return [
            {
              signature: `novel:${counter}`,
              code: 'novel',
              message: 'a fresh signature every call',
              severity: 'info' as const,
            },
          ];
        };
      })(),
    },
    {
      id: 'thrower',
      stage: 'afterToolCall',
      verify: () => {
        throw new Error('rail exploded');
      },
    },
    {
      id: 'hanger',
      stage: 'afterToolCall',
      verify: () => new Promise<never>(() => {}),
    },
  ];

  let state = axInitialVerificationBudgetState();
  const seen = new Set<string>();
  const emitted: string[] = [];
  const budget = { maxRounds: 5, railTimeoutMs: 50 };
  const controller = new AbortController();
  const started = performance.now();

  for (let call = 0; call < 50; call++) {
    await axFireVerifierRails(
      {
        rails,
        budget,
        stage: 'executor',
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        seen,
        emit: (diagnostics) => {
          for (const diagnostic of diagnostics) emitted.push(diagnostic.code);
        },
      },
      {
        stage: 'executor',
        qualifiedName: 'utils.probe',
        name: 'probe',
        args: {},
        result: { ok: true },
        signal: controller.signal,
      }
    );
  }
  const elapsed = performance.now() - started;

  assert(state.rounds === 5, `rounds ${state.rounds}, expected 5`);
  assert(state.status === 'exceeded', 'budget must reach exceeded');
  assert(
    state.disabledRails.includes('thrower') &&
      state.disabledRails.includes('hanger'),
    'both faulty rails must be disabled'
  );
  // Bounded by the deadline, not by the rail: three rounds at most reach the
  // hanging rail before the budget closes.
  assert(
    elapsed < 5 * budget.railTimeoutMs + 2000,
    `rail latency ${elapsed}ms`
  );

  // The dedupe is the load-bearing half.
  const repeat = axDedupeRailDiagnostics(new Set(['x']), [
    { signature: 'x', code: 'c', message: 'm', severity: 'info' },
  ]);
  assert(repeat.novel.length === 0, 'a seen signature must be suppressed');

  // A zero budget is absorbing from the first event.
  const zero = axApplyVerificationBudget(axInitialVerificationBudgetState(), {
    maxRounds: 0,
  });
  assert(zero.status === 'exceeded', 'a zero budget must exceed immediately');

  // Attribution never invents a cost for a skill nobody declared.
  assert(
    axAttributeSkillCost({ declaredUsed: [], tokens: 900, success: true })
      .length === 0,
    'undeclared skills must accrue nothing'
  );

  return {
    baseline: {
      name: 'unbounded rails: no round counter, no per-run diagnostic cap',
      roundsObserved: 'unbounded',
      // Not a reachable production configuration any more: rails with no
      // `verificationBudget` take AX_DEFAULT_VERIFICATION_MAX_ROUNDS.
      reachableWithoutABudget: false,
    },
    toolCalls: 50,
    roundsObserved: state.rounds,
    status: state.status,
    disabledRails: state.disabledRails,
    novelDiagnosticsInjected: emitted.length,
    railWallMs: Number(elapsed.toFixed(3)),
    railTimeoutMs: budget.railTimeoutMs,
  };
}

// --------------------------------------------------------------- digest ---

/**
 * The digest covers the fixture BYTES, not a handful of scalars.
 *
 * Hashing `{artifacts: 24, queries: 40, lease: 5, ...}` would let every
 * provenance record, playbook bullet, catalog entry and cost profile be
 * rewritten without moving the constant — which is exactly the silent rot RFC
 * 8.9 pins the digest against. So this serializes the fixtures the evaluation
 * actually consumes: every artifact and its provenance in every drift scenario
 * with its paired authority snapshot, the tiered playbook, and every ranking
 * catalog with its cost profiles.
 */
export function canonicalFixtureBytes(): string {
  return JSON.stringify({
    now: NOW,
    lease: LEASE,
    scenarios: DRIFT_SCENARIOS,
    adverse: [...ADVERSE_QUERIES].sort((left, right) => left - right),
    artifacts: Array.from({ length: ARTIFACT_COUNT }, (_unused, index) => ({
      control: executableArtifact(index, provenanceFor(index)),
      controlSnapshot: snapshotFor(index),
      drifted: DRIFT_SCENARIOS.map((scenario) => ({
        scenario,
        artifact: executableArtifact(index, provenanceFor(index, scenario)),
        snapshot: snapshotFor(index, scenario),
      })),
    })),
    // `createEmptyPlaybook` stamps a wall-clock `updatedAt`; pin it so the
    // digest is a function of the fixture and nothing else.
    playbook: { ...tieredPlaybook(), updatedAt: NOW },
    catalogs: Array.from({ length: QUERY_COUNT }, (_unused, index) =>
      catalogFor(index)
    ),
  });
}

// ------------------------------------------------------------------ main ---

export async function runSkillProvenanceEvaluation(): Promise<
  Record<string, unknown>
> {
  const fixtureDigest = fnv1a64(canonicalFixtureBytes());
  return {
    honesty: HONESTY,
    budget: {
      providerCalls: 0,
      tokens: 0,
      usd: 0,
      network: 'none',
    },
    fixtureDigest,
    c1RetrievalRecheck: evaluateRecheck(),
    c2OptimizerOnlyVisibility: evaluateVisibility(),
    c3ValueAwareRanking: evaluateRanking(),
    c4VerificationBudgetAndRails: await evaluateRails(),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const report = await runSkillProvenanceEvaluation();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
