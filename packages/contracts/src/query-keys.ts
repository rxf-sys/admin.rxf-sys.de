/**
 * Query keys shared by the web shell and plugin widgets (ADR 0007). Stream events invalidate by prefix:
 * `entities` → `['entities', instanceId]`, `metrics` → `['metrics']`, `instance` → `['instances']`.
 */
export const queryKeys = {
  instances: ['instances'] as const,
  catalog: ['catalog'] as const,
  entities: (instanceId: string, kind = 'all') => ['entities', instanceId, kind] as const,
  metricSeries: (entityId: number) => ['metrics', 'series', entityId] as const,
  metricPoints: (seriesId: number, from: number, to: number) => ['metrics', 'points', seriesId, from, to] as const,
};
