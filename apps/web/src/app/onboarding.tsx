import {
  catalogResponse,
  type InstanceResponse,
  instanceListResponse,
  instanceResponse,
  queryKeys,
  type TestResultResponse,
  testResultResponse,
} from '@rxf/contracts';
import type { ConfigFormProps, PluginConfig, TlsCertificate, WebPlugin } from '@rxf/web-sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ComponentType, lazy, Suspense, useCallback, useMemo, useState } from 'react';
import type * as z from 'zod/mini';
import { getJson, sendJson } from '../api.ts';
import { formatDateTime, hasMessage, t } from '../i18n.ts';
import { loadWebPlugin } from '../plugins.ts';
import { errorText } from '../ui/errors.ts';
import { Field, FormError } from '../ui/Field.tsx';
import { useElevated } from '../ui/reauth.tsx';
import ui from '../ui/ui.module.css';
import styles from './onboarding.module.css';

type Plugin = z.infer<typeof catalogResponse>['plugins'][number];
type Step = 'catalog' | 'connect' | 'test';
const STEPS: Step[] = ['catalog', 'connect', 'test'];
const STEP_LABEL = {
  catalog: 'onboarding.stepCatalog',
  connect: 'onboarding.stepConnect',
  test: 'onboarding.stepTest',
} as const;

