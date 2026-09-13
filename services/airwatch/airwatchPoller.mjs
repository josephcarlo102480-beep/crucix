/**
 * AirWatch military aircraft poller (Module: airwatch, Component 1).
 *
 * Polls the free military-aircraft feeds and keeps the latest result in
 * memory — the poller is the ONLY thing that talks upstream; page loads and
 * API requests always read the cache.
 *
 *   Primary : https://opendata.adsb.fi/api/v2/mil   (free, no key)
 *   Fallback: https://api.adsb.lol/v2/mil           (same response shape)
 *
 * adsb.fi is primary because it carries far more airframe metadata than
 * adsb.lol on the same aircraft set: ICAO type (`t`) on ~83% of records vs
 * ~71%, plus `desc` and `ownOp`, which adsb.lol omits entirely. Type is what
 * the recon watch keys off, so the richer feed leads.
 *
 * api.airplanes.live was the original primary but now answers 403 to
 * anonymous clients ("contact us…"); their public API repo is archived. It
 * is deliberately not in the rotation — re-adding it needs a registered key.
 *
 * Failover is automatic and sticky: if the active source errors or
 * rate-limits (429 puts it in a 5-minute cooldown), the other one is tried
 * in the same cycle and becomes active on success. When BOTH fail, the poll
 * interval backs off exponentially (45s → 90s → ... → 5 min cap) per both
 * projects' usage guidance; a descriptive User-Agent identifies us.
 *
 * Both providers ask for max 1 request/second and personal, non-commercial
 * use; we poll once per 45s across all theatres. No API keys are needed.
 */

import { clampInt, fetchWithTimeout } from '../../lib/util/net.mjs';

