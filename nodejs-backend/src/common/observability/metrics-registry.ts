/**
 * Minimal in-process metrics registry rendering the Prometheus text exposition
 * format (version 0.0.4). It intentionally has no runtime dependency: the CRM
 * only needs counters, histograms and pull-based gauges, and keeping the
 * implementation local makes the cardinality guard rails explicit.
 */

export type MetricLabels = Readonly<Record<string, string | number>>;

export interface MetricDefinition {
  readonly name: string;
  readonly help: string;
  /** Label names in a fixed order; unknown labels are ignored on record. */
  readonly labelNames?: readonly string[];
}

export interface HistogramDefinition extends MetricDefinition {
  /** Upper bounds in seconds (or the metric's own unit), ascending. */
  readonly buckets?: readonly number[];
}

export interface Counter {
  inc(labels?: MetricLabels, value?: number): void;
}

export interface Histogram {
  observe(value: number, labels?: MetricLabels): void;
}

export interface GaugeSample {
  readonly value: number;
  readonly labels?: MetricLabels;
}

export interface MetricsRegistry {
  counter(definition: MetricDefinition): Counter;
  histogram(definition: HistogramDefinition): Histogram;
  /** Registers a pull-based gauge collected at scrape time. */
  registerGauge(definition: MetricDefinition, collect: () => number | readonly GaugeSample[]): void;
  /** Renders every metric in Prometheus text exposition format. */
  render(): string;
  /** Drops all recorded samples, keeping registrations. Intended for tests. */
  reset(): void;
}

export interface MetricsRegistryOptions {
  /**
   * Hard cap on distinct label combinations per metric. Extra series collapse
   * into a single `__overflow__` series so a hostile or buggy caller can never
   * grow the registry without bound.
   */
  readonly maxSeriesPerMetric?: number;
}

export const DEFAULT_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

const DEFAULT_MAX_SERIES_PER_METRIC = 1_000;
const OVERFLOW_LABEL_VALUE = '__overflow__';

const escapeLabelValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

const escapeHelp = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

/** Serialises a label set into a stable, comparable key. */
const serialiseLabels = (labelNames: readonly string[], labels: MetricLabels | undefined): string =>
  labelNames.map((name) => String(labels?.[name] ?? '')).join('\u0000');

const deserialiseLabels = (labelNames: readonly string[], key: string): readonly string[] =>
  key === '' && labelNames.length === 0 ? [] : key.split('\u0000');

const renderLabels = (labelNames: readonly string[], values: readonly string[]): string => {
  if (labelNames.length === 0) return '';

  const pairs = labelNames.map(
    (name, index) => `${name}="${escapeLabelValue(values[index] ?? '')}"`,
  );

  return `{${pairs.join(',')}}`;
};

const renderExtraLabels = (
  labelNames: readonly string[],
  values: readonly string[],
  extraName: string,
  extraValue: string,
): string => {
  const pairs = labelNames.map(
    (name, index) => `${name}="${escapeLabelValue(values[index] ?? '')}"`,
  );
  pairs.push(`${extraName}="${escapeLabelValue(extraValue)}"`);

  return `{${pairs.join(',')}}`;
};

/** Prometheus expects `+Inf`, and plain `Number.toString` is fine otherwise. */
const formatNumber = (value: number): string => {
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  if (Number.isNaN(value)) return 'NaN';

  return String(value);
};

interface CounterState {
  readonly kind: 'counter';
  readonly definition: MetricDefinition;
  readonly labelNames: readonly string[];
  readonly values: Map<string, number>;
}

interface HistogramSeries {
  readonly counts: number[];
  sum: number;
  count: number;
}

interface HistogramState {
  readonly kind: 'histogram';
  readonly definition: MetricDefinition;
  readonly labelNames: readonly string[];
  readonly buckets: readonly number[];
  readonly series: Map<string, HistogramSeries>;
}

interface GaugeState {
  readonly kind: 'gauge';
  readonly definition: MetricDefinition;
  readonly labelNames: readonly string[];
  readonly collect: () => number | readonly GaugeSample[];
}

type MetricState = CounterState | HistogramState | GaugeState;

