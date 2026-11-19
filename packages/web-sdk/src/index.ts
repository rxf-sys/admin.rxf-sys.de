import type {
  EntityKind,
  EntityResponse,
  MetricPointsResponse,
  MetricSeriesListResponse,
  TestResultResponse,
} from '@rxf/contracts';
import type { ComponentType } from 'react';

/**
 * Web contract of a plugin (ADR 0003). The web build bundles it from source only, so it carries no runtime
 * code beyond `defineWebPlugin`; widgets and forms are lazy modules that become their own chunks.
 */

export type Locale = 'de' | 'en';
export type LocalizedText = Readonly<Record<Locale, string>>;
export type WidgetSize = 'S' | 'M' | 'L' | 'XL';

/** Widgets read through the core API only, never from the device (ADR 0003). */
export interface DataAccess {
  entities(instanceId: string, kind?: EntityKind): Promise<EntityResponse[]>;
  series(entityId: number): Promise<MetricSeriesListResponse['series']>;
  points(seriesId: number, range: { from: number; to: number }): Promise<MetricPointsResponse>;
}

export interface WidgetProps {
  instanceId: string;
  size: WidgetSize;
  data: DataAccess;
  locale: Locale;
}

export interface WidgetDefinition {
  title: LocalizedText;
  sizes: readonly WidgetSize[];
  component: () => Promise<{ default: ComponentType<WidgetProps> }>;
}

export type PluginConfig = Record<string, unknown>;
export type TlsCertificate = NonNullable<TestResultResponse['tls']>[number];

export interface ConfigFormProps {
  /** The stored config of a draft being edited, or null for a new instance. */
  value: PluginConfig | null;
  /** Called on every edit; `valid` decides whether the core lets the person continue. */
  onChange(config: PluginConfig, valid: boolean): void;
  locale: Locale;
}

export interface WebPlugin {
  id: string;
  widgets: Readonly<Record<string, WidgetDefinition>>;
  onboarding?: {
    configForm: () => Promise<{ default: ComponentType<ConfigFormProps> }>;
    /** Pins a certificate the admin confirmed after `test()` (ADR 0008, trust on first use). */
    trustCertificate?(config: PluginConfig, certificate: TlsCertificate): PluginConfig;
  };
}

export function defineWebPlugin(plugin: WebPlugin): WebPlugin {
  return plugin;
}
