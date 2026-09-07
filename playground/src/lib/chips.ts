/**
 * Telemetry chips replace disclaimer paragraphs. An engineer reads
 * `[SRC: DETERMINISTIC] [SEED: 7] [CLOCK: MANUAL] [COST: --]` instantly; the
 * same facts as prose read as compliance boilerplate and get skipped.
 *
 * `unmeasured` is a first-class value and renders as an em-dash with a hover
 * explanation. Never `$0.00`, never red: missing is not zero and not an error.
 */
export type ChipTone = 'neutral' | 'machine' | 'ok' | 'warn' | 'danger';

export interface Chip {
  readonly key: string;
  readonly value: string;
  readonly tone?: ChipTone;
  /** Hover/focus explanation. Required when `unmeasured` is set. */
  readonly title?: string;
  readonly unmeasured?: boolean;
}

export const chip = (
  key: string,
  value: string,
  extra: Omit<Chip, 'key' | 'value'> = {}
): Chip => ({ key, value, ...extra });

export const unmeasuredChip = (key: string, why: string): Chip => ({
  key,
  value: '—',
  unmeasured: true,
  title: why,
});
