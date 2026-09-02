// Small networking helpers: bare fetch with a timeout, integer clamping,
// and a DNS-free private-host check for SSRF guards.

/**
 * fetch() that aborts after `timeoutMs`. Returns the Response; rejects on
 * abort or network error. No retries, no body handling — see apis/utils/fetch.mjs
 * for the retrying, error-swallowing variant.
 */
export function fetchWithTimeout(url, { timeoutMs = 10000, signal, ...init } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return fetch(url, { ...init, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] });
}

/** Parse an integer and clamp it into [min, max]; anything unparseable → fallback. */
export function clampInt(value, { min = -Infinity, max = Infinity, fallback = 0 } = {}) {
  if (value === undefined || value === null) return fallback;
  const str = typeof value === 'string' ? value.trim() : value;
  if (str === '') return fallback;
  const n = typeof str === 'number' ? Math.trunc(str) : parseInt(str, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function ipv4Private(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null; // not an IPv4 literal
  const nums = parts.map(p => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const [a, b] = nums;
  if (a === 0) return true;             // 0.0.0.0/8 ("this host")
  if (a === 127) return true;           // loopback
  if (a === 10) return true;            // private
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/** Expand an IPv6 literal to 8 lowercase hex groups, or null if unparseable. */
function expandIpv6(host) {
  if (!host.includes(':')) return null;
  const zone = host.indexOf('%');
  const addr = zone === -1 ? host : host.slice(0, zone);
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s) => (s === '' ? [] : s.split(':'));
  let head = toGroups(halves[0]);
  let tail = halves.length === 2 ? toGroups(halves[1]) : [];

  // Trailing IPv4 form (::ffff:1.2.3.4) — fold the dotted quad into two groups.
  const last = (tail.length ? tail : head).at(-1);
  if (last && last.includes('.')) {
    const octets = last.split('.');
    if (octets.length !== 4) return null;
    const nums = octets.map(o => (/^\d{1,3}$/.test(o) ? Number(o) : NaN));
    if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const pair = [
      ((nums[0] << 8) | nums[1]).toString(16),
      ((nums[2] << 8) | nums[3]).toString(16),
    ];
    if (tail.length) tail = [...tail.slice(0, -1), ...pair];
    else head = [...head.slice(0, -1), ...pair];
  }

  const groups = halves.length === 2
    ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
    : head;
  if (groups.length !== 8) return null;
  if (!groups.every(g => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return groups.map(g => parseInt(g, 16));
}

/**
 * True when `hostname` is a loopback / private / link-local name or IP literal.
 * String inspection only — no DNS resolution, so a public name that resolves to
 * a private address is NOT caught here.
 */
export function isPrivateHost(hostname) {
  if (typeof hostname !== 'string') return false;
  let host = hostname.trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1); // trailing root dot
  if (!host) return false;

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  const v4 = ipv4Private(host);
  if (v4 !== null) return v4;

  const groups = expandIpv6(host);
  if (groups) {
    if (groups.every((g, i) => (i === 7 ? g === 1 : g === 0))) return true; // ::1
    if (groups.every(g => g === 0)) return true;                            // ::
    const first = groups[0];
    if ((first & 0xfe00) === 0xfc00) return true;                           // fc00::/7
    if ((first & 0xffc0) === 0xfe80) return true;                           // fe80::/10
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d)
    const mapped = groups.slice(0, 5).every(g => g === 0)
      && (groups[5] === 0xffff || groups[5] === 0);
    if (mapped) {
      const a = groups[6] >> 8, b = groups[6] & 0xff, c = groups[7] >> 8, d = groups[7] & 0xff;
      return ipv4Private(`${a}.${b}.${c}.${d}`) === true;
    }
    return false;
  }
  return false;
}
