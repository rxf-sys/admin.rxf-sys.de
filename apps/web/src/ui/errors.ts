import { ApiError } from '../api.ts';
import { hasMessage, t } from '../i18n.ts';

/**
 * A user-facing sentence for a failed request. Known codes have their own text; `overrides` lets a form
 * map a code to a more fitting message (the re-auth dialog says "password or code").
 */
export function errorText(error: unknown, overrides: Record<string, string> = {}): string {
  if (!(error instanceof ApiError)) return t('error.generic');
  const override = overrides[error.code];
  if (override) return override;
  if (error.code === 'WEAK_PASSWORD') {
    const key = `error.${String(error.details.problem)}`;
    return hasMessage(key) ? t(key) : t('error.generic');
  }
  if (error.code === 'TOO_MANY_ATTEMPTS') {
    return t('error.TOO_MANY_ATTEMPTS', { seconds: Number(error.details.retryAfterSeconds ?? 0) });
  }
  const key = `error.${error.code}`;
  return hasMessage(key) ? t(key) : t('error.generic');
}
