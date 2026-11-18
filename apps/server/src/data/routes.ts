import {
  entityListResponse,
  entityQuery,
  metricPointsQuery,
  metricPointsResponse,
  metricSeriesListResponse,
  metricSeriesQuery,
} from '@rxf/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod/mini';
import type { DatabaseHandle } from '../db/database.ts';
import { metricSeries } from '../db/schema.ts';
import { AppError } from '../http/errors.ts';
import type { EntityStore } from './entities.ts';
import { queryPoints, RETENTION } from './metrics.ts';

export interface DataRouteDeps {
  database: DatabaseHandle;
  entities: EntityStore;
  now: () => number;
}

const DAY = 24 * 60 * 60_000;
const seriesParams = z.object({ id: z.string().check(z.regex(/^\d{1,15}$/)) });

/** Read API for widgets (ADR 0003: widgets read only through the core). Every role may read. */
export function registerDataRoutes(app: FastifyInstance, deps: DataRouteDeps): void {
  const { database, entities, now } = deps;
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    '/api/entities',
    {
      config: { auth: { role: 'viewer' } },
      schema: { querystring: entityQuery, response: { 200: entityListResponse } },
    },
    async (request) => ({ entities: entities.list(request.query) }),
  );

  api.get(
    '/api/metrics/series',
    {
      config: { auth: { role: 'viewer' } },
      schema: { querystring: metricSeriesQuery, response: { 200: metricSeriesListResponse } },
    },
    async (request) => ({
      series: database.db
        .select()
        .from(metricSeries)
        .where(eq(metricSeries.entityId, Number(request.query.entityId)))
        .orderBy(metricSeries.name)
        .all(),
    }),
  );

  api.get(
    '/api/metrics/series/:id/points',
    {
      config: { auth: { role: 'viewer' } },
      schema: { params: seriesParams, querystring: metricPointsQuery, response: { 200: metricPointsResponse } },
    },
    async (request) => {
      const seriesId = Number(request.params.id);
      const to = request.query.to === undefined ? now() : Number(request.query.to);
      const from = request.query.from === undefined ? to - DAY : Number(request.query.from);
      if (from >= to || to - from > RETENTION.hourMs) {
        throw new AppError(400, 'INVALID_RANGE', 'The time range is empty or longer than the retention');
      }
      const exists = database.db
        .select({ id: metricSeries.id })
        .from(metricSeries)
        .where(eq(metricSeries.id, seriesId))
        .get();
      if (!exists) throw new AppError(404, 'SERIES_NOT_FOUND', 'There is no such series');
      return { seriesId, ...queryPoints(database.sqlite, seriesId, from, to) };
    },
  );
}