const POLL_MS = clampInt(process.env.CRUCIX_AIRWATCH_POLL_SECONDS, {
  min: 30,
  max: 600,
  fallback: 45,
}) * 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Crucix-AirWatch/2.1 (+https://github.com/josephcarlo102480-beep/crucix; self-hosted OSINT dashboard; 1 req/45s)';

const SOURCES = [
  { id: 'adsb.fi', url: 'https://opendata.adsb.fi/api/v2/mil' },
  { id: 'adsb.lol', url: 'https://api.adsb.lol/v2/mil' },
];

/**
 * Watch boxes. The whole global mil feed is fetched once per cycle and
 * filtered into every theatre, so adding one costs nothing upstream.
 */
export const THEATRES = {
  usEast: {
    id: 'usEast', label: 'US EAST COAST',
    latMin: 24, latMax: 47, lonMin: -82, lonMax: -58,
    center: [36, -71], zoom: 5,
    note: 'Western Atlantic: Jacksonville/Norfolk P-8 patrol areas out past the shelf break.',
  },
  usWest: {
    id: 'usWest', label: 'US WEST COAST',
    latMin: 28, latMax: 50, lonMin: -132, lonMax: -114,
    center: [38, -124], zoom: 5,
    note: 'Eastern Pacific: Whidbey Island P-8 and Point Mugu operating areas.',
  },
  midEast: {
    id: 'midEast', label: 'MIDDLE EAST',
    latMin: 12, latMax: 42, lonMin: 25, lonMax: 65,
    center: [26.5, 51.5], zoom: 5,
    note: 'Gulf, eastern Med and Red Sea. Receiver coverage is sparse over Iran, Iraq and Syria.',
  },
  europe: {
    id: 'europe', label: 'EUROPE / BALTIC',
    latMin: 36, latMax: 71, lonMin: -12, lonMax: 42,
    center: [54, 15], zoom: 4,
    note: 'NATO eastern flank, Baltic and Black Sea approaches.',
  },
  indoPac: {
    id: 'indoPac', label: 'INDO-PACIFIC',
    latMin: 0, latMax: 46, lonMin: 100, lonMax: 146,
    center: [22, 122], zoom: 4,
    note: 'South China Sea, Taiwan Strait, East China Sea and the Japanese islands.',
  },
};

export const DEFAULT_THEATRE = 'usEast';
export const THEATRE_IDS = Object.keys(THEATRES);

// Back-compat: the single bounding box the module originally shipped with.
export const REGION = THEATRES[DEFAULT_THEATRE];

export const CATEGORIES = ['ASW', 'ISR', 'TANKER', 'HEAVY', 'FIGHTER', 'HELO', 'OTHER'];

// ── Classification by ICAO type designator ──────────────────────────────
// Exact designators as they appear in the feeds' `t` field. DC10 in a
// military-only feed is a KC-10; A330s in a military-only feed are MRTT /
// Voyager tankers; 767-2Cs (B762) are KC-46A Pegasus / KC-767.
//
// ASW is split out from ISR because maritime patrol is the question this
// panel gets asked most ("is anything hunting submarines out there?").
const TYPE_EXACT = {
  // Maritime patrol / anti-submarine warfare
  P8: 'ASW', P3: 'ASW', AP3: 'ASW', P1: 'ASW', ATLA: 'ASW', S3: 'ASW',
  CP40: 'ASW', MQ4: 'ASW', MQ4C: 'ASW',
  // Tankers
  K35R: 'TANKER', K35E: 'TANKER', K35A: 'TANKER', KC35: 'TANKER',
  K46: 'TANKER', KC46: 'TANKER', DC10: 'TANKER', KC10: 'TANKER',
  A332: 'TANKER', A333: 'TANKER', MRTT: 'TANKER', B762: 'TANKER',
  // ISR / AEW / SIGINT / high-altitude recon
  R135: 'ISR', RC135: 'ISR', C135: 'ISR', E3CF: 'ISR', E3TF: 'ISR', E3: 'ISR',
  E6: 'ISR', E8: 'ISR', E737: 'ISR', E7: 'ISR', E2: 'ISR', E2C: 'ISR', E2D: 'ISR',
  EP3: 'ISR', U2: 'ISR', RQ4: 'ISR', RQ4B: 'ISR', Q4: 'ISR', MQ9: 'ISR',
  E11A: 'ISR', BTB2: 'ISR',
  // Heavy lift
  C17: 'HEAVY', C5: 'HEAVY', C5M: 'HEAVY', A400: 'HEAVY',
  C130: 'HEAVY', C30J: 'HEAVY', K30J: 'HEAVY',
  // Helicopters (emitter category A7 below is the catch-all)
  H47: 'HELO', H53: 'HELO', H53S: 'HELO', H60: 'HELO', H64: 'HELO',
  UH1: 'HELO', UH1Y: 'HELO', AH1: 'HELO', NH90: 'HELO', EH10: 'HELO',
  TIGR: 'HELO', LYNX: 'HELO',
};

// Prefix rules for families with many sub-designators (F16 → F16, F16C...)
const TYPE_PREFIX = [
  ['P8', 'ASW'], ['P3', 'ASW'],
  ['K35', 'TANKER'],
  ['R135', 'ISR'], ['RQ4', 'ISR'], ['MQ9', 'ISR'],
  ['C130', 'HEAVY'], ['C30', 'HEAVY'],
  ['F16', 'FIGHTER'], ['F15', 'FIGHTER'], ['F18', 'FIGHTER'], ['F14', 'FIGHTER'],
  ['F22', 'FIGHTER'], ['F35', 'FIGHTER'], ['F4', 'FIGHTER'], ['A10', 'FIGHTER'],
  ['EUFI', 'FIGHTER'], ['TYPH', 'FIGHTER'], ['RFAL', 'FIGHTER'], ['MIR2', 'FIGHTER'],
  ['M2000', 'FIGHTER'], ['TOR', 'FIGHTER'], ['MG29', 'FIGHTER'], ['MG31', 'FIGHTER'],
  ['SU27', 'FIGHTER'], ['SU30', 'FIGHTER'], ['SU35', 'FIGHTER'], ['SU57', 'FIGHTER'],
  ['H47', 'HELO'], ['H53', 'HELO'], ['H60', 'HELO'], ['H64', 'HELO'],
];

/**
 * Classify an aircraft into one of CATEGORIES.
 * @param {string} type ICAO type designator (feed `t` field)
 * @param {string} emitterCategory ADS-B emitter category (feed `category`,
 *   e.g. 'A7' = rotorcraft) — used as a helicopter catch-all.
 */
export function classify(type, emitterCategory) {
  const t = normType(type);
  if (t && TYPE_EXACT[t]) return TYPE_EXACT[t];
  if (t) {
    for (const [prefix, cat] of TYPE_PREFIX) {
      if (t.startsWith(prefix)) return cat;
    }
  }
  if (String(emitterCategory || '').toUpperCase() === 'A7') return 'HELO';
  return 'OTHER';
}

function normType(type) {
  return String(type || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ── Recon watch ─────────────────────────────────────────────────────────
// What each interesting type actually does, in plain language. Anything in
// here is flagged `recon` so the UI can surface it above the transport and
// helicopter noise that dominates a mil feed.
const MISSION = {
  P8: 'P-8A Poseidon — maritime patrol / submarine hunting',
  P3: 'P-3 Orion — maritime patrol / submarine hunting',
  AP3: 'AP-3C Orion — maritime patrol',
  P1: 'Kawasaki P-1 — maritime patrol / submarine hunting',
  ATLA: 'Atlantique 2 — maritime patrol / submarine hunting',
  S3: 'S-3 Viking — anti-submarine warfare',
  CP40: 'CP-140 Aurora — maritime patrol / submarine hunting',
  MQ4: 'MQ-4C Triton — high-altitude maritime surveillance',
  MQ4C: 'MQ-4C Triton — high-altitude maritime surveillance',
  R135: 'RC-135 Rivet Joint — signals intelligence',
  RC135: 'RC-135 Rivet Joint — signals intelligence',
  C135: 'C-135 variant — reconnaissance / support',
  EP3: 'EP-3E Aries — signals intelligence',
  E6: 'E-6B Mercury — TACAMO relay to ballistic missile submarines',
  E3: 'E-3 Sentry — airborne early warning',
  E3TF: 'E-3 Sentry — airborne early warning',
  E3CF: 'E-3 Sentry — airborne early warning',
  E7: 'E-7 Wedgetail — airborne early warning',
  E737: 'E-7 Wedgetail — airborne early warning',
  E8: 'E-8C JSTARS — ground surveillance radar',
  E2: 'E-2 Hawkeye — carrier airborne early warning',
  E2C: 'E-2 Hawkeye — carrier airborne early warning',
  E2D: 'E-2D Hawkeye — carrier airborne early warning',
  E11A: 'E-11A BACN — airborne communications relay',
  U2: 'U-2S Dragon Lady — high-altitude reconnaissance',
  Q4: 'RQ-4 Global Hawk / MQ-4C Triton — high-altitude ISR',
  RQ4: 'RQ-4 Global Hawk — high-altitude ISR',
  RQ4B: 'RQ-4B Global Hawk — high-altitude ISR',
  MQ9: 'MQ-9 Reaper — armed ISR',
  BTB2: 'Bayraktar TB2 — armed ISR drone',
};

// Business jets flown as contractor ISR (ARTEMIS, ARES, ATHENA, BACN) share
// their type code with ordinary VIP and corporate aircraft, so a type match
// alone is not evidence. These only count as recon on a US military hex.
const MISSION_IF_US_MIL = {
  CL60: 'Challenger 650 — contractor ISR (US Army ARTEMIS class)',
  GLEX: 'Global 6000 — contractor ISR (US Army ARES / ATHENA class)',
  GL5T: 'Global 5000 — contractor ISR',
  GL6X: 'Global 6500 — contractor ISR',
  B350: 'King Air 350 — tactical ISR',
  BE20: 'King Air — tactical ISR',
};

// US military ICAO 24-bit allocation. The bulk is AE/AF, but the block
// actually starts partway through ADF7xx — several C-17s and tankers live
// below AE0000 and would be missed by an AE-prefix test.
const US_MIL_HEX_MIN = 0xADF7C8;
const US_MIL_HEX_MAX = 0xAFFFFF;

export function isUsMilHex(hex) {
  const n = parseInt(String(hex || ''), 16);
  return Number.isFinite(n) && n >= US_MIL_HEX_MIN && n <= US_MIL_HEX_MAX;
}

/**
 * Mission description for a type, or null if it is not a watched platform.
 * @param {string} type ICAO type designator
 * @param {boolean} usMil whether the hex is in the US military block
 */
export function missionFor(type, usMil) {
  const t = normType(type);
  if (!t) return null;
  if (MISSION[t]) return MISSION[t];
  if (usMil && MISSION_IF_US_MIL[t]) return MISSION_IF_US_MIL[t];
  return null;
}

// ── Typical role ────────────────────────────────────────────────────────
// What a type is *normally* used for, for every aircraft (not only the
// recon watch above). Keyed by ICAO type designator; prefix rules below
// catch sub-variants, and the category fallback covers unknown types so
// the popup always has something to say.
const ROLE = {
  // Maritime patrol / ASW
  P8: 'Maritime patrol, anti-submarine warfare, surface search',
  P3: 'Maritime patrol, anti-submarine warfare',
  AP3: 'Maritime patrol, anti-submarine warfare',
  P1: 'Maritime patrol, anti-submarine warfare',
  ATLA: 'Maritime patrol, anti-submarine warfare',
  S3: 'Carrier-based anti-submarine warfare, later tanker',
  CP40: 'Maritime patrol, anti-submarine warfare, sovereignty patrols',
  MQ4: 'Unmanned high-altitude maritime surveillance',
  MQ4C: 'Unmanned high-altitude maritime surveillance',
  // Tankers
  K35R: 'Aerial refuelling, some cargo and medevac',
  K35E: 'Aerial refuelling',
  K35A: 'Aerial refuelling',
  KC35: 'Aerial refuelling',
  K46: 'Aerial refuelling, cargo, medevac',
  KC46: 'Aerial refuelling, cargo, medevac',
  DC10: 'Aerial refuelling and cargo (KC-10 Extender)',
  KC10: 'Aerial refuelling and cargo',
  A332: 'Aerial refuelling and troop/cargo transport (MRTT / Voyager)',
  A333: 'Aerial refuelling and troop/cargo transport (MRTT)',
  MRTT: 'Aerial refuelling and troop/cargo transport',
  // ISR / AEW / SIGINT / comms relay
  R135: 'Signals intelligence — listening to radars and radio',
  RC135: 'Signals intelligence — listening to radars and radio',
  C135: 'Reconnaissance, test and support variants',
  EP3: 'Signals intelligence',
  E6: 'Nuclear command relay to ballistic missile submarines (TACAMO)',
  E3: 'Airborne early warning and control — watching the airspace',
  E3TF: 'Airborne early warning and control — watching the airspace',
  E3CF: 'Airborne early warning and control — watching the airspace',
  E7: 'Airborne early warning and control',
  E737: 'Airborne early warning and control',
  E8: 'Ground surveillance radar and battle management',
  E2: 'Carrier-based airborne early warning',
  E2C: 'Carrier-based airborne early warning',
  E2D: 'Carrier-based airborne early warning',
  E11A: 'Airborne communications relay (BACN)',
  U2: 'High-altitude photo and signals reconnaissance',
  Q4: 'Unmanned high-altitude reconnaissance',
  RQ4: 'Unmanned high-altitude reconnaissance',
  RQ4B: 'Unmanned high-altitude reconnaissance',
  MQ9: 'Unmanned armed surveillance and strike',
  MQ1: 'Unmanned surveillance and strike',
  MQ1C: 'Unmanned surveillance and strike',
  MQ9B: 'Unmanned long-endurance surveillance',
  BTB2: 'Unmanned armed surveillance and strike (Bayraktar TB2)',
  // Heavy / tactical airlift
  C17: 'Strategic airlift — troops, vehicles, cargo, medevac',
  C5: 'Outsize strategic airlift — tanks, helicopters, bulk cargo',
  C5M: 'Outsize strategic airlift — tanks, helicopters, bulk cargo',
  A400: 'Strategic and tactical airlift, paradrop, refuelling',
  C130: 'Tactical airlift, paradrop, special operations',
  C30J: 'Tactical airlift, paradrop, special operations',
  K30J: 'Tactical airlift and helicopter refuelling',
  C27J: 'Light tactical airlift, short rough strips',
  C295: 'Light tactical airlift, maritime patrol variants',
  C160: 'Tactical airlift',
  Y20: 'Strategic airlift (China)',
  KC2: 'Tactical and strategic airlift (Kawasaki C-2, Japan)',
  Y8: 'Tactical airlift and special-mission variants',
  Y9: 'Tactical airlift and special-mission variants',
  IL76: 'Strategic airlift, some tanker and AEW variants',
  AN12: 'Tactical airlift',
  AN26: 'Light tactical airlift',
  AN24: 'Light transport',
  AN72: 'Light tactical airlift, short rough strips',
  AN124: 'Outsize heavy cargo',
  C2: 'Carrier onboard delivery — mail, parts, people to ships',
  C2A: 'Carrier onboard delivery — mail, parts, people to ships',
  V22: 'Tilt-rotor assault transport and special operations',
  CMV2: 'Tilt-rotor carrier onboard delivery',
  DHC6: 'Light utility transport, paradrop, remote strips',
  CN35: 'Light tactical airlift and maritime patrol',
  // Airliner-based transports, VIP and staff jets
  B762: 'Aerial refuelling, cargo, medevac (KC-46A / KC-767 on a 767 airframe)',
  B763: 'Passenger and cargo airlift, tanker variants',
  B752: 'VIP and staff transport (C-32), passenger airlift',
  B737: 'VIP and staff transport (C-40), passenger airlift',
  B738: 'VIP and staff transport (C-40), passenger airlift',
  B38M: 'VIP and government transport (737 MAX BBJ)',
  B744: 'Head-of-state transport, airborne command post (E-4B)',
  B748: 'Head-of-state transport, airborne command post',
  E4: 'Airborne command post — flying war room',
  A310: 'Passenger transport and refuelling',
  A319: 'VIP and government transport',
  A320: 'VIP and government transport',
  A321: 'VIP and government transport',
  A343: 'Head-of-state and long-range government transport',
  A359: 'Head-of-state and long-range government transport',
  A388: 'Head-of-state transport',
  C560: 'Staff and utility transport (UC-35), light cargo',
  C56X: 'Staff and utility transport',
  C680: 'Staff and utility transport',
  C750: 'Staff and utility transport',
  LJ35: 'Staff transport, medevac, target towing',
  LJ45: 'Staff transport, medevac',
  LJ60: 'Staff transport',
  GLF4: 'VIP and staff transport (C-20)',
  GLF5: 'VIP and staff transport (C-37)',
  GLF6: 'VIP and staff transport',
  G550: 'VIP transport, special-mission and AEW variants',
  CL60: 'VIP and staff transport, contractor surveillance variants',
  CL30: 'VIP and staff transport',
  CL35: 'VIP and staff transport',
  GLEX: 'VIP transport, radar and sensor test variants',
  GL5T: 'VIP transport',
  GL6X: 'VIP transport',
  F2TH: 'VIP and government transport (Falcon 2000)',
  F900: 'VIP and government transport (Falcon 900)',
  FA7X: 'VIP and government transport (Falcon 7X)',
  FA8X: 'VIP and government transport (Falcon 8X)',
  FA50: 'VIP transport and maritime surveillance variants',
  FA20: 'Utility, electronic warfare training, maritime surveillance',
  E35L: 'VIP and staff transport (Legacy 600)',
  E135: 'VIP transport, AEW and surveillance variants',
  E145: 'VIP transport, AEW and surveillance variants',
  E190: 'VIP and government transport',
  H25B: 'Utility, navaid calibration, radar training',
  BE20: 'Light utility transport, surveillance variants',
  B350: 'Light utility transport, surveillance variants',
  B200: 'Light utility transport, training, surveillance variants',
  PC12: 'Light utility transport, special-operations surveillance',
  PC24: 'Light utility and medevac transport',
  DH8D: 'Light passenger transport, maritime patrol variants',
  AT72: 'Light passenger transport, maritime patrol variants',
  SB20: 'Light passenger transport, AEW variants',
  // Fighters and attack
  F16: 'Multirole fighter — air combat and ground attack',
  F15: 'Air superiority fighter (F-15E: strike)',
  F15E: 'Strike fighter — long-range ground attack',
  F18: 'Carrier-based multirole fighter',
  F18S: 'Carrier-based multirole fighter',
  F14: 'Fleet air defence fighter',
  F22: 'Stealth air superiority fighter',
  F35: 'Stealth multirole strike fighter',
  F4: 'Multirole fighter (legacy)',
  F5: 'Light fighter, aggressor and lead-in training',
  A10: 'Close air support — attacking ground forces',
  EUFI: 'Multirole fighter (Eurofighter Typhoon)',
  TYPH: 'Multirole fighter (Eurofighter Typhoon)',
  RFAL: 'Multirole fighter (Rafale)',
  MIR2: 'Multirole fighter (Mirage 2000)',
  M2000: 'Multirole fighter (Mirage 2000)',
  TOR: 'Strike and electronic-warfare aircraft (Tornado)',
  MG29: 'Air superiority fighter (MiG-29)',
  MG31: 'High-speed interceptor (MiG-31)',
  SU27: 'Air superiority fighter (Su-27)',
  SU30: 'Multirole fighter (Su-30)',
  SU34: 'Strike fighter (Su-34)',
  SU35: 'Multirole fighter (Su-35)',
  SU57: 'Stealth multirole fighter (Su-57)',
  SU24: 'Strike bomber (Su-24)',
  SU25: 'Close air support (Su-25)',
  J10: 'Multirole fighter (China)',
  J11: 'Air superiority fighter (China)',
  J16: 'Strike fighter (China)',
  J20: 'Stealth fighter (China)',
  GRIP: 'Multirole fighter (Gripen)',
  HAWK: 'Advanced jet trainer, light attack',
  EA18: 'Electronic attack — jamming enemy radars',
  EA6: 'Electronic attack — jamming enemy radars',
  B52: 'Long-range heavy bomber',
  B1: 'Long-range supersonic bomber',
  B2: 'Stealth heavy bomber',
  TU95: 'Long-range bomber and missile carrier',
  TU160: 'Supersonic long-range bomber',
  TU22: 'Long-range bomber and maritime strike',
  H6: 'Long-range bomber and missile carrier (China)',
  // Trainers
  TEX2: 'Primary pilot training (T-6 Texan II)',
  T6: 'Primary pilot training',
  T38: 'Advanced jet pilot training, aggressor',
  T45: 'Carrier-capable jet pilot training',
  T7: 'Advanced jet pilot training',
  T1: 'Multi-engine and tanker/transport pilot training',
  PC21: 'Advanced turboprop pilot training',
  PC9: 'Basic and advanced pilot training',
  PC7: 'Basic pilot training',
  PC6: 'Utility, paradrop and short-strip transport',
  M346: 'Advanced jet pilot training',
  L39: 'Jet pilot training, light attack',
  L159: 'Light attack and advanced training',
  AJET: 'Jet pilot training and aerobatic display',
  TUCA: 'Basic pilot training, light attack',
  EMB3: 'Basic pilot training, light attack',
  F260: 'Basic pilot training and screening',
  G120: 'Basic pilot training',
  T34: 'Basic pilot training',
  C172: 'Basic flight screening and cadet training',
  DA40: 'Basic flight screening',
  DA42: 'Multi-engine training, surveillance variants',
  // Helicopters
  H60: 'Utility and assault transport, medevac, combat search and rescue',
  H47: 'Heavy-lift transport — troops, artillery, vehicles',
  H53: 'Heavy-lift transport and special operations',
  H53S: 'Heavy-lift transport and special operations',
  H64: 'Attack helicopter — anti-armour and close support',
  AH1: 'Attack helicopter — close support',
  UH1: 'Utility transport and training',
  UH1Y: 'Utility transport, assault, medevac',
  OH58: 'Armed scout and observation',
  H1: 'Utility transport',
  NH90: 'Tactical transport and naval utility',
  EH10: 'Medium transport, search and rescue, naval utility (Merlin)',
  TIGR: 'Attack and armed reconnaissance helicopter',
  LYNX: 'Naval utility, anti-ship and anti-submarine',
  WCAT: 'Naval utility, anti-ship and anti-submarine (Wildcat)',
  AS65: 'Search and rescue, naval utility (Dauphin / MH-65)',
  EC45: 'Light utility, training, medevac',
  EC35: 'Light utility, training, medevac',
  EC55: 'Light utility and VIP transport',
  H145: 'Light utility, training, medevac',
  H135: 'Light utility and training',
  S92: 'Search and rescue, VIP transport',
  S61: 'Search and rescue, transport',
  A139: 'Utility, search and rescue, VIP transport',
  A109: 'Light utility, training, medevac',
  AS32: 'Medium transport, search and rescue, special operations',
  H225: 'Medium transport, search and rescue, special operations',
  AS50: 'Light utility and training',
  B412: 'Utility transport, search and rescue',
  B429: 'Light utility and training',
  B06: 'Light utility and training',
  KA50: 'Attack helicopter',
  KA52: 'Attack and reconnaissance helicopter',
  MI8: 'Medium transport and assault',
  MI17: 'Medium transport and assault',
  MI24: 'Attack helicopter and assault transport',
  MI28: 'Attack helicopter',
  MI26: 'Heavy-lift transport',
  // Other mission types
  E4B: 'Airborne command post — flying war room',
  WC13: 'Weather reconnaissance — hurricane hunting',
  HC13: 'Combat search and rescue, helicopter refuelling',
  MC13: 'Special operations infiltration and refuelling',
  AC13: 'Gunship — close air support',
  EC13: 'Psychological and electronic operations',
  OV10: 'Forward air control and light attack',
  A29: 'Light attack and armed reconnaissance',
  AT6: 'Light attack and armed reconnaissance',
  SR71: 'High-speed strategic reconnaissance',
};

// Prefix rules for families with many sub-designators, checked after exact
// matches so a specific entry always wins.
const ROLE_PREFIX = [
  ['P8', ROLE.P8], ['K35', ROLE.K35R], ['R135', ROLE.R135],
  ['RQ4', ROLE.RQ4], ['MQ9', ROLE.MQ9], ['C130', ROLE.C130],
  ['F16', ROLE.F16], ['F15E', ROLE.F15E], ['F15', ROLE.F15], ['F18', ROLE.F18],
  ['F14', ROLE.F14], ['F22', ROLE.F22], ['F35', ROLE.F35],
  ['A10', ROLE.A10], ['EUFI', ROLE.EUFI], ['TYPH', ROLE.TYPH],
  ['RFAL', ROLE.RFAL], ['MIR2', ROLE.MIR2], ['M2000', ROLE.M2000], ['TOR', ROLE.TOR],
  ['MG29', ROLE.MG29], ['MG31', ROLE.MG31], ['SU27', ROLE.SU27], ['SU30', ROLE.SU30],
  ['SU34', ROLE.SU34], ['SU35', ROLE.SU35], ['SU57', ROLE.SU57],
  ['H47', ROLE.H47], ['H53', ROLE.H53], ['H60', ROLE.H60], ['H64', ROLE.H64],
  ['UH1', ROLE.UH1], ['AH1', ROLE.AH1], ['MI8', ROLE.MI8], ['MI17', ROLE.MI17],
  ['B52', ROLE.B52], ['GLF', ROLE.GLF5],
  ['TEX', ROLE.TEX2], ['PC12', ROLE.PC12], ['PC21', ROLE.PC21], ['HAWK', ROLE.HAWK],
];

// Last resort when the type is unknown or missing: say what the category
// usually means rather than leaving the popup blank.
const ROLE_BY_CAT = {
  ASW: 'Maritime patrol, anti-submarine warfare',
  ISR: 'Intelligence, surveillance and reconnaissance',
  TANKER: 'Aerial refuelling',
  HEAVY: 'Airlift — troops, vehicles, cargo',
  FIGHTER: 'Air combat and ground attack',
  HELO: 'Rotary-wing transport, utility or attack',
  OTHER: 'Transport, training or utility (type not identified)',
};

/**
 * What this type of aircraft is normally used for. Always returns a
 * string: the type table first, then family prefixes, then the category.
 * @param {string} type ICAO type designator
 * @param {string} cat one of CATEGORIES (used only as the fallback)
 */
export function roleFor(type, cat) {
  const t = normType(type);
  if (t && ROLE[t]) return ROLE[t];
  if (t) {
    for (const [prefix, role] of ROLE_PREFIX) {
      if (t.startsWith(prefix)) return role;
    }
  }
  return ROLE_BY_CAT[cat] || ROLE_BY_CAT.OTHER;
}

// ── Origin country from ICAO 24-bit hex allocation ──────────────────────
// Compact table of the allocations most relevant to these theatres (plus the
// big operators). Best-effort annotation — unknown ranges return null.
const HEX_COUNTRY = [
  [0x010000, 0x017FFF, 'Egypt'],
  [0x06A000, 0x06AFFF, 'Qatar'],
  [0x100000, 0x1FFFFF, 'Russia'],
  [0x300000, 0x33FFFF, 'Italy'],
  [0x340000, 0x37FFFF, 'Spain'],
  [0x380000, 0x3BFFFF, 'France'],
  [0x3C0000, 0x3FFFFF, 'Germany'],
  [0x400000, 0x43FFFF, 'United Kingdom'],
  [0x440000, 0x447FFF, 'Austria'],
  [0x448000, 0x44FFFF, 'Belgium'],
  [0x458000, 0x45FFFF, 'Denmark'],
  [0x460000, 0x467FFF, 'Finland'],
  [0x468000, 0x46FFFF, 'Greece'],
  [0x478000, 0x47FFFF, 'Norway'],
  [0x480000, 0x487FFF, 'Netherlands'],
  [0x488000, 0x48FFFF, 'Poland'],
  [0x490000, 0x497FFF, 'Portugal'],
  [0x498000, 0x49FFFF, 'Czechia'],
  [0x4A8000, 0x4AFFFF, 'Sweden'],
  [0x4B0000, 0x4B7FFF, 'Switzerland'],
  [0x4B8000, 0x4BFFFF, 'Turkey'],
  [0x508000, 0x50FFFF, 'Ukraine'],
  [0x600000, 0x6003FF, 'Azerbaijan'],
  [0x700000, 0x700FFF, 'Afghanistan'],
  [0x706000, 0x706FFF, 'Kuwait'],
  [0x70C000, 0x70C3FF, 'Oman'],
  [0x710000, 0x717FFF, 'Saudi Arabia'],
  [0x728000, 0x72FFFF, 'Iraq'],
  [0x730000, 0x737FFF, 'Iran'],
  [0x738000, 0x73FFFF, 'Israel'],
  [0x740000, 0x747FFF, 'Jordan'],
  [0x748000, 0x74FFFF, 'Lebanon'],
  [0x760000, 0x767FFF, 'Pakistan'],
  [0x768000, 0x76FFFF, 'Singapore'],
  [0x778000, 0x77FFFF, 'Syria'],
  [0x7C0000, 0x7FFFFF, 'Australia'],
  [0x800000, 0x83FFFF, 'India'],
  [0x840000, 0x87FFFF, 'Japan'],
  [0x880000, 0x887FFF, 'Thailand'],
  [0x894000, 0x894FFF, 'Bahrain'],
  [0x896000, 0x896FFF, 'UAE'],
  [0x898000, 0x898FFF, 'Taiwan'],
  [0x718000, 0x71FFFF, 'South Korea'],
  [0x780000, 0x7BFFFF, 'China'],
  [0xA00000, 0xAFFFFF, 'United States'],
  [0xC00000, 0xC3FFFF, 'Canada'],
  [0xE00000, 0xE3FFFF, 'Argentina'],
  [0xE40000, 0xE7FFFF, 'Brazil'],
];

export function hexCountry(hex) {
  const n = parseInt(String(hex || ''), 16);
  if (!Number.isFinite(n)) return null;
  for (const [start, end, country] of HEX_COUNTRY) {
    if (n >= start && n <= end) return country;
  }
  return null;
}

/** Is this position inside the named theatre (default: the module default)? */
export function inRegion(lat, lon, theatre = DEFAULT_THEATRE) {
  const box = THEATRES[theatre] || THEATRES[DEFAULT_THEATRE];
  return lat >= box.latMin && lat <= box.latMax
    && lon >= box.lonMin && lon <= box.lonMax;
}

/**
 * Normalize one raw feed aircraft record into our wire format (or null).
 *
 * Roughly a third of a mil feed has no live ADS-B position: some aircraft are
 * positioned by MLAT (multilateration from ground receivers), some only have
 * a stale last fix, and some are heard on Mode S with no position at all.
 * Rather than discard everything imperfect, each record carries `posSource`
 * so the map can draw uncertain positions differently. Only records with no
 * usable position whatsoever are dropped.
 */
export function normalizeAircraft(ac) {
  const type = ac?.t || null;
  // Ground transponder test rigs pollute the feed; they are not aircraft.
  if (normType(type) === 'TWR') return null;
  if (/^TEST\d/i.test(String(ac?.flight || '').trim())) return null;

  let lat = Number(ac?.lat);
  let lon = Number(ac?.lon);
  let posSource = Array.isArray(ac?.mlat) && ac.mlat.length ? 'mlat' : 'adsb';

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const last = ac?.lastPosition;
    if (last && Number.isFinite(Number(last.lat)) && Number.isFinite(Number(last.lon))) {
      lat = Number(last.lat);
      lon = Number(last.lon);
      posSource = 'last';
    } else if (Number.isFinite(Number(ac?.rr_lat)) && Number.isFinite(Number(ac?.rr_lon))) {
      // Rough receiver-area position: accurate to a region, not a point.
      lat = Number(ac.rr_lat);
      lon = Number(ac.rr_lon);
      posSource = 'approx';
    } else {
      return null; // heard on Mode S only — nothing to place on a map
    }
  }

  const onGround = ac?.alt_baro === 'ground';
  const alt = onGround ? 0
    : Number.isFinite(Number(ac?.alt_baro)) ? Number(ac.alt_baro)
    : Number.isFinite(Number(ac?.alt_geom)) ? Number(ac.alt_geom) : null;
  const track = Number.isFinite(Number(ac?.track)) ? Number(ac.track)
    : Number.isFinite(Number(ac?.calc_track)) ? Number(ac.calc_track)
    : Number.isFinite(Number(ac?.true_heading)) ? Number(ac.true_heading) : null;
  const usMil = isUsMilHex(ac?.hex);
  const mission = missionFor(type, usMil);
  const cat = classify(type, ac?.category);

  return {
    hex: String(ac?.hex || '').trim(),
    callsign: String(ac?.flight || '').trim() || null,
    reg: ac?.r || null,
    type,
    desc: ac?.desc || null,
    operator: ac?.ownOp || null,
    cat,
    mission,
    role: roleFor(type, cat),
    recon: Boolean(mission),
    usMil,
    lat, lon, alt, posSource, onGround,
    gs: Number.isFinite(Number(ac?.gs)) ? Number(ac.gs) : null,
    track,
    squawk: ac?.squawk || null,
    country: hexCountry(ac?.hex),
    seenPos: Number.isFinite(Number(ac?.seen_pos)) ? Number(ac.seen_pos) : null,
  };
}

export function countByCategory(aircraft) {
  const counts = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
  for (const ac of aircraft) counts[ac.cat] = (counts[ac.cat] || 0) + 1;
  return counts;
}

/** Exponential backoff delay after `failStreak` consecutive all-source failures. */
export function backoffDelay(failStreak, baseMs = POLL_MS, maxMs = BACKOFF_MAX_MS) {
  if (failStreak <= 0) return baseMs;
  return Math.min(baseMs * 2 ** failStreak, maxMs);
}

// ── Poller state ────────────────────────────────────────────────────────
const state = {
  cache: null,          // { fetchedAt, source, aircraft, byTheatre, withoutPosition, feedTotal }
  activeIdx: 0,         // sticky preferred source index
  failStreak: 0,        // consecutive cycles where ALL sources failed
  rateLimitedUntil: SOURCES.map(() => 0),
  lastError: SOURCES.map(() => null),
  timer: null,
  running: false,
  onSample: null,       // hook: (countsByTheatreAndCategory) => void, set by the router
};

async function fetchSource(source) {
  const res = await fetchWithTimeout(source.url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
  });
  if (res.status === 429) {
    const err = new Error('HTTP 429 (rate limited)');
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data?.ac)) throw new Error('Malformed response (no ac array)');
  return data;
}

