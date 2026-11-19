import type { ConfigFormProps, PluginConfig } from '@rxf/web-sdk';
import { useEffect, useId, useState } from 'react';
import { EXPECTED_STATUS_PATTERN } from '../shared/status.ts';
import { translator } from './i18n.ts';
import styles from './uptime.module.css';

interface CheckRow {
  /** Fields the form does not edit (TLS mode, pin, timeout) are carried over unchanged. */
  rest: Record<string, unknown>;
  name: string;
  url: string;
  method: 'GET' | 'HEAD';
  expectedStatus: string;
}

interface FormState {
  checks: CheckRow[];
  slowThresholdMs: number;
  allowBlockedTargets: boolean;
}

const emptyRow = (): CheckRow => ({ rest: {}, name: '', url: '', method: 'GET', expectedStatus: '' });

function fromConfig(value: PluginConfig | null): FormState {
  const checks = Array.isArray(value?.checks) ? (value.checks as Record<string, unknown>[]) : [];
  return {
    checks:
      checks.length > 0
        ? checks.map(({ name, url, method, expectedStatus, ...rest }) => ({
            rest,
            name: typeof name === 'string' ? name : '',
            url: typeof url === 'string' ? url : '',
            method: method === 'HEAD' ? 'HEAD' : 'GET',
            expectedStatus: typeof expectedStatus === 'string' ? expectedStatus : '',
          }))
        : [emptyRow()],
    slowThresholdMs: typeof value?.slowThresholdMs === 'number' ? value.slowThresholdMs : 800,
    allowBlockedTargets: value?.allowBlockedTargets === true,
  };
}

function toConfig(state: FormState): PluginConfig {
  return {
    checks: state.checks.map((row) => ({
      ...row.rest,
      name: row.name.trim(),
      url: row.url.trim(),
      method: row.method,
      ...(row.expectedStatus.trim() ? { expectedStatus: row.expectedStatus.trim() } : {}),
    })),
    slowThresholdMs: state.slowThresholdMs,
    allowBlockedTargets: state.allowBlockedTargets,
  };
}

type RowErrors = Partial<Record<'name' | 'url' | 'expectedStatus', string>>;

/** Mirrors the plugin's config schema closely enough to guide; the server validates for real. */
function validate(state: FormState, t: ReturnType<typeof translator>): { rows: RowErrors[]; form: string | null } {
  const names = state.checks.map((row) => row.name.trim());
  const rows = state.checks.map((row, i) => {
    const errors: RowErrors = {};
    const name = names[i] as string;
    if (name === '' || names.indexOf(name) !== i) errors.name = t('form.errorName');
    const url = row.url.trim();
    if (!/^https?:\/\//.test(url) || !URL.canParse(url)) errors.url = t('form.errorUrl');
    if (row.expectedStatus.trim() && !EXPECTED_STATUS_PATTERN.test(row.expectedStatus.trim())) {
      errors.expectedStatus = t('form.errorExpected');
    }
    return errors;
  });
  return { rows, form: state.checks.length === 0 ? t('form.errorNone') : null };
}

export default function UptimeConfigForm({ value, onChange, locale }: ConfigFormProps) {
  const t = translator(locale);
  const id = useId();
  const [state, setState] = useState(() => fromConfig(value));
  const [touched, setTouched] = useState(false);
  const errors = validate(state, t);
  const valid = errors.form === null && errors.rows.every((row) => Object.keys(row).length === 0);

  useEffect(() => {
    onChange(toConfig(state), valid);
  }, [state, valid, onChange]);

  const update = (index: number, patch: Partial<CheckRow>) => {
    setTouched(true);
    setState((s) => ({ ...s, checks: s.checks.map((row, i) => (i === index ? { ...row, ...patch } : row)) }));
  };
  const error = (index: number, field: keyof RowErrors) => (touched ? errors.rows[index]?.[field] : undefined);

  return (
    <div className={styles.form}>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('form.checks')}</legend>
        <p className={styles.help}>{t('form.checksHelp')}</p>
        {state.checks.map((row, index) => {
          const n = index + 1;
          const base = `${id}-${index}`;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until they are saved
            <fieldset key={index} className={styles.check}>
              <legend className={styles.checkLegend}>{t('form.check', { n })}</legend>
              <TextField
                id={`${base}-name`}
                label={t('form.name')}
                value={row.name}
                error={error(index, 'name')}
                onChange={(name) => update(index, { name })}
              />
              <TextField
                id={`${base}-url`}
                label={t('form.url')}
                value={row.url}
                error={error(index, 'url')}
                type="url"
                placeholder="https://"
                onChange={(url) => update(index, { url })}
              />
              <div className={styles.field}>
                <label className={styles.label} htmlFor={`${base}-method`}>
                  {t('form.method')}
                </label>
                <select
                  id={`${base}-method`}
                  className={styles.input}
                  value={row.method}
                  onChange={(event) => update(index, { method: event.target.value === 'HEAD' ? 'HEAD' : 'GET' })}
                >
                  <option value="GET">GET</option>
                  <option value="HEAD">HEAD</option>
                </select>
              </div>
              <TextField
                id={`${base}-expected`}
                label={t('form.expected')}
                hint={t('form.expectedHelp')}
                value={row.expectedStatus}
                error={error(index, 'expectedStatus')}
                placeholder="200-399,401,403,405"
                onChange={(expectedStatus) => update(index, { expectedStatus })}
              />
              <button
                type="button"
                className={styles.remove}
                aria-label={t('form.remove', { n })}
                disabled={state.checks.length === 1}
                onClick={() => {
                  setTouched(true);
                  setState((s) => ({ ...s, checks: s.checks.filter((_, i) => i !== index) }));
                }}
              >
                ×
              </button>
            </fieldset>
          );
        })}
        <button
          type="button"
          className={styles.add}
          onClick={() => setState((s) => ({ ...s, checks: [...s.checks, emptyRow()] }))}
        >
          {t('form.add')}
        </button>
      </fieldset>
      <TextField
        id={`${id}-slow`}
        label={t('form.slow')}
        type="number"
        value={String(state.slowThresholdMs)}
        onChange={(raw) => setState((s) => ({ ...s, slowThresholdMs: Math.max(50, Math.round(Number(raw) || 0)) }))}
      />
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={state.allowBlockedTargets}
          onChange={(event) => setState((s) => ({ ...s, allowBlockedTargets: event.target.checked }))}
        />
        <span>
          {t('form.allowBlocked')}
          <span className={styles.help}>{t('form.allowBlockedHelp')}</span>
        </span>
      </label>
    </div>
  );
}

function TextField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  hint?: string;
  type?: string;
  placeholder?: string;
}) {
  const described = [props.hint ? `${props.id}-hint` : '', props.error ? `${props.id}-error` : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        className={styles.input}
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={described || undefined}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.hint ? (
        <span id={`${props.id}-hint`} className={styles.help}>
          {props.hint}
        </span>
      ) : null}
      {props.error ? (
        <span id={`${props.id}-error`} className={styles.error}>
          {props.error}
        </span>
      ) : null}
    </div>
  );
}
