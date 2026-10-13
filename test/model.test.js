// Reading Moonraker answers: capabilities from the recorded printers, the
// snapshot, the time left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeObject,
  mergeStatus,
  readCapabilities,
  readSnapshot,
  sameStructure,
  slug,
  subscriptionOf,
  timeLeft,
} from '../src/moonraker/model.js';
import { fixture } from './helpers/fakeMoonraker.js';

const capabilitiesOf = (printer) =>
  readCapabilities({
    objects: fixture(`${printer}-objects-list.json`).objects,
    heaters: fixture(`${printer}-query-heaters-configfile.json`).status.heaters,
    settings: fixture(`${printer}-query-heaters-configfile.json`).status.configfile.settings,
    webcams: fixture(`${printer}-webcams-list.json`),
    info: fixture(`${printer}-printer-info.json`),
  });

test('capabilities of the recorded printers', () => {
  const single = capabilitiesOf('single');
  assert.deepEqual(
    single.heaters.map((h) => [h.key, h.heater, h.max]),
    [
      ['extruder', 'extruder', 250],
      ['bed', 'heater_bed', 130],
    ],
  );
  assert.deepEqual(single.sensors, []);
  assert.equal(single.fan, true);
  assert.equal(single.camera, null);
  assert.equal(single.hostname, 'voron');
  assert.equal(single.version, '', 'Klipper says "?" without its git history');
  assert.ok(single.macros.includes('CANCEL_PRINT'));
  assert.ok(!single.macros.some((m) => m.startsWith('_')), 'private macros hidden');

  const rich = capabilitiesOf('rich');
  assert.deepEqual(
    rich.heaters.map((h) => [h.key, h.kind, h.heater, h.max]),
    [
      ['extruder', 'extruder', 'extruder', 250],
      ['extruder1', 'extruder', 'extruder1', 250],
      ['bed', 'bed', 'heater_bed', 130],
      ['heater_chamber', 'generic', 'chamber', 80],
    ],
  );
  assert.deepEqual(
    rich.sensors.map((s) => [s.key, s.label]),
    [['sensor_raspberry_pi', 'Raspberry Pi']],
  );
  assert.deepEqual(rich.camera, {
    name: 'printer_cam',
    snapshotUrl: 'http://localhost:8080/?action=snapshot',
  });
  assert.ok(rich.macros.includes('LIGHTS_ON'));
  assert.ok(!rich.macros.includes('_HELPER'));
  assert.equal(sameStructure(single, rich), false);
  assert.equal(sameStructure(rich, capabilitiesOf('rich')), true);
  assert.deepEqual(subscriptionOf(rich)['temperature_sensor Raspberry Pi'], ['temperature']);
});

test('object names: heaters and sensors, the rest ignored; keys are [a-z0-9_]', () => {
  assert.equal(describeObject('extruder3').index, 3);
  assert.equal(describeObject('heater_generic Chamber Heater').key, 'heater_chamber_heater');
  assert.equal(describeObject('temperature_fan électronique').key, 'sensor_electronique');
  assert.equal(describeObject('tmc2209 stepper_x'), null);
  assert.equal(describeObject('fan'), null);
  assert.equal(slug('***'), 'x');
  // Two sensors whose names give the same key: the second one is numbered.
  const caps = readCapabilities({
    objects: [],
    heaters: {
      available_heaters: [],
      available_sensors: ['temperature_sensor A b', 'temperature_sensor a-b'],
    },
  });
  assert.deepEqual(
    caps.sensors.map((s) => s.key),
    ['sensor_a_b', 'sensor_a_b_2'],
  );
});

test('the snapshot: Klipper state first, print state, progress and temperatures', () => {
  const capabilities = capabilitiesOf('single');
  const status = mergeStatus({}, fixture('single-subscribe-after-cancel.json').status);
  let snapshot = readSnapshot(status, capabilities, { klippyState: 'ready' });
  assert.equal(snapshot.state, 'cancelled');
  assert.equal(snapshot.file, 'gladys-cube.gcode');
  assert.deepEqual(snapshot.temperatures.bed, { actual: 103.26, target: 60 });
  snapshot = readSnapshot(
    mergeStatus(status, { webhooks: { state: 'shutdown', state_message: 'Boom\nmore' } }),
    capabilities,
    { klippyState: 'ready' },
  );
  assert.equal(snapshot.state, 'klippy_shutdown');
  assert.equal(snapshot.message, 'Boom');
  snapshot = readSnapshot(
    mergeStatus(status, { print_stats: { state: 'complete' }, display_status: { progress: 0.97 } }),
    capabilities,
    { klippyState: 'ready' },
  );
  assert.equal(snapshot.progress, 100, 'a finished print is 100 %');
});

test('time left: the slicer estimate, else the file progress once it means something', () => {
  assert.equal(timeLeft(25, 100, 4000), 3000);
  assert.equal(timeLeft(50, 3600, null), 3600);
  assert.equal(timeLeft(0.5, 30, null), null, 'too early to extrapolate');
  assert.equal(timeLeft(null, 30, 4000), null);
  assert.equal(timeLeft(100, 3600, 4000), 0);
});
