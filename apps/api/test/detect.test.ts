import { describe, expect, it } from 'vitest';
import { detectFormat } from '../src/ingest/detect';
import healthExporterFixture from './fixtures/health-exporter-v1.json';
import metricsFixture from './fixtures/metrics-v1.json';

describe('detectFormat', () => {
  it('detects health-exporter.v1 payloads', () => {
    expect(detectFormat(healthExporterFixture)).toBe('health-exporter-v1');
  });

  it('detects metrics-v1 payloads', () => {
    expect(detectFormat(metricsFixture)).toBe('metrics-v1');
  });

  it('returns unknown for non-matching shapes', () => {
    expect(detectFormat({ big: 'a'.repeat(100) })).toBe('unknown');
    expect(detectFormat({ schemaVersion: 'other', samples: [] })).toBe('unknown');
    expect(detectFormat({ data: { metrics: 'nope' } })).toBe('unknown');
  });

  it('returns unknown for non-object bodies', () => {
    expect(detectFormat(null)).toBe('unknown');
    expect(detectFormat('raw text')).toBe('unknown');
    expect(detectFormat(42)).toBe('unknown');
  });
});
