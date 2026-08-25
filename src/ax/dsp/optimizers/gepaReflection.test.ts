import { describe, expect, it } from 'vitest';
import { AxMockAIService } from '../../ai/mock/api.js';
import {
  proposeGEPAComponentValue,
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
    const failures: Array<{ kind: string; message: string }> = [];
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
      onFailure: (failure) => failures.push(failure),
    });

    expect(proposed).toBe('good_value');
    expect(seenPrompts[1]).toContain('must be snake_case');
    expect(failures).toEqual([
      { kind: 'validator', message: 'must be snake_case' },
    ]);
  });
});
