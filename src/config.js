// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// Up to three Moonraker instances, one "slot" each (`url_1`, `api_key_1`...).
// The slot number is the identity of the Gladys device: changing the address
// of an instance (new IP) keeps its device and its history.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

export const SLOTS = [1, 2, 3];

// The port Moonraker listens on out of the box.
export const DEFAULT_PORT = 7125;

export const DEFAULT_CONFIG = {
  url_1: '',
  api_key_1: '',
  url_2: '',
  api_key_2: '',
  url_3: '',
  api_key_3: '',
  language: 'fr',
};

export const urlKey = (slot) => `url_${slot}`;
export const apiKeyKey = (slot) => `api_key_${slot}`;

/**
 * Turn what the user typed into the base URL of Moonraker:
 * - `192.0.2.10` or `voron.local` (no scheme, no port): Moonraker itself, on
 *   its port 7125;
 * - `192.0.2.10:7125`: that port;
 * - `http://192.0.2.10` or `https://printer.example/`: exactly that address,
 *   for instance Mainsail or Fluidd, whose web server forwards the Moonraker
 *   API on port 80.
 * Returns null when it is not usable.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (text === '') {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url;
  try {
    url = new URL(hasScheme ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname === '') {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) {
    // Credentials in the URL would end up in logs and error messages.
    return null;
  }
  if (!hasScheme && url.port === '') {
    url.port = String(DEFAULT_PORT);
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const printers = [];
  const invalid = [];
  for (const slot of SLOTS) {
    const text = typeof source[urlKey(slot)] === 'string' ? source[urlKey(slot)].trim() : '';
    if (text === '') {
      continue;
    }
    const url = normalizeUrl(text);
    if (!url) {
      invalid.push(slot);
      continue;
    }
    const key = source[apiKeyKey(slot)];
    printers.push({ slot, url, apiKey: typeof key === 'string' ? key.trim() : '' });
  }
  return {
    printers,
    invalidSlots: invalid,
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