async function pollOnce() {
  const now = Date.now();
  // Active source first, then the other(s); skip sources in 429 cooldown
  // unless everything is cooling down (then try anyway rather than go blind).
  const order = [...SOURCES.keys()].sort((a, b) =>
    (a === state.activeIdx ? -1 : 0) - (b === state.activeIdx ? -1 : 0));
  const eligible = order.filter(i => state.rateLimitedUntil[i] <= now);
  const tryOrder = eligible.length ? eligible : order;

  for (const idx of tryOrder) {
    const source = SOURCES[idx];
    try {
      const data = await fetchSource(source);
      const normalized = data.ac.map(normalizeAircraft).filter(Boolean);
      // Parked aircraft are noise on a movement map; keep them out of the
      // tracked lists but report how many were dropped.
      const aircraft = normalized.filter(ac => !ac.onGround);
      const onGround = normalized.length - aircraft.length;
      const byTheatre = {};
      for (const id of THEATRE_IDS) {
        byTheatre[id] = aircraft.filter(ac => inRegion(ac.lat, ac.lon, id));
      }
      state.cache = {
        fetchedAt: new Date().toISOString(),
        source: source.id,
        aircraft,
        byTheatre,
        onGround,
        withoutPosition: data.ac.length - normalized.length,
        feedTotal: data.ac.length,
      };
      state.activeIdx = idx;
      state.failStreak = 0;
      state.lastError[idx] = null;
      try { state.onSample?.(buildSample(byTheatre)); } catch { /* baseline is best-effort */ }
      return true;
    } catch (err) {
      state.lastError[idx] = `${err?.message || err} @ ${new Date().toISOString()}`;
      if (err?.rateLimited) state.rateLimitedUntil[idx] = now + RATE_LIMIT_COOLDOWN_MS;
      console.warn(`[AirWatch] ${source.id} failed: ${err?.message || err}`);
    }
  }
  state.failStreak++;
  return false;
}

