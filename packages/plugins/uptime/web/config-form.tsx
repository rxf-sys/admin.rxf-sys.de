import type { ConfigFormProps, PluginConfig } from '@rxf/web-sdk';
import { useEffect, useId, useState } from 'react';
import { looksLikeHost, looksLikeIp } from '../shared/hosts.ts';
import { EXPECTED_STATUS_PATTERN } from '../shared/status.ts';
import { translator } from './i18n.ts';
import styles from './uptime.module.css';

const CHECK_TYPES = ['http', 'tcp', 'icmp', 'dns', 'tls'] as const;
type CheckType = (typeof CHECK_TYPES)[number];
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT'] as const;

/** Text inputs the form edits; numbers are converted when the config is built. */
const VALUE_KEYS = [
  'url',
  'method',
  'expectedStatus',
  'host',
  'port',
  'query',
  'recordType',
  'server',
  'expected',
  'warnDays',
  'intervalS',
] as const;
type ValueKey = (typeof VALUE_KEYS)[number];

interface CheckRow {
  /** Fields the form does not edit (TLS mode, pin, timeout, count) are carried over unchanged. */
  rest: Record<string, unknown>;
  type: CheckType;
  name: string;
  values: Record<ValueKey, string>;
}

interface FormState {
  checks: CheckRow[];
  slowThresholdMs: number;
  allowBlockedTargets: boolean;
}

const emptyValues = (): Record<ValueKey, string> =>
  Object.fromEntries(VALUE_KEYS.map((key) => [key, ''])) as Record<ValueKey, string>;
const emptyRow = (): CheckRow => ({ rest: {}, type: 'http', name: '', values: { ...emptyValues(), method: 'GET' } });

function fromConfig(value: PluginConfig | null): FormState {
  const checks = Array.isArray(value?.checks) ? (value.checks as Record<string, unknown>[]) : [];
  return {
    checks:
      checks.length > 0
        ? checks.map(({ type, name, ...others }) => {
            const values = emptyValues();
            const rest: Record<string, unknown> = {};
            for (const [key, raw] of Object.entries(others)) {
              if (
                (VALUE_KEYS as readonly string[]).includes(key) &&
                (typeof raw === 'string' || typeof raw === 'number')
              ) {
                values[key as ValueKey] = String(raw);
              } else {
                rest[key] = raw;
              }
            }
            if (!values.method) values.method = 'GET';
            return {
              rest,
              type: CHECK_TYPES.includes(type as CheckType) ? (type as CheckType) : 'http',
              name: typeof name === 'string' ? name : '',
              values,
            };
          })
        : [emptyRow()],
    slowThresholdMs: typeof value?.slowThresholdMs === 'number' ? value.slowThresholdMs : 800,
    allowBlockedTargets: value?.allowBlockedTargets === true,
  };
}

/** The keys each type keeps; `type` is left out for HTTP so configs from before Phase 5 stay unchanged. */
const KEYS_BY_TYPE: Record<CheckType, readonly ValueKey[]> = {
  http: ['url', 'method', 'expectedStatus'],
  tcp: ['host', 'port'],
  icmp: ['host'],
  dns: ['query', 'recordType', 'server', 'expected'],
  tls: ['host', 'port', 'warnDays'],
};
const NUMERIC: readonly ValueKey[] = ['port', 'warnDays', 'intervalS'];

function toCheck(row: CheckRow): Record<string, unknown> {
  const check: Record<string, unknown> = { ...row.rest, ...(row.type === 'http' ? {} : { type: row.type }) };
  check.name = row.name.trim();
  for (const key of [...KEYS_BY_TYPE[row.type], 'intervalS' as const]) {
    const raw = row.values[key].trim();
    if (raw === '' && key !== 'url' && key !== 'host' && key !== 'query') continue;
    check[key] = NUMERIC.includes(key) ? Number(raw) : raw;
  }
  return check;
}

function toConfig(state: FormState): PluginConfig {
  return {
    checks: state.checks.map(toCheck),
    slowThresholdMs: state.slowThresholdMs,
    allowBlockedTargets: state.allowBlockedTargets,
  };
}

type RowErrors = Partial<Record<'name' | ValueKey, string>>;

const isIntIn = (raw: string, min: number, max: number) => {
  const n = Number(raw);
  return /^\d+$/.test(raw) && n >= min && n <= max;
};

