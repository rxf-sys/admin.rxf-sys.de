/** Host name labels; never starts with `-`, so a host cannot pass as an option to `ping`. */
export const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** Close enough for form guidance in the browser; the server checks with `net.isIP`. */
export function looksLikeIp(value: string): boolean {
  return IPV4.test(value) || (value.includes(':') && /^[0-9a-f:.]+$/i.test(value));
}

export function looksLikeHost(value: string): boolean {
  return HOSTNAME_PATTERN.test(value) || looksLikeIp(value);
}