/**
 * Flatten per-theatre category counts into `theatre:CATEGORY` keys for the
 * baseline store, which keeps one row per key per hour. Composite keys let
 * every theatre build its own 24h baseline without a schema change.
 */
export function buildSample(byTheatre) {
  const sample = {};
  for (const [id, list] of Object.entries(byTheatre)) {
    for (const [cat, n] of Object.entries(countByCategory(list))) {
      sample[`${id}:${cat}`] = n;
    }
  }
  return sample;
}

function scheduleNext() {
  if (!state.running) return;
  const delay = backoffDelay(state.failStreak);
  if (state.failStreak > 0) {
    console.warn(`[AirWatch] All sources failed (streak ${state.failStreak}) — next attempt in ${Math.round(delay / 1000)}s`);
  }
  state.timer = setTimeout(runCycle, delay);
  state.timer.unref?.();
}

async function runCycle() {
  try {
    await pollOnce();
  } finally {
    scheduleNext();
  }
}

/** Start polling (idempotent). Resolves after the FIRST fetch attempt. */
export async function startPoller({ onSample } = {}) {
  if (onSample) state.onSample = onSample;
  if (state.running) return !!state.cache;
  state.running = true;
  const ok = await pollOnce();
  scheduleNext();
  return ok;
}

export function stopPoller() {
  state.running = false;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
}

/** Latest cached result (null until the first successful poll). */
export function getSnapshot() {
  return state.cache;
}

/** Source/health status for the API + UI. */
export function getSourceStatus() {
  const now = Date.now();
  return {
    active: SOURCES[state.activeIdx].id,
    pollSeconds: POLL_MS / 1000,
    failStreak: state.failStreak,
    sources: SOURCES.map((s, i) => ({
      id: s.id,
      role: i === 0 ? 'primary' : 'fallback',
      rateLimitedForSeconds: Math.max(0, Math.ceil((state.rateLimitedUntil[i] - now) / 1000)) || 0,
      lastError: state.lastError[i],
    })),
  };
}
