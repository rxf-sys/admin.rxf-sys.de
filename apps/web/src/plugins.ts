import { entityListResponse, metricPointsResponse, metricSeriesListResponse } from '@rxf/contracts';
import type { DataAccess, WebPlugin } from '@rxf/web-sdk';
import { getJson } from './api.ts';
import { webPluginRegistry } from './plugins.generated.ts';

const loading = new Map<string, Promise<WebPlugin | null>>();

/** Imports a plugin's web module on first use; plugins without a web part resolve to null. */
export function loadWebPlugin(pluginId: string): Promise<WebPlugin | null> {
  let plugin = loading.get(pluginId);
  if (!plugin) {
    const load = Object.hasOwn(webPluginRegistry, pluginId) ? webPluginRegistry[pluginId] : undefined;
    plugin = load ? load().then((module) => module.default) : Promise.resolve(null);
    loading.set(pluginId, plugin);
  }
  return plugin;
}

/** What widgets may read: the core API, validated against the shared contracts (ADR 0002, 0003). */
export const dataAccess: DataAccess = {
  async entities(instanceId, kind) {
    const query = new URLSearchParams({ instanceId, ...(kind ? { kind } : {}) });
    return (await getJson(`/api/entities?${query}`, entityListResponse)).entities;
  },
  async series(entityId) {
    const query = new URLSearchParams({ entityId: String(entityId) });
    return (await getJson(`/api/metrics/series?${query}`, metricSeriesListResponse)).series;
  },
  points(seriesId, range) {
    const query = new URLSearchParams({ from: String(range.from), to: String(range.to) });
    return getJson(`/api/metrics/series/${seriesId}/points?${query}`, metricPointsResponse);
  },
};
