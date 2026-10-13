// -----------------------------------------------------------------------------
// Moonraker instance -> Gladys device, and snapshot -> feature states.
//
// Couples chosen among those the Gladys front knows (test/gladys-rules.test.js),
// the same as the OctoPrint integration:
// - state, file: text/text (two of them: the dashboard then shows their names);
// - progress: level-sensor/liquid-level-percent, the only read-only percent
//   couple with a label (the precedent of gladys-ipp's supply levels);
// - elapsed, left: duration/integer in minutes (duration/decimal is a slider);
// - layer, total layers: counter-sensor/integer (filled when the slicer sends
//   SET_PRINT_STATS_INFO, as PrusaSlicer, OrcaSlicer and Cura setups do);
// - temperatures and their targets: device-temperature-sensor/decimal, read
//   only. Not temperature-sensor: Gladys averages those of a room into its
//   room temperature (and the weekly digest), a 210 °C nozzle would skew it.
//   Not thermostat: a printer heater must never be settable by mistake from
//   the dashboard, nor through HomeKit, Alexa or Google (fire risk). Heating
//   goes through the widget (preheat, cool down) and the scene actions;
// - part cooling fan: fan/percent, read only (shown as a value);
// - pause, resume: button/push, the "Push" row button.
// Cancelling is not a device button: one tap, no confirmation, a ruined
// print. It is offered by the widget (with a confirmation) and the scenes.
//
// Feature keys are forever: `extruder_target`, `bed_temperature`,
// `heater_<name>_...`, `sensor_<name>` come from Klipper's object names.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPE,
  DEVICE_FEATURE_UNITS as UNIT,
} from '@gladysassistant/integration-sdk';
import { ACTIVE_STATES, DOWN_STATES } from './moonraker/model.js';
import { NAMES, NO_FILE, STATE_LABELS } from './texts.js';

export const DEVICE_TYPE = 'printer';

const MAX_MINUTES = 100_000; // about 70 days
const MAX_LAYERS = 100_000;

export const COMMAND_KEYS = ['pause', 'resume'];

export function deviceIds(gladys, slot) {
  return gladys.externalIds(DEVICE_TYPE, String(slot));
}

/** `extruder` -> `Nozzle`, `extruder1` -> `Nozzle 2`, `heater_generic chamber` -> `chamber`. */
export function heaterName(names, heater) {
  if (heater.kind === 'extruder') {
    return heater.index === 0 ? names.extruder : `${names.extruder} ${heater.index + 1}`;
  }
  if (heater.kind === 'bed') {
    return names.bed;
  }
  return capitalize(heater.label);
}

