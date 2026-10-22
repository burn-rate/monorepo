import { describe, expect, it } from 'vitest';
import { mapPayload } from '../src/ingest';
import healthExporterFixture from './fixtures/health-exporter-v1.json';
import metricsFixture from './fixtures/metrics-v1.json';

describe('mapPayload userId attribution', () => {
  it('stamps health-exporter samples with the provided userId', () => {
    const result = mapPayload(healthExporterFixture, 'test-dump-key', 'user-abc');
    expect(result.samples.length).toBeGreaterThan(0);
    expect(result.samples.every((sample) => sample.userId === 'user-abc')).toBe(true);
  });

  it('threads the userId through the metrics-v1 mapper too', () => {
    const result = mapPayload(metricsFixture, 'test-dump-key', 'user-abc');
    expect(result.samples.length).toBeGreaterThan(0);
    expect(result.samples.every((sample) => sample.userId === 'user-abc')).toBe(true);
  });

  it('keeps the legacy default user when the hook passes it explicitly', () => {
    const result = mapPayload(healthExporterFixture, 'test-dump-key', 'default');
    expect(result.samples.length).toBeGreaterThan(0);
    expect(result.samples.every((sample) => sample.userId === 'default')).toBe(true);
  });
});
