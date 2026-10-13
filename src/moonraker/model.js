// -----------------------------------------------------------------------------
// Reading Moonraker answers: what a printer has (its "capabilities", read once
// per connection) and its live state (a "snapshot", rebuilt from the Klipper
// objects Moonraker pushes).
//
// Every shape below was recorded on Moonraker (API 1.5.0) driving Klipper with
// a simulated micro-controller (test/fixtures/moonraker/).
// -----------------------------------------------------------------------------

// States as the integration publishes them. `unreachable` and `unauthorized`
// are the integration's own (Moonraker does not answer, or refuses the key);
// `klippy_*` are Klipper's host states other than `ready`; the rest are
// Klipper's `print_stats.state`.
export const STATES = [
  'unreachable',
  'unauthorized',
  'klippy_disconnected',
  'klippy_startup',
  'klippy_shutdown',
  'klippy_error',
  'standby',
  'printing',
  'paused',
  'complete',
  'cancelled',
  'error',
];

export const PRINT_STATES = new Set([
  'standby',
  'printing',
  'paused',
  'complete',
  'cancelled',
  'error',
]);

// A print job is running (possibly held).
export const ACTIVE_STATES = new Set(['printing', 'paused']);

// The integration has nothing fresh from Klipper in these states.
export const DOWN_STATES = new Set(['unreachable', 'unauthorized', 'klippy_disconnected']);

// Upper bounds of the published features: Gladys never enforces them, they
// are display bounds, and the heater limits of the commands when Klipper's
// own `max_temp` is unknown.
export const DEFAULT_MAX_TEMP = { extruder: 350, bed: 150, generic: 150, sensor: 150 };

// Feature budget of one device: more would drown the useful ones.
const MAX_EXTRUDERS = 4;
const MAX_GENERIC_HEATERS = 4;
const MAX_SENSORS = 6;
const MAX_MACROS = 300;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** `Raspberry Pi 4` -> `raspberry_pi_4`: a feature key part, [a-z0-9_]. */
export function slug(text) {
  const result = String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return result === '' ? 'x' : result;
}

/**
 * A Klipper object name -> its heater or sensor description, or null.
 * `extruder`, `extruder1`, `heater_bed`, `heater_generic <name>`,
 * `temperature_sensor <name>`, `temperature_fan <name>`.
 */
export function describeObject(object) {
  if (/^extruder\d*$/.test(object)) {
    const index = object === 'extruder' ? 0 : Number(object.slice(8));
    return {
      object,
      kind: 'extruder',
      index,
      key: object,
      label: null,
      // The name SET_HEATER_TEMPERATURE expects.
      heater: object,
    };
  }
  if (object === 'heater_bed') {
    return { object, kind: 'bed', key: 'bed', label: null, heater: 'heater_bed' };
  }
  let match = /^heater_generic (.+)$/.exec(object);
  if (match) {
    return {
      object,
      kind: 'generic',
      key: `heater_${slug(match[1])}`,
      label: match[1],
      heater: match[1],
    };
  }
  match = /^temperature_(sensor|fan) (.+)$/.exec(object);
  if (match) {
    return { object, kind: 'sensor', key: `sensor_${slug(match[2])}`, label: match[2] };
  }
  return null;
}

/** Klipper's own limit for a heater (`max_temp` of its config section). */
function maxTempOf(settings, object, kind) {
  const section = isObject(settings) ? settings[object.toLowerCase()] : null;
  const value = finite(section?.max_temp);
  return value !== null && value > 0 ? Math.round(value) : DEFAULT_MAX_TEMP[kind];
}

/**
 * The webcam whose snapshot Gladys can show: the first enabled one with a
 * snapshot URL.
 */
export function readWebcam(webcams) {
  const list = Array.isArray(webcams?.webcams) ? webcams.webcams : [];
  const camera = list.find(
    (cam) =>
      isObject(cam) &&
      cam.enabled !== false &&
      typeof cam.snapshot_url === 'string' &&
      cam.snapshot_url.trim() !== '',
  );
  return camera
    ? { name: String(camera.name ?? ''), snapshotUrl: camera.snapshot_url.trim() }
    : null;
}