export const createMetricsRegistry = (options: MetricsRegistryOptions = {}): MetricsRegistry => {
  const maxSeriesPerMetric = options.maxSeriesPerMetric ?? DEFAULT_MAX_SERIES_PER_METRIC;
  const metrics = new Map<string, MetricState>();

  const assertUnique = (name: string, kind: MetricState['kind']): void => {
    const existing = metrics.get(name);
    if (existing && existing.kind !== kind) {
      throw new Error(`Metric "${name}" is already registered as a ${existing.kind}`);
    }
  };

  /**
   * Resolves the series key for a label set, collapsing everything beyond the
   * configured cap into one overflow series.
   */
  const resolveKey = (
    labelNames: readonly string[],
    labels: MetricLabels | undefined,
    existing: ReadonlyMap<string, unknown>,
  ): string => {
    const key = serialiseLabels(labelNames, labels);
    if (existing.has(key) || existing.size < maxSeriesPerMetric) return key;

    return labelNames.map(() => OVERFLOW_LABEL_VALUE).join('\u0000');
  };

  const counter = (definition: MetricDefinition): Counter => {
    assertUnique(definition.name, 'counter');
    const labelNames = definition.labelNames ?? [];
    const existing = metrics.get(definition.name);
    const state: CounterState =
      existing?.kind === 'counter'
        ? existing
        : { kind: 'counter', definition, labelNames, values: new Map<string, number>() };

    metrics.set(definition.name, state);

    return {
      inc(labels, value = 1): void {
        if (!Number.isFinite(value) || value < 0) return;

        const key = resolveKey(state.labelNames, labels, state.values);
        state.values.set(key, (state.values.get(key) ?? 0) + value);
      },
    };
  };

  const histogram = (definition: HistogramDefinition): Histogram => {
    assertUnique(definition.name, 'histogram');
    const labelNames = definition.labelNames ?? [];
    const buckets = [...(definition.buckets ?? DEFAULT_DURATION_BUCKETS)].sort((a, b) => a - b);
    const existing = metrics.get(definition.name);
    const state: HistogramState =
      existing?.kind === 'histogram'
        ? existing
        : {
            kind: 'histogram',
            definition,
            labelNames,
            buckets,
            series: new Map<string, HistogramSeries>(),
          };

    metrics.set(definition.name, state);

    return {
      observe(value, labels): void {
        if (!Number.isFinite(value)) return;

        const key = resolveKey(state.labelNames, labels, state.series);
        let series = state.series.get(key);

        if (!series) {
          series = { counts: state.buckets.map(() => 0), sum: 0, count: 0 };
          state.series.set(key, series);
        }

        series.sum += value;
        series.count += 1;

        for (let index = 0; index < state.buckets.length; index += 1) {
          const bound = state.buckets[index];
          if (bound !== undefined && value <= bound) {
            series.counts[index] = (series.counts[index] ?? 0) + 1;
          }
        }
      },
    };
  };

  const registerGauge = (
    definition: MetricDefinition,
    collect: () => number | readonly GaugeSample[],
  ): void => {
    assertUnique(definition.name, 'gauge');
    metrics.set(definition.name, {
      kind: 'gauge',
      definition,
      labelNames: definition.labelNames ?? [],
      collect,
    });
  };

  const renderCounter = (state: CounterState, lines: string[]): void => {
    for (const [key, value] of state.values) {
      const labels = renderLabels(state.labelNames, deserialiseLabels(state.labelNames, key));
      lines.push(`${state.definition.name}${labels} ${formatNumber(value)}`);
    }
  };

  const renderHistogram = (state: HistogramState, lines: string[]): void => {
    for (const [key, series] of state.series) {
      const values = deserialiseLabels(state.labelNames, key);

      for (let index = 0; index < state.buckets.length; index += 1) {
        // Bucket counters are already cumulative: an observation increments
        // every bucket whose upper bound it fits into.
        const cumulative = series.counts[index] ?? 0;
        const bound = state.buckets[index] ?? Number.POSITIVE_INFINITY;
        const labels = renderExtraLabels(state.labelNames, values, 'le', formatNumber(bound));
        lines.push(`${state.definition.name}_bucket${labels} ${formatNumber(cumulative)}`);
      }

      const infLabels = renderExtraLabels(state.labelNames, values, 'le', '+Inf');
      lines.push(`${state.definition.name}_bucket${infLabels} ${formatNumber(series.count)}`);

      const plainLabels = renderLabels(state.labelNames, values);
      lines.push(`${state.definition.name}_sum${plainLabels} ${formatNumber(series.sum)}`);
      lines.push(`${state.definition.name}_count${plainLabels} ${formatNumber(series.count)}`);
    }
  };

  const renderGauge = (state: GaugeState, lines: string[]): void => {
    let collected: number | readonly GaugeSample[];

    try {
      collected = state.collect();
    } catch {
      // A broken collector must never break the whole scrape.
      return;
    }

    const samples: readonly GaugeSample[] =
      typeof collected === 'number' ? [{ value: collected }] : collected;

    for (const sample of samples) {
      if (!Number.isFinite(sample.value)) continue;

      const values = state.labelNames.map((name) => String(sample.labels?.[name] ?? ''));
      const labels = renderLabels(state.labelNames, values);
      lines.push(`${state.definition.name}${labels} ${formatNumber(sample.value)}`);
    }
  };

  const render = (): string => {
    const lines: string[] = [];

    for (const state of metrics.values()) {
      lines.push(`# HELP ${state.definition.name} ${escapeHelp(state.definition.help)}`);
      lines.push(`# TYPE ${state.definition.name} ${state.kind}`);

      if (state.kind === 'counter') renderCounter(state, lines);
      else if (state.kind === 'histogram') renderHistogram(state, lines);
      else renderGauge(state, lines);
    }

    return `${lines.join('\n')}\n`;
  };

  const reset = (): void => {
    for (const state of metrics.values()) {
      if (state.kind === 'counter') state.values.clear();
      else if (state.kind === 'histogram') state.series.clear();
    }
  };

  return { counter, histogram, registerGauge, render, reset };
};

/**
 * Registers a small, always-safe set of process gauges. No secrets and no
 * per-request cardinality, so it is cheap to expose everywhere.
 */
export const registerProcessMetrics = (registry: MetricsRegistry): void => {
  registry.registerGauge(
    { name: 'process_uptime_seconds', help: 'Process uptime in seconds.' },
    () => process.uptime(),
  );
  registry.registerGauge(
    {
      name: 'process_resident_memory_bytes',
      help: 'Resident set size of the process in bytes.',
    },
    () => process.memoryUsage().rss,
  );
  registry.registerGauge(
    {
      name: 'nodejs_heap_used_bytes',
      help: 'V8 heap actually used by the process in bytes.',
    },
    () => process.memoryUsage().heapUsed,
  );
};