function Steps({ current }: { current: Step }) {
  const index = STEPS.indexOf(current);
  return (
    <nav aria-label={t('onboarding.progress')}>
      <p className={ui.muted}>{t('onboarding.step', { n: index + 1, total: STEPS.length })}</p>
      <ol className={styles.steps}>
        {STEPS.map((step, i) => (
          <li key={step} className={styles.stepItem} data-state={i < index ? 'done' : i === index ? 'current' : 'next'}>
            <span aria-current={i === index ? 'step' : undefined}>{t(STEP_LABEL[step])}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Catalog({ onChoose }: { onChoose: (plugin: Plugin) => void }) {
  const catalog = useQuery({
    queryKey: queryKeys.catalog,
    queryFn: () => getJson('/api/plugins/catalog', catalogResponse),
  });
  const instances = useQuery({
    queryKey: queryKeys.instances,
    queryFn: () => getJson('/api/instances', instanceListResponse),
  });
  if (!catalog.data || !instances.data) return <p className={ui.muted}>{t('app.loading')}</p>;
  const used = new Set(instances.data.instances.map((instance) => instance.pluginId));
  return (
    <ul className={styles.catalog}>
      {catalog.data.plugins.map((plugin) => {
        const taken = !plugin.multiInstance && used.has(plugin.id);
        return (
          <li key={plugin.id} className={ui.card}>
            <h2 className={ui.cardTitle}>{plugin.name.de}</h2>
            <p className={ui.muted}>{plugin.description.de}</p>
            <div className={ui.actions}>
              {taken ? <span className={ui.muted}>{t('onboarding.exists')}</span> : null}
              <button
                type="button"
                className={`${ui.btn} ${ui.primary}`}
                disabled={taken}
                aria-label={t('onboarding.choose', { name: plugin.name.de })}
                onClick={() => onChoose(plugin)}
              >
                {t('onboarding.stepCatalog')}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const lazyForms = new Map<string, ComponentType<ConfigFormProps>>();

function configFormOf(pluginId: string, web: WebPlugin) {
  const load = web.onboarding?.configForm;
  if (!load) return null;
  let form = lazyForms.get(pluginId);
  if (!form) {
    form = lazy(load);
    lazyForms.set(pluginId, form);
  }
  return form;
}

function Certificate({
  certificate,
  onTrust,
  busy,
}: {
  certificate: TlsCertificate;
  onTrust?: () => void;
  busy: boolean;
}) {
  return (
    <section className={`${ui.callout} ${styles.cert}`} aria-labelledby={`cert-${certificate.leafSha256}`}>
      <h3 id={`cert-${certificate.leafSha256}`} className={styles.certTitle}>
        {t('onboarding.certTitle', { origin: certificate.origin })}
      </h3>
      <p>{t('onboarding.certIntro')}</p>
      <dl className={styles.certFacts}>
        <dt>{t('onboarding.certSubject')}</dt>
        <dd>{certificate.subjectAltName ?? certificate.subject}</dd>
        <dt>{t('onboarding.certIssuer')}</dt>
        <dd>{certificate.issuer}</dd>
        <dt>{t('onboarding.certValid')}</dt>
        <dd>
          {Number.isNaN(Date.parse(certificate.validTo))
            ? certificate.validTo
            : formatDateTime(Date.parse(certificate.validTo))}
        </dd>
        <dt>{t('onboarding.certFingerprint')}</dt>
        <dd className={styles.fingerprint}>{certificate.leafSha256.replace(/(..)(?=.)/g, '$1:')}</dd>
      </dl>
      {onTrust ? (
        <div className={ui.actions}>
          <button type="button" className={`${ui.btn} ${ui.outline}`} disabled={busy} onClick={onTrust}>
            {t('onboarding.trust')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function Results({ result }: { result: TestResultResponse }) {
  return (
    <section aria-labelledby="results-title" className={styles.results}>
      <h2 id="results-title" className={ui.cardTitle}>
        {t('onboarding.results')}
      </h2>
      <p className={`${ui.callout} ${result.ok ? ui.ok : ui.crit}`} role="status">
        {result.ok ? t('onboarding.testOk') : t('onboarding.testFailed')}
      </p>
      <ul className={styles.caps}>
        {result.capabilities.map((capability) => {
          const label = `onboarding.cap.${capability.status}`;
          return (
            <li key={capability.id} className={styles.cap} data-status={capability.status}>
              <span className={styles.capStatus}>{hasMessage(label) ? t(label) : capability.status}</span>
              <span className={styles.capId}>{capability.id.replace(/^check:/, '')}</span>
              <span className={ui.muted}>{capability.message ?? capability.code ?? ''}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Onboarding assistant (ADR 0003): choose a plugin, fill its form, save the draft (secrets and targets need
 * a re-authentication), run `test()`, trust a self-signed certificate if needed, then activate.
 */
export function OnboardingPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const elevated = useElevated();
  const [step, setStep] = useState<Step>('catalog');
  const [plugin, setPlugin] = useState<Plugin | null>(null);
  const [name, setName] = useState('');
  const [config, setConfig] = useState<{ value: PluginConfig; valid: boolean }>({ value: {}, valid: false });
  const [draft, setDraft] = useState<InstanceResponse | null>(null);
  const [result, setResult] = useState<TestResultResponse | null>(null);

  const web = useQuery({
    queryKey: ['web-plugin', plugin?.id],
    queryFn: () => loadWebPlugin(plugin?.id as string),
    enabled: plugin !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const Form = useMemo(() => (plugin && web.data ? configFormOf(plugin.id, web.data) : null), [plugin, web.data]);
  const onConfig = useCallback((value: PluginConfig, valid: boolean) => setConfig({ value, valid }), []);

  /** Saves the draft (create or update) and runs the connection test on it. */
  const save = useMutation({
    mutationFn: async (value: PluginConfig) => {
      if (!plugin) throw new Error('no plugin chosen');
      const saved = await elevated(() =>
        draft
          ? sendJson('PATCH', `/api/instances/${draft.id}`, instanceResponse, { name, config: value })
          : sendJson('POST', '/api/instances', instanceResponse, { pluginId: plugin.id, name, config: value }),
      );
      if (!saved) return null;
      setDraft(saved);
      setConfig({ value, valid: true });
      return sendJson('POST', `/api/instances/${saved.id}/test`, testResultResponse);
    },
    onSuccess: (tested) => {
      if (!tested) return;
      setResult(tested);
      setStep('test');
    },
  });

  const activate = useMutation({
    mutationFn: () => sendJson('POST', `/api/instances/${draft?.id}/activate`, instanceResponse),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.instances });
      await navigate({ to: '/' });
    },
  });

  const trust = web.data?.onboarding?.trustCertificate;

  return (
    <>
      <h1>{t('onboarding.title')}</h1>
      <Steps current={step} />
      {step === 'catalog' ? (
        <Catalog
          onChoose={(chosen) => {
            setPlugin(chosen);
            setName(chosen.name.de);
            setStep('connect');
          }}
        />
      ) : null}

      {step === 'connect' && plugin ? (
        <form
          className={`${ui.card} ${ui.form}`}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(config.value);
          }}
        >
          <h2 className={ui.cardTitle}>{plugin.name.de}</h2>
          <FormError message={save.isError ? errorText(save.error) : null} />
          <Field label={t('onboarding.name')} value={name} onChange={(event) => setName(event.target.value)} required />
          {web.isPending ? <p className={ui.muted}>{t('app.loading')}</p> : null}
          {web.data !== undefined && !Form ? <p className={ui.muted}>{t('onboarding.noForm')}</p> : null}
          {Form ? (
            <Suspense fallback={<p className={ui.muted}>{t('app.loading')}</p>}>
              <Form value={draft?.config ?? null} onChange={onConfig} locale="de" />
            </Suspense>
          ) : null}
          <div className={ui.actions}>
            <button
              type="button"
              className={`${ui.btn} ${ui.ghost}`}
              onClick={() => setStep('catalog')}
              disabled={draft !== null}
            >
              {t('onboarding.back')}
            </button>
            <button
              type="submit"
              className={`${ui.btn} ${ui.primary}`}
              disabled={!Form || !config.valid || name.trim() === '' || save.isPending}
            >
              {t('onboarding.save')}
            </button>
          </div>
        </form>
      ) : null}

      {step === 'test' && result ? (
        <div className={ui.card}>
          <Results result={result} />
          <FormError
            message={save.isError ? errorText(save.error) : activate.isError ? errorText(activate.error) : null}
          />
          {result.tls?.map((certificate) => (
            <Certificate
              key={certificate.leafSha256}
              certificate={certificate}
              busy={save.isPending}
              {...(trust ? { onTrust: () => save.mutate(trust(config.value, certificate)) } : {})}
            />
          ))}
          <div className={ui.actions}>
            <button type="button" className={`${ui.btn} ${ui.ghost}`} onClick={() => setStep('connect')}>
              {t('onboarding.back')}
            </button>
            <button
              type="button"
              className={`${ui.btn} ${ui.primary}`}
              disabled={!result.ok || activate.isPending}
              onClick={() => activate.mutate()}
            >
              {t('onboarding.activate')}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
