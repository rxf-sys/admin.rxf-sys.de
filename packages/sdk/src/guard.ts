import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { networkInterfaces } from 'node:os';
import { PluginHttpError } from './errors.ts';

/**
 * Loopback, link-local (cloud metadata) and unspecified addresses, plus the container's own addresses
 * (ADR 0008, T8). Private LAN ranges stay reachable: that is where the devices live.
 */
function defaultBlockList(): BlockList {
  const list = new BlockList();
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addSubnet('0.0.0.0', 8, 'ipv4');
  list.addSubnet('169.254.0.0', 16, 'ipv4');
  list.addAddress('::1', 'ipv6');
  list.addAddress('::', 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  list.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');
  list.addSubnet('::ffff:169.254.0.0', 112, 'ipv6');
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (!entry.internal) list.addAddress(entry.address, entry.family === 'IPv6' ? 'ipv6' : 'ipv4');
    }
  }
  return list;
}

export interface AddressGuard {
  /** A `lookup` for sockets that fails with `TARGET_BLOCKED` when any resolved address is blocked. */
  lookup: LookupFunction;
  /** Throws `TARGET_BLOCKED` for a blocked IP literal; host names are checked by `lookup`. */
  assertAllowed(host: string): void;
  /** Resolves a host name or IP literal to one allowed address, for tools that take an address only. */
  resolve(host: string): Promise<string>;
}

/** Strips the brackets URLs put around IPv6 literals. */
export const bareHost = (hostname: string) => hostname.replace(/^\[|\]$/g, '');

/**
 * The address check shared by every network client of an instance (ADR 0008, T8). Checking the resolved
 * address of each connection, not the name, also defeats DNS rebinding.
 */
export function createAddressGuard(options: {
  allowBlocked: boolean;
  lookup?: LookupFunction | undefined;
}): AddressGuard {
  const blockList = defaultBlockList();
  const baseLookup: LookupFunction = options.lookup ?? (dnsLookup as LookupFunction);
  const blocked = (address: string) =>
    !options.allowBlocked && blockList.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');

  const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
    baseLookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      const list = addresses as unknown as LookupAddress[];
      if (list.length === 0 || list.some((entry) => blocked(entry.address))) {
        return callback(new PluginHttpError('TARGET_BLOCKED', `${hostname} resolves to a blocked address`), '', 0);
      }
      if (lookupOptions.all) return callback(null, list as never);
      const first = list[0] as LookupAddress;
      return callback(null, first.address, first.family);
    });
  };

  const assertAllowed = (host: string) => {
    if (isIP(host) && blocked(host)) throw new PluginHttpError('TARGET_BLOCKED', `${host} is a blocked address`);
  };

  return {
    lookup,
    assertAllowed,
    resolve(host) {
      if (isIP(host)) {
        assertAllowed(host);
        return Promise.resolve(host);
      }
      return new Promise((resolve, reject) => {
        lookup(host, {}, (error, address) => (error ? reject(error) : resolve(address as string)));
      });
    },
  };
}
