/**
 * Proves the bundle isolation of ADR 0003 on the built web app (run after `pnpm build`, part of `pnpm size`):
 * 1. every plugin with a `./web` export is a dynamic entry in its own `plugin-<id>-*` chunk;
 * 2. no plugin module is reachable from the entry chunk through static imports;
 * 3. every `plugin-*` chunk stays within 60 KB gzip.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
}

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'apps/web/dist');
const PLUGIN_CHUNK_LIMIT = 60 * 1024;

const manifest = JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf8')) as Record<string, ManifestChunk>;
const problems: string[] = [];

const [entryKey] = Object.entries(manifest).find(([, chunk]) => chunk.isEntry) ?? [];
if (!entryKey) throw new Error('the Vite manifest has no entry chunk');

const staticClosure = new Set<string>();
const visit = (key: string) => {
  if (staticClosure.has(key)) return;
  staticClosure.add(key);
  for (const next of manifest[key]?.imports ?? []) visit(next);
};
visit(entryKey);
for (const key of staticClosure) {
  if (key.includes('packages/plugins/') || manifest[key]?.file.includes('/plugin-')) {
    problems.push(`${key} is statically reachable from the entry chunk`);
  }
}

const pluginsDir = join(root, 'packages/plugins');
for (const id of readdirSync(pluginsDir)) {
  const pkg = JSON.parse(readFileSync(join(pluginsDir, id, 'package.json'), 'utf8'));
  if (!pkg.exports?.['./web']) continue;
  const key = `../../packages/plugins/${id}/web/index.ts`;
  const chunk = manifest[key];
  if (!chunk?.isDynamicEntry) problems.push(`${key} is not a dynamic entry`);
  else if (!chunk.file.startsWith(`assets/plugin-${id}-`)) problems.push(`${key} landed in ${chunk.file}`);
}

const assets = join(dist, 'assets');
const sizes = readdirSync(assets)
  .filter((file) => file.startsWith('plugin-') && file.endsWith('.js'))
  .map((file) => ({ file, bytes: gzipSync(readFileSync(join(assets, file))).length }));
for (const { file, bytes } of sizes) {
  if (bytes > PLUGIN_CHUNK_LIMIT) problems.push(`${file} is ${(bytes / 1024).toFixed(1)} KB gzip (limit 60 KB)`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
const largest = sizes.reduce((max, s) => Math.max(max, s.bytes), 0);
console.log(
  `plugin isolation ok: ${sizes.length} plugin chunks, largest ${(largest / 1024).toFixed(1)} KB gzip, none reachable from the entry`,
);
