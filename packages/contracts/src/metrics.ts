import * as z from 'zod/mini';

export const metricSeries = z.object({
  id: z.number(),
  entityId: z.number(),
  name: z.string(),
  unit: z.string(),
});

export const metricSeriesListResponse = z.object({ series: z.array(metricSeries) });

const integerString = z.string().check(z.regex(/^\d{1,15}$/));

export const metricSeriesQuery = z.object({ entityId: integerString });

/** Unix milliseconds; `to` defaults to now, `from` to 24 h before `to`. */
export const metricPointsQuery = z.object({
  from: z.optional(integerString),
  to: z.optional(integerString),
});

/** Which stored tier answered (ADR 0004): raw ≤ 48 h, 5-minute means ≤ 30 days, hourly means beyond. */
export const metricResolution = z.enum(['raw', '5m', '1h']);

export const metricPointsResponse = z.object({
  seriesId: z.number(),
  resolution: metricResolution,
  /** Width of one point in ms after downsampling to at most ~1,000 points. */
  stepMs: z.number(),
  points: z.array(z.object({ ts: z.number(), avg: z.number(), min: z.number(), max: z.number() })),
});

export type MetricPointsResponse = z.infer<typeof metricPointsResponse>;
export type MetricSeriesListResponse = z.infer<typeof metricSeriesListResponse>;
