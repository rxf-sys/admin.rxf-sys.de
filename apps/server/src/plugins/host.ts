import type { PluginManifest, ServerPlugin } from '@rxf/sdk';
import { AppError } from '../http/errors.ts';
import type { RegisteredPlugin } from '../plugins.generated.ts';

/**
 * Knows every plugin from its manifest and imports plugin code only on first use (ADR 0003): the catalog
 * is served from manifests alone, so plugins nobody configured are never loaded.
 */
export class PluginHost {
  readonly #registry: ReadonlyMap<string, RegisteredPlugin>;
  readonly #loaded = new Map<string, Promise<ServerPlugin>>();

  constructor(registry: readonly RegisteredPlugin[]) {
    this.#registry = new Map(registry.map((entry) => [entry.manifest.id, entry]));
  }

  catalog(): PluginManifest[] {
    return [...this.#registry.values()].map((entry) => entry.manifest);
  }

  manifest(id: string): PluginManifest {
    const entry = this.#registry.get(id);
    if (!entry) throw new AppError(404, 'PLUGIN_NOT_FOUND', `There is no plugin "${id}"`);
    return entry.manifest;
  }

  load(id: string): Promise<ServerPlugin> {
    const entry = this.#registry.get(id);
    if (!entry) return Promise.reject(new AppError(404, 'PLUGIN_NOT_FOUND', `There is no plugin "${id}"`));
    let loading = this.#loaded.get(id);
    if (!loading) {
      loading = entry.load().then((module) => module.default);
      this.#loaded.set(id, loading);
    }
    return loading;
  }

  isLoaded(id: string): boolean {
    return this.#loaded.has(id);
  }
}
