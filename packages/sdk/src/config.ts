import * as z from 'zod/mini';
import type { LocalizedText } from './manifest.ts';

export interface FieldMeta {
  label: LocalizedText;
  help?: LocalizedText;
  /** Stored encrypted in `secrets`, never returned by the API (ADR 0006). */
  secret?: boolean;
  /** Only admins may change it, with a fresh re-authentication: hosts, ports, URLs (ADR 0008, T8). */
  adminOnly?: boolean;
}

export interface FieldSpec<S extends z.ZodMiniType = z.ZodMiniType> extends FieldMeta {
  schema: S;
}

export function field<S extends z.ZodMiniType>(schema: S, meta: FieldMeta): FieldSpec<S> {
  return { schema, ...meta };
}

type Shape<F extends Record<string, FieldSpec>> = { [K in keyof F]: F[K]['schema'] };

export interface ConfigDefinition<F extends Record<string, FieldSpec> = Record<string, FieldSpec>> {
  fields: F;
  schema: z.ZodMiniObject<Shape<F>>;
}

/** Builds the config object schema from field specs; the specs also drive the generated form. */
export function defineConfig<F extends Record<string, FieldSpec>>(fields: F): ConfigDefinition<F> {
  const shape = Object.fromEntries(Object.entries(fields).map(([name, spec]) => [name, spec.schema])) as Shape<F>;
  return { fields, schema: z.object(shape) };
}

export type ConfigOf<D extends ConfigDefinition> = z.infer<D['schema']>;

/** Names of the fields that are secrets. Secret fields are top-level strings. */
export function secretFieldNames(definition: ConfigDefinition): string[] {
  return Object.entries(definition.fields)
    .filter(([, spec]) => spec.secret)
    .map(([name]) => name);
}

export function adminOnlyFieldNames(definition: ConfigDefinition): string[] {
  return Object.entries(definition.fields)
    .filter(([, spec]) => spec.adminOnly)
    .map(([name]) => name);
}
