/** Default from docs/integrations/uptime.md (owner decision 17.11.2026): a login wall or a missing GET still counts as up. */
export const DEFAULT_EXPECTED_STATUS = '200-399,401,403,405';

export const EXPECTED_STATUS_PATTERN = /^\d{3}(-\d{3})?(,\d{3}(-\d{3})?)*$/;

/** "200-399,401" → does the status match? The pattern is validated by the config schema. */
export function statusMatches(expected: string, status: number): boolean {
  return expected.split(',').some((part) => {
    const [from, to] = part.split('-').map(Number) as [number, number | undefined];
    return to === undefined ? status === from : status >= from && status <= to;
  });
}
