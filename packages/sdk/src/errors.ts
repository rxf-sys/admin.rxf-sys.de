export const httpErrorCodes = [
  'TARGET_NOT_ALLOWED',
  'REQUEST_NOT_ALLOWED',
  'TARGET_BLOCKED',
  'DNS_NOT_FOUND',
  'CONNECTION_REFUSED',
  'HTTP_TIMEOUT',
  'TLS_SELF_SIGNED',
  'TLS_INVALID',
  'TLS_PIN_MISMATCH',
  'TLS_EXPIRED',
  'TLS_NOT_YET_VALID',
  'TLS_HOSTNAME',
  'CONNECT_TIMEOUT',
  'NET_UNREACHABLE',
  'DNS_TIMEOUT',
  'ICMP_UNAVAILABLE',
  'ICMP_NO_REPLY',
  'NETWORK_ERROR',
] as const;

export type HttpErrorCode = (typeof httpErrorCodes)[number];

/** A refused or failed device request. The message never contains credentials or request headers. */
export class PluginHttpError extends Error {
  readonly code: HttpErrorCode;

  constructor(code: HttpErrorCode, message: string) {
    super(message);
    this.name = 'PluginHttpError';
    this.code = code;
  }
}