/** Mirrors the plugin's config schema closely enough to guide; the server validates for real. */
function validate(state: FormState, t: ReturnType<typeof translator>): { rows: RowErrors[]; form: string | null } {
  const names = state.checks.map((row) => row.name.trim());
  const rows = state.checks.map((row, i) => {
    const errors: RowErrors = {};
    const v = Object.fromEntries(VALUE_KEYS.map((key) => [key, row.values[key].trim()])) as Record<ValueKey, string>;
    const name = names[i] as string;
    if (name === '' || names.indexOf(name) !== i) errors.name = t('form.errorName');
    if (row.type === 'http') {
      if (!/^https?:\/\//.test(v.url) || !URL.canParse(v.url)) errors.url = t('form.errorUrl');
      if (v.expectedStatus && !EXPECTED_STATUS_PATTERN.test(v.expectedStatus)) {
        errors.expectedStatus = t('form.errorExpected');
      }
    }
    if ((row.type === 'tcp' || row.type === 'icmp' || row.type === 'tls') && !looksLikeHost(v.host)) {
      errors.host = t('form.errorHost');
    }
    if (row.type === 'tcp' && !isIntIn(v.port, 1, 65_535)) errors.port = t('form.errorPort');
    if (row.type === 'tls' && v.port && !isIntIn(v.port, 1, 65_535)) errors.port = t('form.errorPort');
    if (row.type === 'tls' && v.warnDays && !isIntIn(v.warnDays, 1, 365)) errors.warnDays = t('form.errorDays');
    if (row.type === 'dns') {
      if (!looksLikeHost(v.query)) errors.query = t('form.errorHost');
      if (v.server && !looksLikeIp(v.server)) errors.server = t('form.errorServer');
    }
    if (v.intervalS && !isIntIn(v.intervalS, 10, 3600)) errors.intervalS = t('form.errorInterval');
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

  const update = (
    index: number,
    patch: Partial<Omit<CheckRow, 'values'>> & { values?: Partial<CheckRow['values']> },
  ) => {
    setTouched(true);
    setState((s) => ({
      ...s,
      checks: s.checks.map((row, i) =>
        i === index ? { ...row, ...patch, values: { ...row.values, ...patch.values } } : row,
      ),
    }));
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
          const text = (
            key: ValueKey,
            label: string,
            extra: { hint?: string; placeholder?: string; type?: string } = {},
          ) => (
            <TextField
              id={`${base}-${key}`}
              label={label}
              value={row.values[key]}
              error={error(index, key)}
              {...extra}
              onChange={(value) => update(index, { values: { [key]: value } })}
            />
          );
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
              <SelectField
                id={`${base}-type`}
                label={t('form.type')}
                value={row.type}
                options={CHECK_TYPES.map((type) => [type, t(`type.${type}`)])}
                onChange={(type) => update(index, { type: type as CheckType })}
              />
              {row.type === 'http' ? (
                <>
                  {text('url', t('form.url'), { type: 'url', placeholder: 'https://' })}
                  <SelectField
                    id={`${base}-method`}
                    label={t('form.method')}
                    value={row.values.method === 'HEAD' ? 'HEAD' : 'GET'}
                    options={[
                      ['GET', 'GET'],
                      ['HEAD', 'HEAD'],
                    ]}
                    onChange={(method) => update(index, { values: { method } })}
                  />
                  {text('expectedStatus', t('form.expected'), {
                    hint: t('form.expectedHelp'),
                    placeholder: '200-399,401,403,405',
                  })}
                </>
              ) : null}
              {row.type === 'tcp' || row.type === 'icmp' || row.type === 'tls'
                ? text('host', t('form.host'), { placeholder: 'nas.lan' })
                : null}
              {row.type === 'tcp' ? text('port', t('form.port'), { type: 'number' }) : null}
              {row.type === 'tls' ? (
                <>
                  {text('port', t('form.port'), { type: 'number', placeholder: '443' })}
                  {text('warnDays', t('form.warnDays'), {
                    type: 'number',
                    placeholder: '14',
                    hint: t('form.warnDaysHelp'),
                  })}
                </>
              ) : null}
              {row.type === 'dns' ? (
                <>
                  {text('query', t('form.query'), { placeholder: 'rxf-sys.de' })}
                  <SelectField
                    id={`${base}-recordType`}
                    label={t('form.recordType')}
                    value={row.values.recordType || 'A'}
                    options={RECORD_TYPES.map((type) => [type, type])}
                    onChange={(recordType) => update(index, { values: { recordType } })}
                  />
                  {text('server', t('form.server'), { hint: t('form.serverHelp'), placeholder: '192.168.2.1' })}
                  {text('expected', t('form.dnsExpected'), { hint: t('form.dnsExpectedHelp') })}
                </>
              ) : null}
              {text('intervalS', t('form.interval'), { type: 'number', hint: t('form.intervalHelp') })}
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

function SelectField(props: {
  id: string;
  label: string;
  value: string;
  options: readonly (readonly [value: string, label: string])[];
  onChange: (value: string) => void;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={props.id}>
        {props.label}
      </label>
      <select
        id={props.id}
        className={styles.input}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
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
