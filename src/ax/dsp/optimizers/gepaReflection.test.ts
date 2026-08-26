import { describe, expect, it } from 'vitest';
import { AxMockAIService } from '../../ai/mock/api.js';
import {
  proposeGEPAComponentValue,
  renderGEPAOptimizationReferences,
  summarizeGEPATraces,
} from './gepaReflection.js';

describe('GEPA reflection helpers', () => {
  it('summarizes trace rows with bounded previews', () => {
    const summary = summarizeGEPATraces(
      [
        {
          score: 0,
          calls: [
            {
              componentId: 'lookup_user',
              fn: 'lookup_user',
              ok: false,
              ms: 12,
              args: { query: 'x'.repeat(300) },
              result: { error: 'not found' },
            },
          ],
          error: 'failed',
        },
      ],
      { maxValueChars: 80 }
    );

    expect(summary?.[0]?.calls[0]).toMatchObject({
      componentId: 'lookup_user',
      fn: 'lookup_user',
      ok: false,
      ms: 12,
    });
    expect(summary?.[0]?.calls[0]?.args.length).toBeLessThanOrEqual(80);
  });

  it('passes validation errors into retry prompts and accepts a corrected value', async () => {
    const seenPrompts: string[] = [];
    let calls = 0;
    const ai = new AxMockAIService({
      chatResponse: async (req) => {
        seenPrompts.push(JSON.stringify(req.chatPrompt));
        calls++;
        return {
          results: [
            {
              index: 0,
              content:
                calls === 1 ? 'New Value: bad value' : 'New Value: good_value',
              finishReason: 'stop',
            },
          ],
        };
      },
    });

    const proposed = await proposeGEPAComponentValue({
      ai,
      target: {
        id: 'root::fn:lookup:name',
        kind: 'fn-name',
        current: 'lookup',
        format: 'snake_case',
        validate: (value) =>
          value === 'good_value' ? true : 'must be snake_case',
      },
      currentValue: 'lookup',
      tuples: [],
      maxAttempts: 2,
    });

    expect(proposed).toBe('good_value');
    expect(seenPrompts[1]).toContain('must be snake_case');
    expect(seenPrompts[0]).toContain('Do not memorize or copy');
    expect(seenPrompts[0]).toContain('Preserve behavior that already succeeds');
  });

  it('renders trusted optimization references in stable caller order', () => {
    const rendered = renderGEPAOptimizationReferences([
      { name: 'style', content: 'Prefer direct language.' },
      {
        name: 'domain',
        description: 'Domain-wide rules',
        content: 'Dates use ISO-8601.',
      },
    ]);

    expect(rendered).toBe(
      [
        '--- BEGIN TRUSTED OPTIMIZATION REFERENCE 1 ---',
        '{"name":"style"}',
        'Prefer direct language.',
        '--- END TRUSTED OPTIMIZATION REFERENCE 1 ---',
        '',
        '--- BEGIN TRUSTED OPTIMIZATION REFERENCE 2 ---',
        '{"name":"domain","description":"Domain-wide rules"}',
        'Dates use ISO-8601.',
        '--- END TRUSTED OPTIMIZATION REFERENCE 2 ---',
      ].join('\n')
    );
  });

  it('bounds examples and keeps policy guidance separate from component validation', async () => {
    const seen: Array<{
      examples: number;
      guidance?: string;
      references: readonly string[];
      error?: string;
      attempt: number;
    }> = [];
    const proposed = await proposeGEPAComponentValue({
      ai: {} as AxMockAIService,
      target: {
        id: 'root::template',
        kind: 'template',
        current: 'Hello {{name}}',
        preserve: ['{{name}}'],
        maxLength: 24,
      },
      currentValue: 'Hello {{name}}',
      maxAttempts: 3,
      tuples: [
        { input: { value: 'one' }, prediction: {}, score: 0 },
        { input: { value: 'two' }, prediction: {}, score: 0 },
        { input: { value: 'three' }, prediction: {}, score: 0 },
      ],
      proposal: {
        references: [{ name: 'guide', content: 'Use a warm greeting.' }],
        additionalGuidance: 'Keep it concise.',
        maxExamples: 2,
        policy: (args) => {
          seen.push({
            examples: args.reflectiveExamples.length,
            guidance: args.additionalGuidance,
            references: args.references.map((reference) => reference.name),
            error: args.previousValidationError,
            attempt: args.attempt,
          });
          if (args.attempt === 1) {
            return 'Hello there and welcome, {{name}}';
          }
          return args.attempt === 2 ? 'Hello there' : 'Welcome, {{name}}';
        },
      },
    });

    expect(proposed).toBe('Welcome, {{name}}');
    expect(seen).toEqual([
      {
        examples: 2,
        guidance: 'Keep it concise.',
        references: ['guide'],
        error: undefined,
        attempt: 1,
      },
      {
        examples: 2,
        guidance: 'Keep it concise.',
        references: ['guide'],
        error: 'must be at most 24 characters',
        attempt: 2,
      },
      {
        examples: 2,
        guidance: 'Keep it concise.',
        references: ['guide'],
        error: 'must preserve literal {{name}}',
        attempt: 3,
      },
    ]);
  });

  it('returns no change when a custom policy declines to propose', async () => {
    let calls = 0;
    const proposed = await proposeGEPAComponentValue({
      ai: {} as AxMockAIService,
      target: {
        id: 'root::instruction',
        kind: 'instruction',
        current: 'Keep this',
      },
      currentValue: 'Keep this',
      tuples: [],
      proposal: {
        policy: () => {
          calls++;
          return undefined;
        },
      },
    });

    expect(proposed).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('retries the default policy after an empty teacher value', async () => {
    let calls = 0;
    const ai = new AxMockAIService({
      chatResponse: async () => {
        calls++;
        return {
          results: [
            {
              index: 0,
              content: calls === 1 ? 'New Value:   ' : 'New Value: retry_ok',
              finishReason: 'stop',
            },
          ],
        };
      },
    });

    const proposed = await proposeGEPAComponentValue({
      ai,
      target: {
        id: 'root::instruction',
        kind: 'instruction',
        current: 'Keep this',
      },
      currentValue: 'Keep this',
      tuples: [],
      maxAttempts: 2,
    });

    expect(proposed).toBe('retry_ok');
    expect(calls).toBe(2);
  });

  it('passes an empty example list through when maxExamples is 0', async () => {
    let seenExamples: number | undefined;
    const proposed = await proposeGEPAComponentValue({
      ai: {} as AxMockAIService,
      target: {
        id: 'root::instruction',
        kind: 'instruction',
        current: 'Keep this',
      },
      currentValue: 'Keep this',
      tuples: [{ input: { value: 'one' }, prediction: {}, score: 0 }],
      proposal: {
        maxExamples: 0,
        policy: (args) => {
          seenExamples = args.reflectiveExamples.length;
          return 'from references only';
        },
      },
    });

    expect(proposed).toBe('from references only');
    expect(seenExamples).toBe(0);
  });

  it('reaches the built-in teacher when maxExamples is 0', async () => {
    let calls = 0;
    let seenPrompt: string | undefined;
    const ai = new AxMockAIService({
      chatResponse: async (req) => {
        calls++;
        seenPrompt = JSON.stringify(req.chatPrompt);
        return {
          results: [
            {
              index: 0,
              content: 'New Value: from zero examples',
              finishReason: 'stop',
            },
          ],
        };
      },
    });

    const proposed = await proposeGEPAComponentValue({
      ai,
      target: {
        id: 'root::instruction',
        kind: 'instruction',
        current: 'Keep this',
      },
      currentValue: 'Keep this',
      tuples: [
        {
          input: { value: 'secret-training-entity' },
          prediction: {},
          score: 0,
        },
      ],
      proposal: {
        maxExamples: 0,
      },
    });

    expect(proposed).toBe('from zero examples');
    expect(calls).toBe(1);
    expect(seenPrompt).toBeDefined();
    expect(seenPrompt).not.toContain('secret-training-entity');
    expect(seenPrompt).not.toContain(
      "Value for input field 'reflectiveExamples' is required"
    );
  });

  it('records custom-policy exceptions and retries instead of declining', async () => {
    const errors: Array<string | undefined> = [];
    const proposed = await proposeGEPAComponentValue({
      ai: {} as AxMockAIService,
      target: {
        id: 'root::instruction',
        kind: 'instruction',
        current: 'Keep this',
      },
      currentValue: 'Keep this',
      tuples: [],
      maxAttempts: 2,
      proposal: {
        policy: (args) => {
          errors.push(args.previousValidationError);
          if (args.attempt === 1) {
            throw new Error('proposer unavailable');
          }
          return 'recovered proposal';
        },
      },
    });

    expect(proposed).toBe('recovered proposal');
    expect(errors).toEqual([undefined, 'proposer unavailable']);
  });

  it('passes per-example metric feedback into component reflection', async () => {
    let prompt = '';
    const ai = new AxMockAIService({
      chatResponse: async (req) => {
        prompt = JSON.stringify(req.chatPrompt);
        return {
          results: [
            {
              index: 0,
              content: 'New Value: improved',
              finishReason: 'stop',
            },
          ],
        };
      },
    });

    await proposeGEPAComponentValue({
      ai,
      target: { id: 'root::instruction', kind: 'instruction', current: 'base' },
      currentValue: 'base',
      tuples: [
        {
          input: { question: 'q' },
          prediction: { answer: 'a' },
          score: 0.4,
          feedback: 'Ground the answer in the supplied context.',
        },
      ],
    });

    expect(prompt).toContain('Ground the answer in the supplied context.');
  });
});
