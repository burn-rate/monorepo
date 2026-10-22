import type { IngestStats, NormalizedSample } from '@burn-rate/api-schema';
import type { NormalizedRingSummary } from '../credit/types';
import { detectFormat } from './detect';
import { mapHealthExporter, type HealthExporterPayload, type MapResult } from './health-exporter';
import { mapMetricsExport, type MetricsExportPayload } from './metrics-export';

export interface IngestResult extends IngestStats {
  samples: NormalizedSample[];
  ringSummaries: NormalizedRingSummary[];
}

/**
 * Full mapping pipeline: detect the format, select the mapper, map and filter
 * to normalized samples attributed to `userId`. Unknown metrics are dropped
 * (counted in the stats) rather than stored.
 */
export function mapPayload(body: unknown, dumpKey: string, userId: string): IngestResult {
  const format = detectFormat(body);

  let result: MapResult;
  let received: number;

  switch (format) {
    case 'health-exporter-v1': {
      const payload = body as HealthExporterPayload;
      result = mapHealthExporter(payload, dumpKey, userId);
      received = payload.samples?.length ?? 0;
      break;
    }
    case 'metrics-v1': {
      const payload = body as MetricsExportPayload;
      result = mapMetricsExport(payload, dumpKey, userId);
      received = (payload.data.metrics ?? []).reduce((sum, m) => sum + (m.data?.length ?? 0), 0);
      break;
    }
    case 'unknown':
      return { format, received: 0, mapped: 0, dropped: 0, droppedBy: {}, samples: [], ringSummaries: [] };
  }

  return {
    format,
    received,
    mapped: result.samples.length,
    dropped: result.drops.total,
    droppedBy: result.drops.toRecord(),
    samples: result.samples,
    ringSummaries: result.ringSummaries ?? []
  };
}