/** Klipper section names are often lower case (`chamber`): `Chamber`. */
export function capitalize(text) {
  const value = String(text).slice(0, 40);
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function defaultName(slot, capabilities) {
  if (capabilities?.hostname) {
    return capabilities.hostname;
  }
  return slot === 1 ? 'Klipper' : `Klipper ${slot}`;
}

/**
 * @param {object} gladys
 * @param {{ slot: number, url: string, capabilities: object }} printer
 * @param {string} language
 */
export function buildDevice(gladys, { slot, url, capabilities }, language) {
  const names = NAMES[language] ?? NAMES.en;
  const ids = deviceIds(gladys, slot);
  const used = new Set();
  // Feature names must differ on a device: a sensor called "Bed" by the user
  // must not collide with the bed heater.
  const uniqueName = (name) => {
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
      candidate = `${name} (${n})`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  };
  const feature = (key, name, fields) => ({
    name: uniqueName(name),
    external_id: ids.feature(key),
    read_only: true,
    has_feedback: false,
    ...fields,
  });
  const text = { category: CAT.TEXT, type: TYPE.TEXT.TEXT, min: 0, max: 0 };
  const minutes = {
    category: CAT.DURATION,
    type: TYPE.DURATION.INTEGER,
    unit: UNIT.MINUTES,
    min: 0,
    max: MAX_MINUTES,
  };
  const layers = {
    category: CAT.COUNTER_SENSOR,
    type: TYPE.SENSOR.INTEGER,
    min: 0,
    max: MAX_LAYERS,
  };
  const temperature = (max) => ({
    category: CAT.DEVICE_TEMPERATURE_SENSOR,
    type: TYPE.SENSOR.DECIMAL,
    unit: UNIT.CELSIUS,
    min: 0,
    max,
  });

  const features = [
    feature('state', names.state, text),
    feature('file', names.file, text),
    feature('progress', names.progress, {
      category: CAT.LEVEL_SENSOR,
      type: TYPE.LEVEL_SENSOR.LIQUID_LEVEL_PERCENT,
      unit: UNIT.PERCENT,
      min: 0,
      max: 100,
    }),
    feature('time_elapsed', names.elapsed, minutes),
    feature('time_left', names.left, minutes),
    feature('layer', names.layer, layers),
    feature('layer_total', names.layerTotal, layers),
  ];

  for (const heater of capabilities.heaters) {
    const label = heaterName(names, heater);
    features.push(
      feature(`${heater.key}_temperature`, label, temperature(heater.max)),
      feature(`${heater.key}_target`, `${label} (${names.target})`, temperature(heater.max)),
    );
  }
  for (const sensor of capabilities.sensors) {
    features.push(feature(sensor.key, capitalize(sensor.label), temperature(sensor.max)));
  }

  if (capabilities.fan) {
    features.push(
      feature('fan', names.fan, {
        category: CAT.FAN,
        type: TYPE.FAN.PERCENT,
        unit: UNIT.PERCENT,
        min: 0,
        max: 100,
      }),
    );
  }

  for (const key of COMMAND_KEYS) {
    features.push(
      feature(key, names[key], {
        category: CAT.BUTTON,
        type: TYPE.BUTTON.PUSH,
        min: 0,
        max: 1,
        read_only: false,
      }),
    );
  }

  if (capabilities.camera) {
    features.push(
      feature('camera', names.camera, {
        category: CAT.CAMERA,
        type: TYPE.CAMERA.IMAGE,
        min: 0,
        max: 0,
      }),
    );
  }

  return {
    name: defaultName(slot, capabilities),
    external_id: ids.device,
    model: capabilities.version ? `Klipper ${capabilities.version}`.slice(0, 60) : 'Klipper',
    should_poll: false,
    features,
    params: [{ name: 'MOONRAKER_URL', value: url }],
  };
}

const round = (value) => (value === null || value === undefined ? null : Math.round(value));
const toMinutes = (seconds) => (seconds === null ? null : Math.round(seconds / 60));

/**
 * Feature states of a snapshot, in the publishStates format. Temperatures are
 * whole degrees and durations whole minutes: Gladys takes 300 states a minute
 * for the whole integration. Unknown values are left out (Gladys keeps the
 * last one).
 */
export function buildStates(gladys, { slot, capabilities }, snapshot, language) {
  const ids = deviceIds(gladys, slot);
  const states = [];
  const add = (key, value) => {
    if (value !== null && value !== undefined) {
      states.push({ device_feature_external_id: ids.feature(key), state: value });
    }
  };
  const addText = (key, text) => {
    states.push({ device_feature_external_id: ids.feature(key), text: String(text).slice(0, 200) });
  };

  addText('state', (STATE_LABELS[language] ?? STATE_LABELS.en)[snapshot.state]);
  if (DOWN_STATES.has(snapshot.state) || snapshot.state.startsWith('klippy_')) {
    // Klipper does not answer: everything else keeps its last value.
    return states;
  }
  addText('file', snapshot.file ?? NO_FILE[language] ?? NO_FILE.en);
  const active = ACTIVE_STATES.has(snapshot.state);
  add('progress', snapshot.progress === null ? 0 : Math.round(snapshot.progress));
  add('time_elapsed', snapshot.totalDuration === null ? 0 : toMinutes(snapshot.totalDuration));
  add('time_left', active ? toMinutes(snapshot.timeLeft) : 0);
  add('layer', snapshot.layer === null ? 0 : Math.round(snapshot.layer));
  add('layer_total', snapshot.layerTotal === null ? 0 : Math.round(snapshot.layerTotal));

  for (const heater of capabilities.heaters) {
    const reading = snapshot.temperatures[heater.key];
    if (reading) {
      add(`${heater.key}_temperature`, round(reading.actual));
      add(`${heater.key}_target`, round(reading.target));
    }
  }
  for (const sensor of capabilities.sensors) {
    add(sensor.key, round(snapshot.temperatures[sensor.key]?.actual));
  }
  if (capabilities.fan) {
    add('fan', snapshot.fan);
  }
  return states;
}

/** `ext:...:printer:2` -> 2, or null when the id is not one of ours. */
export function slotOf(gladys, externalId) {
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  const slot = Number(externalId.slice(prefix.length).split(':')[0]);
  return Number.isInteger(slot) ? slot : null;
}

/** The feature key of a feature external id (`...:printer:1:bed_target` -> `bed_target`). */
export function featureKeyOf(externalId) {
  return typeof externalId === 'string' ? externalId.split(':').at(-1) : '';
}