/**
 * What a printer has, from `printer.objects.list`, the `heaters` and
 * `configfile.settings` objects, `server.webcams.list` and `printer.info`.
 * Stable order (the device structure must not change for nothing).
 */
export function readCapabilities({ objects, heaters, settings, webcams, info }) {
  const names = Array.isArray(objects) ? objects.filter((name) => typeof name === 'string') : [];
  const available = new Set([
    ...(Array.isArray(heaters?.available_heaters) ? heaters.available_heaters : []),
    ...(Array.isArray(heaters?.available_sensors) ? heaters.available_sensors : []),
  ]);
  // Klipper lists the heaters in `heaters`; the object list is the fallback.
  const candidates = available.size > 0 ? [...available] : names;
  const described = candidates.map(describeObject).filter(Boolean);

  const extruders = described
    .filter((d) => d.kind === 'extruder')
    .sort((a, b) => a.index - b.index)
    .slice(0, MAX_EXTRUDERS);
  const bed = described.filter((d) => d.kind === 'bed').slice(0, 1);
  const generic = described
    .filter((d) => d.kind === 'generic')
    .sort((a, b) => a.object.localeCompare(b.object))
    .slice(0, MAX_GENERIC_HEATERS);
  const sensors = described
    .filter((d) => d.kind === 'sensor')
    .sort((a, b) => a.object.localeCompare(b.object))
    .slice(0, MAX_SENSORS);

  const used = new Set();
  const unique = (key) => {
    let candidate = key;
    for (let n = 2; used.has(candidate); n += 1) {
      candidate = `${key}_${n}`;
    }
    used.add(candidate);
    return candidate;
  };
  const heaterList = [...extruders, ...bed, ...generic].map((d) => ({
    object: d.object,
    kind: d.kind,
    key: unique(d.key),
    label: d.label,
    heater: d.heater,
    index: d.index ?? 0,
    max: maxTempOf(settings, d.object, d.kind),
  }));
  const sensorList = sensors.map((d) => ({
    object: d.object,
    kind: 'sensor',
    key: unique(d.key),
    label: d.label,
    max: DEFAULT_MAX_TEMP.sensor,
  }));

  const macros = names
    .filter((name) => name.startsWith('gcode_macro '))
    .map((name) => name.slice('gcode_macro '.length).trim())
    // `_NAME` macros are private helpers by convention: Mainsail and Fluidd hide them.
    .filter((name) => /^[A-Za-z0-9][A-Za-z0-9_]*$/.test(name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_MACROS);

  const hostname = typeof info?.hostname === 'string' ? info.hostname.trim().slice(0, 60) : '';
  return {
    hostname,
    // `?` when Klipper runs from a copy without its git history.
    version:
      typeof info?.software_version === 'string' && /^v?\d/.test(info.software_version)
        ? info.software_version.slice(0, 50)
        : '',
    heaters: heaterList,
    sensors: sensorList,
    fan: names.includes('fan'),
    camera: readWebcam(webcams),
    macros,
  };
}

/** The structure of the Gladys device changes with these only. */
export function sameStructure(a, b) {
  if (!a || !b) {
    return a === b;
  }
  const shape = (c) =>
    JSON.stringify({
      heaters: c.heaters.map((h) => [h.key, h.max]),
      sensors: c.sensors.map((s) => s.key),
      fan: c.fan,
      camera: Boolean(c.camera),
    });
  return shape(a) === shape(b);
}

/** The Klipper objects the integration subscribes to, and their fields. */
export function subscriptionOf(capabilities) {
  const objects = {
    webhooks: ['state', 'state_message'],
    print_stats: ['state', 'filename', 'total_duration', 'print_duration', 'message', 'info'],
    virtual_sdcard: ['progress', 'is_active'],
    display_status: ['progress'],
  };
  for (const heater of capabilities.heaters) {
    objects[heater.object] = ['temperature', 'target'];
  }
  for (const sensor of capabilities.sensors) {
    objects[sensor.object] = ['temperature'];
  }
  if (capabilities.fan) {
    objects.fan = ['speed'];
  }
  return objects;
}

/**
 * Merge a `notify_status_update` diff into the status: Moonraker sends only
 * the fields that changed, object by object.
 */
export function mergeStatus(status, diff) {
  if (!isObject(diff)) {
    return status;
  }
  const next = { ...status };
  for (const [object, fields] of Object.entries(diff)) {
    if (isObject(fields)) {
      next[object] = { ...(isObject(status[object]) ? status[object] : {}), ...fields };
    }
  }
  return next;
}

/** `klippy_state` of server.info, or `webhooks.state` -> a published state. */
export function klippyStateCode(klippyState) {
  switch (klippyState) {
    case 'ready':
      return null;
    case 'startup':
      return 'klippy_startup';
    case 'shutdown':
      return 'klippy_shutdown';
    case 'error':
      return 'klippy_error';
    default:
      return 'klippy_disconnected';
  }
}

/** First line of Klipper's state message ("Shutdown due to webhooks request"). */
export function firstLine(text) {
  return typeof text === 'string' ? text.split('\n')[0].trim().slice(0, 200) : '';
}

/**
 * The snapshot of a printer from its merged status.
 * @param {object} status Klipper objects, merged
 * @param {object} capabilities
 * @param {{ klippyState: string, estimatedTime?: number | null }} context
 */
export function readSnapshot(status, capabilities, { klippyState, estimatedTime = null }) {
  const webhooks = isObject(status.webhooks) ? status.webhooks : {};
  const stats = isObject(status.print_stats) ? status.print_stats : {};
  const klippy = klippyStateCode(webhooks.state ?? klippyState) ?? klippyStateCode(klippyState);
  const printState = PRINT_STATES.has(stats.state) ? stats.state : 'standby';
  const state = klippy ?? printState;

  const rawProgress =
    finite(status.display_status?.progress) ?? finite(status.virtual_sdcard?.progress);
  let progress = rawProgress === null ? null : Math.min(100, Math.max(0, rawProgress * 100));
  if (printState === 'complete') {
    progress = 100;
  }

  const info = isObject(stats.info) ? stats.info : {};
  const temperatures = {};
  for (const item of [...(capabilities?.heaters ?? []), ...(capabilities?.sensors ?? [])]) {
    const object = status[item.object];
    if (isObject(object)) {
      temperatures[item.key] = {
        actual: finite(object.temperature),
        target: item.kind === 'sensor' ? null : finite(object.target),
      };
    }
  }
  const fanSpeed = finite(status.fan?.speed);

  const printDuration = finite(stats.print_duration);
  const snapshot = {
    state,
    printState,
    message: firstLine(klippy ? webhooks.state_message : stats.message),
    file: typeof stats.filename === 'string' && stats.filename !== '' ? stats.filename : null,
    progress,
    totalDuration: finite(stats.total_duration),
    printDuration,
    timeLeft: null,
    layer: finite(info.current_layer),
    layerTotal: finite(info.total_layer),
    temperatures,
    fan: fanSpeed === null ? null : Math.round(fanSpeed * 100),
  };
  if (ACTIVE_STATES.has(state)) {
    snapshot.timeLeft = timeLeft(progress, printDuration, estimatedTime);
  }
  return snapshot;
}

/**
 * Seconds left. With the slicer's estimate, what remains of it at this
 * progress (slicers emit M73, a time-based progress); without, an
 * extrapolation of the time spent printing over the file progress, once it
 * means something.
 */
export function timeLeft(progress, printDuration, estimatedTime) {
  const share = progress === null ? null : progress / 100;
  if (finite(estimatedTime) !== null && estimatedTime > 0 && share !== null) {
    return Math.max(0, estimatedTime * (1 - share));
  }
  if (share !== null && share >= 0.01 && printDuration !== null && printDuration > 0) {
    return Math.max(0, printDuration / share - printDuration);
  }
  return null;
}
