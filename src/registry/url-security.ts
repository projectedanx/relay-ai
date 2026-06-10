// src/registry/url-security.ts — SSRF guard for custom provider URLs

import { lookup } from 'node:dns/promises';

export interface UrlSecurityOptions {
  /** Allow http://127.0.0.1 and http://localhost (Ollama, LM Studio). */
  allowInsecureLocal?: boolean;
}

export interface UrlSecurityResult {
  ok: boolean;
  error?: string;
  hint?: string;
  normalizedUrl?: string;
}

const BLOCKED_HOSTNAMES = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  '169.254.170.2',
  'fd00:ec2::254',
  'localhost',
]);

function ipv4ToInt(octets: number[]): number {
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(p => Number(p));
  if (octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets;
}

function isBlockedIpv4(ip: string, allowInsecureLocal: boolean): boolean {
  const octets = parseIpv4(ip);
  if (!octets) return true;
  const n = ipv4ToInt(octets);

  if (allowInsecureLocal && octets[0] === 127) return false;

  if (octets[0] === 127) return true;
  if (octets[0] === 10) return true;
  if (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 169 && octets[1] === 254) return true;
  if (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127) return true;

  return false;
}

function expandIpv6(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (lower.includes('::ffff:')) {
    const mapped = lower.split('::ffff:')[1];
    if (mapped && parseIpv4(mapped)) return mapped;
  }
  return lower;
}

function isBlockedIpv6(ip: string, allowInsecureLocal: boolean): boolean {
  const lower = ip.toLowerCase();

  const mapped = expandIpv6(lower);
  if (mapped && mapped !== lower) {
    return isBlockedIpv4(mapped, allowInsecureLocal);
  }

  if (allowInsecureLocal && (lower === '::1' || lower === '0:0:0:0:0:0:0:1')) return false;

  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  if (lower.startsWith('fe80:')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;

  return false;
}

function isBlockedIp(ip: string, allowInsecureLocal: boolean): boolean {
  if (ip.includes(':')) return isBlockedIpv6(ip, allowInsecureLocal);
  return isBlockedIpv4(ip, allowInsecureLocal);
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  if (parseIpv4(hostname)) return [hostname];
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map(r => r.address);
  } catch {
    return [];
  }
}

/** Validate a custom provider base URL before test or save. */
export async function validateCustomEndpointUrl(
  rawUrl: string,
  opts: UrlSecurityOptions = {},
): Promise<UrlSecurityResult> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, error: 'Base URL is required.', hint: 'Example: https://api.example.com/v1' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Invalid URL.', hint: 'Include https:// and the full base path.' };
  }

  const allowLocal = opts.allowInsecureLocal === true;
  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return {
      ok: false,
      error: 'This URL points to a blocked internal/metadata host.',
      hint: 'Use a public API endpoint for your provider.',
    };
  }

  if (parsed.protocol === 'http:') {
    if (!allowLocal) {
      return {
        ok: false,
        error: 'Only HTTPS URLs are allowed.',
        hint: 'For local servers (Ollama, LM Studio), enable “Allow local HTTP”.',
      };
    }
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
      return {
        ok: false,
        error: 'HTTP is only allowed for localhost.',
        hint: 'Use https:// for remote servers, or http://127.0.0.1 for local ones.',
      };
    }
  } else if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL must use https:// (or http://localhost when local is allowed).' };
  }

  const addresses = await resolveHostAddresses(hostname);
  if (addresses.length === 0) {
    return {
      ok: false,
      error: `Could not resolve hostname: ${hostname}`,
      hint: 'Check the URL spelling and your network connection.',
    };
  }

  for (const addr of addresses) {
    if (isBlockedIp(addr, allowLocal)) {
      return {
        ok: false,
        error: 'URL resolves to a private or restricted network address.',
        hint: 'Custom providers must use publicly reachable API endpoints (unless localhost with local HTTP enabled).',
      };
    }
  }

  const normalizedUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
  return { ok: true, normalizedUrl };
}
