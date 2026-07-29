import { describe, expect, it } from '@jest/globals';

import { createMetricsRegistry, registerProcessMetrics } from './metrics-registry.js';

const lines = (rendered: string): string[] => rendered.trim().split('\n');

describe('metrics registry', () => {
  it('renders counters in the Prometheus text format', () => {
    const registry = createMetricsRegistry();
    const counter = registry.counter({
      name: 'jobs_total',
      help: 'Total jobs processed.',
      labelNames: ['queue'],
    });

    counter.inc({ queue: 'email' });
    counter.inc({ queue: 'email' }, 2);
    counter.inc({ queue: 'sms' });

    expect(lines(registry.render())).toEqual([
      '# HELP jobs_total Total jobs processed.',
      '# TYPE jobs_total counter',
      'jobs_total{queue="email"} 3',
      'jobs_total{queue="sms"} 1',
    ]);
  });

  it('renders unlabelled counters', () => {
    const registry = createMetricsRegistry();
    registry.counter({ name: 'ticks_total', help: 'Ticks.' }).inc();

    expect(registry.render()).toContain('ticks_total 1');
  });

  it('ignores negative and non-finite increments', () => {
    const registry = createMetricsRegistry();
    const counter = registry.counter({ name: 'jobs_total', help: 'Jobs.' });

    counter.inc(undefined, -5);
    counter.inc(undefined, Number.NaN);
    counter.inc();

    expect(registry.render()).toContain('jobs_total 1');
  });

  it('escapes label values', () => {
    const registry = createMetricsRegistry();
    registry
      .counter({ name: 'events_total', help: 'Events.', labelNames: ['name'] })
      .inc({ name: 'a"b\\c' });

    expect(registry.render()).toContain('events_total{name="a\\"b\\\\c"} 1');
  });

  it('renders cumulative histogram buckets, sum and count', () => {
    const registry = createMetricsRegistry();
    const histogram = registry.histogram({
      name: 'task_duration_seconds',
      help: 'Task duration.',
      labelNames: ['kind'],
      buckets: [0.1, 1],
    });

    histogram.observe(0.0625, { kind: 'sync' });
    histogram.observe(0.5, { kind: 'sync' });
    histogram.observe(5, { kind: 'sync' });

    const rendered = registry.render();

    expect(rendered).toContain('task_duration_seconds_bucket{kind="sync",le="0.1"} 1');
    expect(rendered).toContain('task_duration_seconds_bucket{kind="sync",le="1"} 2');
    expect(rendered).toContain('task_duration_seconds_bucket{kind="sync",le="+Inf"} 3');
    expect(rendered).toContain('task_duration_seconds_sum{kind="sync"} 5.5625');
    expect(rendered).toContain('task_duration_seconds_count{kind="sync"} 3');
    expect(rendered).toContain('# TYPE task_duration_seconds histogram');
  });

  it('sorts bucket bounds regardless of declaration order', () => {
    const registry = createMetricsRegistry();
    registry.histogram({ name: 'd_seconds', help: 'd', buckets: [1, 0.1, 0.5] }).observe(0.2);

    const rendered = lines(registry.render());

    expect(rendered.slice(2, 5)).toEqual([
      'd_seconds_bucket{le="0.1"} 0',
      'd_seconds_bucket{le="0.5"} 1',
      'd_seconds_bucket{le="1"} 1',
    ]);
  });

  it('collapses excess label combinations into an overflow series', () => {
    const registry = createMetricsRegistry({ maxSeriesPerMetric: 2 });
    const counter = registry.counter({
      name: 'hits_total',
      help: 'Hits.',
      labelNames: ['route'],
    });

    for (let index = 0; index < 50; index += 1) {
      counter.inc({ route: `/r/${String(index)}` });
    }

    const rendered = lines(registry.render()).filter((line) => !line.startsWith('#'));

    expect(rendered).toHaveLength(3);
    expect(rendered).toContain('hits_total{route="__overflow__"} 48');
  });

  it('collects gauges at render time', () => {
    const registry = createMetricsRegistry();
    let current = 1;
    registry.registerGauge({ name: 'queue_depth', help: 'Depth.' }, () => current);

    expect(registry.render()).toContain('queue_depth 1');
    current = 7;
    expect(registry.render()).toContain('queue_depth 7');
  });

  it('supports multi-sample gauges and survives a broken collector', () => {
    const registry = createMetricsRegistry();
    registry.registerGauge({ name: 'pool_size', help: 'Pool.', labelNames: ['pool'] }, () => [
      { value: 3, labels: { pool: 'read' } },
      { value: 5, labels: { pool: 'write' } },
    ]);
    registry.registerGauge({ name: 'broken', help: 'Broken.' }, () => {
      throw new Error('collector failed');
    });

    const rendered = registry.render();

    expect(rendered).toContain('pool_size{pool="read"} 3');
    expect(rendered).toContain('pool_size{pool="write"} 5');
    expect(rendered).toContain('# TYPE broken gauge');
  });

  it('rejects reusing a name with a different metric type', () => {
    const registry = createMetricsRegistry();
    registry.counter({ name: 'shared', help: 'Shared.' });

    expect(() => registry.histogram({ name: 'shared', help: 'Shared.' })).toThrow(
      /already registered as a counter/,
    );
  });

  it('shares state between repeated registrations of the same counter', () => {
    const registry = createMetricsRegistry();
    registry.counter({ name: 'shared_total', help: 'Shared.' }).inc();
    registry.counter({ name: 'shared_total', help: 'Shared.' }).inc();

    expect(registry.render()).toContain('shared_total 2');
  });

  it('drops samples on reset but keeps registrations', () => {
    const registry = createMetricsRegistry();
    registry.counter({ name: 'jobs_total', help: 'Jobs.' }).inc();

    registry.reset();

    expect(registry.render()).toContain('# TYPE jobs_total counter');
    expect(registry.render()).not.toContain('jobs_total 1');
  });

  it('registers process gauges without secrets', () => {
    const registry = createMetricsRegistry();
    registerProcessMetrics(registry);

    const rendered = registry.render();

    expect(rendered).toContain('# TYPE process_uptime_seconds gauge');
    expect(rendered).toContain('# TYPE process_resident_memory_bytes gauge');
    expect(rendered).toContain('# TYPE nodejs_heap_used_bytes gauge');
  });
});
