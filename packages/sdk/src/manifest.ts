import * as z from 'zod/mini';

const localized = z.object({ de: z.string().check(z.minLength(1)), en: z.string().check(z.minLength(1)) });

export const pluginCategories = [
  'virtualization',
  'network',
  'router',
  'backup',
  'dns-edge',
  'container',
  'smart-home',
  'monitoring',
  'channel',
] as const;

/** `manifest.json` of a plugin: data only, readable without loading any plugin code (ADR 0003). */
export const pluginManifest = z.object({
  id: z.string().check(z.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/), z.maxLength(40)),
  name: localized,
  description: localized,
  version: z.string().check(z.regex(/^\d+\.\d+\.\d+$/)),
  core: z.string().check(z.minLength(1)),
  icon: z.string().check(z.minLength(1)),
  category: z.enum(pluginCategories),
  multiInstance: z.boolean(),
  docs: z.optional(z.string()),
});

export type PluginManifest = z.infer<typeof pluginManifest>;
export type LocalizedText = z.infer<typeof localized>;
