// The integration end to end, on the SDK's fake Gladys and fake Moonraker
// instances: devices, states, scene events, commands, connection status, API
// key, outages, Klipper stopped or restarting, webcam, persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_KEY,
  ERRORS,
  createMoonraker,
  fixture,
  settle,
  wait,
} from './helpers/fakeMoonraker.js';
import { createWorld, deviceId, featureId } from './helpers/world.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1000, 7)]);
const deviceOf = (world, slot = 1) =>
  world.gladys.fake.discoveredDevices.find((d) => d.external_id === deviceId(slot));
const featureOf = (world, key, slot = 1) =>
  deviceOf(world, slot).features.find((f) => f.external_id === featureId(key, slot));

test('one device per Moonraker, its states, and nothing polled by Gladys', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  const [device] = fake.discoveredDevices;
  assert.equal(device.external_id, deviceId(1));
  assert.equal(device.name, 'voron', 'the host name of the printer');
  assert.equal(device.model, 'Klipper');
  assert.equal(device.should_poll, false);
  assert.deepEqual(device.params, [{ name: 'MOONRAKER_URL', value: 'http://192.0.2.10:7125' }]);
  assert.equal(fake.lastState(featureId('state')), 'Prête');
  assert.equal(fake.lastState(featureId('file')), 'Aucun fichier');
  assert.equal(fake.lastState(featureId('extruder_temperature')), 103);
  assert.equal(fake.lastState(featureId('bed_target')), 60);
  assert.equal(fake.lastState(featureId('progress')), 0);
  assert.equal(fake.lastState(featureId('fan')), 0);
  assert.deepEqual(fake.connectionStatus, { connected: true });
  // Klipper's own limit (max_temp) is the bound of the feature.
  assert.equal(featureOf(world, 'extruder_target').max, 250);
  assert.equal(featureOf(world, 'bed_target').max, 130);
  // Only read-only features, but the pause and resume buttons.
  const writable = device.features.filter((f) => !f.read_only).map((f) => f.external_id);
  assert.deepEqual(writable, [featureId('pause'), featureId('resume')]);
  assert.ok(!device.features.some((f) => f.category === 'thermostat'), 'no settable heater');
  assert.ok(!device.features.some((f) => f.category === 'temperature-sensor'), 'no room sensor');
});

test('states follow the pushes of Moonraker without any poll; onPoll is only a fallback', async (t) => {
  // Gladys#3198: core 5.2.0 never polls a device created without should_poll.
  // Nothing may wait for onPoll: Moonraker pushes, the integration publishes.
  const world = await createWorld();
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  const [server] = world.servers;
  const poll = t.mock.method(world.hub, 'poll');
  assert.equal(deviceOf(world).should_poll, false);
  assert.equal(deviceOf(world).poll_frequency, undefined);
  server.update({ extruder: { temperature: 187, target: 210 } });
  await settle();
  assert.equal(fake.lastState(featureId('extruder_temperature')), 187);
  assert.equal(fake.lastState(featureId('extruder_target')), 210);
  server.setPrintState('printing', { filename: 'benchy.gcode' });
  await settle();
  assert.equal(fake.lastState(featureId('state')), 'Impression');
  assert.equal(poll.mock.callCount(), 0, 'refreshed without a single onPoll');
  // A Gladys that polls anyway gets the states again.
  world.gladys.forgetPublishedStates();
  const before = fake.states.length;
  const ack = await fake.poll(deviceOf(world));
  assert.equal(ack.success, true);
  assert.equal(poll.mock.callCount(), 1);
  assert.ok(fake.states.length > before, 'onPoll republishes');
});

test('a richer printer: two nozzles, a heated chamber, a host sensor, a webcam', async (t) => {
  const server = createMoonraker({ printer: 'rich', image: JPEG });
  const world = await createWorld({ servers: [server] });
  t.after(() => world.app.stop());
  const keys = deviceOf(world).features.map((f) => f.external_id.split(':').at(-1));
  assert.deepEqual(keys, [
    'state',
    'file',
    'progress',
    'time_elapsed',
    'time_left',
    'layer',
    'layer_total',
    'extruder_temperature',
    'extruder_target',
    'extruder1_temperature',
    'extruder1_target',
    'bed_temperature',
    'bed_target',
    'heater_chamber_temperature',
    'heater_chamber_target',
    'sensor_raspberry_pi',
    'fan',
    'pause',
    'resume',
    'camera',
  ]);
  assert.equal(featureOf(world, 'extruder1_temperature').name, 'Buse 2');
  assert.equal(featureOf(world, 'heater_chamber_target').name, 'Chamber (consigne)');
  assert.equal(featureOf(world, 'heater_chamber_target').max, 80, 'its max_temp');
  assert.equal(featureOf(world, 'sensor_raspberry_pi').name, 'Raspberry Pi');
  assert.equal(world.gladys.fake.lastState(featureId('sensor_raspberry_pi')), 28);
  // Only the objects the integration reads are subscribed to.
  const [subscribe] = server.callsOf('printer.objects.subscribe');
  assert.deepEqual(Object.keys(subscribe.params.objects).sort(), [
    'display_status',
    'extruder',
    'extruder1',
    'fan',
    'heater_bed',
    'heater_generic chamber',
    'print_stats',
    'temperature_sensor Raspberry Pi',
    'virtual_sdcard',
    'webhooks',
  ]);
});

test('a print: progress, layer, time left from the slicer estimate, only changes published', async (t) => {
  let clock = Date.parse('2026-10-13T10:00:00Z');
  const world = await createWorld({ now: () => clock });
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  const [server] = world.servers;
  server.setPrintState('printing', {
    filename: 'gladys-cube.gcode',
    info: { total_layer: 3, current_layer: 1 },
  });
  await settle();
  server.update({
    display_status: { progress: 0.25 },
    print_stats: { total_duration: 1800, print_duration: 1500 },
  });
  await settle();
  assert.equal(fake.lastState(featureId('state')), 'Impression');
  assert.equal(fake.lastState(featureId('file')), 'gladys-cube.gcode');
  assert.equal(fake.lastState(featureId('progress')), 25);
  assert.equal(fake.lastState(featureId('time_elapsed')), 30);
  // The recorded metadata says 40 s for the whole file: 75 % of it is left.
  assert.equal(fake.lastState(featureId('time_left')), 1);
  assert.equal(fake.lastState(featureId('layer')), 1);
  assert.equal(fake.lastState(featureId('layer_total')), 3);
  const count = fake.states.length;
  server.update({ print_stats: { total_duration: 1801 } });
  await settle();
  assert.equal(fake.states.length, count, 'a change within the same minute publishes nothing');
  server.setPrintState('complete');
  await settle();
  assert.equal(fake.lastState(featureId('state')), 'Terminée');
  assert.equal(fake.lastState(featureId('progress')), 100);
  assert.equal(fake.lastState(featureId('time_left')), 0);
  clock += 1000;
});

test('without a slicer estimate, the time left extrapolates the file progress', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const [server] = world.servers;
  server.setPrintState('printing', { filename: 'other.gcode' });
  await settle();
  server.update({
    display_status: { progress: 0.5 },
    print_stats: { print_duration: 3600, total_duration: 3700 },
  });
  await settle();
  assert.equal(world.gladys.fake.lastState(featureId('time_left')), 60);
  assert.ok(server.callsOf('server.files.metadata').length >= 1);
});

test('states are handed to Gladys at most every updateInterval, a state change at once', async (t) => {
  const world = await createWorld({
    timings: {
      updateInterval: 150,
      klippyRetry: 30,
      cameraInterval: 60_000,
      commandTimeout: 200,
      cameraTimeout: 200,
    },
  });
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  const [server] = world.servers;
  const temperatures = () =>
    fake.states.filter((s) => s.device_feature_external_id === featureId('extruder_temperature'));
  const before = temperatures().length;
  for (const value of [110, 120, 130, 140]) {
    server.update({ extruder: { temperature: value } });
    await settle();
  }
  assert.equal(temperatures().length, before, 'held back');
  await wait(200);
  await settle();
  assert.deepEqual(
    temperatures()
      .slice(before)
      .map((s) => s.state),
    [140],
    'one state, the last value',
  );
  server.setPrintState('printing', { filename: 'a.gcode' });
  await settle();
  assert.equal(fake.lastState(featureId('state')), 'Impression', 'a state change goes at once');
});

test('the recorded print session fires the triggers in order', async (t) => {
  const server = createMoonraker();
  // The session starts from the state recorded just before it.
  server.status = {
    ...server.status,
    ...fixture('single-subscribe-after-cancel.json').status,
  };
  const world = await createWorld({ servers: [server] });
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  assert.equal(fake.lastState(featureId('state')), 'Annulée');
  for (const { message } of fixture('print-session.json')) {
    if (message.method === 'notify_status_update') {
      server.update(message.params[0]);
    } else if (message.method === 'notify_klippy_shutdown') {
      server.klippyState = 'shutdown';
      server.notify(message.method);
    } else {
      server.notify(message.method, message.params);
    }
    await settle(2);
  }
  await settle();
  assert.deepEqual(
    fake.sceneEvents.map((e) => [e.key, e.data.reason ?? null]),
    [
      ['print_started', null],
      ['print_paused', null],
      ['print_failed', 'cancelled'],
      ['klipper_shutdown', null],
    ],
  );
  const failed = fake.sceneEvents[2].data;
  assert.equal(failed.file, 'gladys-cube.gcode');
  assert.equal(failed.printer, 'voron');
  assert.equal(typeof failed.duration_minutes, 'number');
  assert.equal(fake.sceneEvents[3].data.message, 'Shutdown due to webhooks request');
  assert.equal(fake.lastState(featureId('state')), 'Klipper arrêté (shutdown)');
});

function replay(server, name) {
  return (async () => {
    for (const { message } of fixture(name)) {
      if (message.method === 'notify_status_update') {
        server.update(message.params[0]);
      } else {
        server.notify(message.method, message.params);
      }
      await settle(2);
    }
    await settle();
  })();
}

test('recorded sessions: a finished print, a print failing at once', async (t) => {
  const server = createMoonraker({ printer: 'rich' });
  const world = await createWorld({ servers: [server] });
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  // Klipper refused to extrude cold: standby to error in a single update.
  await replay(server, 'print-error-session.json');
  assert.deepEqual(
    fake.sceneEvents.map((e) => [e.key, e.data.file, e.data.reason ?? null]),
    [['print_failed', 'tiny.gcode', 'error']],
  );
  assert.equal(fake.lastState(featureId('state')), "Erreur d'impression");
  // The same file, without extrusion, printed to the end.
  await replay(server, 'print-complete-session.json');
  assert.deepEqual(
    fake.sceneEvents.slice(1).map((e) => e.key),
    ['print_started', 'print_done'],
  );
  assert.equal(fake.lastState(featureId('state')), 'Terminée');
  assert.equal(fake.lastState(featureId('progress')), 100);
  assert.equal(fake.lastState(featureId('layer')), 2);
});

test('states are published again when the user adds the device', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  const before = fake.states.length;
  await fake.deviceCreated(fake.discoveredDevices[0]);
  await settle();
  const again = fake.states.slice(before).map((s) => s.device_feature_external_id);
  assert.ok(again.includes(featureId('state')));
  assert.ok(again.includes(featureId('extruder_temperature')));
  assert.ok(fake.widgetRefreshes.includes('printer'));
});

test('the API key authenticates the connection, a refused key says so', async (t) => {
  const server = createMoonraker({ apiKey: API_KEY });
  const world = await createWorld({
    servers: [server],
    config: { url_1: server.host, api_key_1: API_KEY },
  });
  t.after(() => world.app.stop());
  const [identify] = server.callsOf('server.connection.identify');
  assert.equal(identify.params.api_key, API_KEY);
  assert.equal(identify.params.client_name, 'gladys-moonraker');
  assert.deepEqual(world.gladys.fake.connectionStatus, { connected: true });

  await world.gladys.fake.configUpdated({ url_1: server.host, api_key_1: 'WRONG' });
  await settle(40);
  const fake = world.gladys.fake;
  assert.equal(fake.lastState(featureId('state')), "Clé d'API absente ou refusée");
  assert.equal(fake.connectionStatus.connected, false);
  assert.match(fake.connectionStatus.message.fr, /Imprimante 1 : clé d'API absente ou refusée/);
  assert.doesNotMatch(JSON.stringify(fake.connectionStatuses), /WRONG|TEST0123/);
});

test('no key from an untrusted network: unauthorized, retried slowly', async (t) => {
  const server = createMoonraker({ apiKey: API_KEY });
  const world = await createWorld({ servers: [server] });
  t.after(() => world.app.stop());
  assert.equal(world.gladys.fake.lastState(featureId('state')), undefined, 'no device yet');
  assert.equal(world.gladys.fake.connectionStatus.connected, false);
  assert.match(world.gladys.fake.connectionStatus.message.en, /API key missing or refused/);
  assert.equal(server.callsOf('server.connection.identify')[0].params.api_key, undefined);
  assert.equal(server.callsOf('server.info').length, 0, 'nothing asked before the identification');
});

test('Moonraker down: the state says so, the link comes back by itself', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  const [server] = world.servers;
  server.goDown();
  await settle(40);
  assert.equal(fake.lastState(featureId('state')), 'Moonraker injoignable');
  assert.equal(fake.connectionStatus.connected, false);
  assert.match(fake.connectionStatus.message.fr, /Moonraker ne répond pas/);
  server.goUp();
  await wait(150);
  await settle(40);
  assert.equal(fake.lastState(featureId('state')), 'Prête');
  assert.deepEqual(fake.connectionStatus, { connected: true });
  assert.equal(server.callsOf('printer.objects.subscribe').length, 2, 'subscribed again');
});

test('an address that never answered: no device, a clear status', async (t) => {
  const world = await createWorld({ config: { url_1: '198.51.100.99' } });
  t.after(() => world.app.stop());
  await wait(50);
  await settle();
  assert.deepEqual(world.gladys.fake.discoveredDevices, []);
  assert.match(
    world.gladys.fake.connectionStatus.message.en,
    /Printer 1: Moonraker does not answer/,
  );
});

test('a print lost when Klipper shuts down: print_failed (error) and klipper_shutdown', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  const [server] = world.servers;
  server.setPrintState('printing', { filename: 'benchy.gcode', total_duration: 600 });
  await settle();
  server.shutdown(ERRORS.shutdown.message.replace('webhooks request', 'heater extruder fault'));
  await settle();
  assert.deepEqual(
    fake.sceneEvents.map((e) => e.key),
    ['print_started', 'klipper_shutdown', 'print_failed'],
  );
  assert.equal(fake.sceneEvents[1].data.message, 'Shutdown due to heater extruder fault');
  assert.equal(fake.sceneEvents[2].data.reason, 'error');
  assert.equal(fake.sceneEvents[2].data.duration_minutes, 10);
  // Commands are refused while Klipper is stopped.
  const ack = await fake.sceneAction('control_print', { device: deviceId(1), command: 'pause' });
  assert.deepEqual(ack.data.outputs, { applied: false });
});

test('Klipper already stopped at start: its state and message, no trigger', async (t) => {
  const server = createMoonraker();
  server.klippyState = 'shutdown';
  server.status.webhooks = {
    state: 'shutdown',
    state_message: "MCU 'mcu' shutdown: ADC out of range\nmore",
  };
  const world = await createWorld({ servers: [server] });
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  assert.equal(fake.lastState(featureId('state')), undefined, 'never seen ready: no device yet');
  assert.deepEqual(fake.sceneEvents, []);
  assert.equal(world.hub.printers.get(1).link.snapshot.state, 'klippy_shutdown');
  assert.equal(
    world.hub.printers.get(1).link.snapshot.message,
    "MCU 'mcu' shutdown: ADC out of range",
  );
  // Klipper restarted by the user: ready again, the device appears.
  server.klippyState = 'ready';
  server.status.webhooks = { state: 'ready', state_message: 'Printer is ready' };
  server.notify('notify_klippy_ready');
  await settle(40);
  assert.equal(fake.lastState(featureId('state')), 'Prête');
});

test('Klipper restarting: disconnected, then subscribed again when ready', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  const [server] = world.servers;
  server.klippyDisconnect();
  await settle();
  assert.equal(fake.lastState(featureId('state')), 'Klipper déconnecté');
  server.klippyReady();
  await settle(40);
  assert.equal(fake.lastState(featureId('state')), 'Prête');
  assert.equal(server.callsOf('printer.objects.subscribe').length, 2);
  server.update({ extruder: { temperature: 180 } });
  await settle();
  assert.equal(
    fake.lastState(featureId('extruder_temperature')),
    180,
    'the new subscription works',
  );
});

test('a stuck Klipper (no answer) is retried until it answers', async (t) => {
  const server = createMoonraker();
  server.overrides['printer.objects.list'] = () => undefined;
  const world = await createWorld({ servers: [server] });
  t.after(() => world.app.stop());
  await wait(250);
  await settle();
  assert.equal(world.hub.printers.get(1).link.snapshot.state, 'klippy_disconnected');
  delete server.overrides['printer.objects.list'];
  await wait(400);
  await settle(40);
  assert.equal(world.gladys.fake.lastState(featureId('state')), 'Prête');
});

test('pause and resume buttons; refused when there is nothing to pause', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  const [server] = world.servers;
  const device = deviceOf(world);
  const pause = device.features.find((f) => f.external_id === featureId('pause'));
  const resume = device.features.find((f) => f.external_id === featureId('resume'));
  let ack = await fake.setValue(device, pause, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Aucune impression en cours/);
  server.setPrintState('printing', { filename: 'a.gcode' });
  await settle();
  ack = await fake.setValue(device, pause, 1);
  assert.equal(ack.success, true, ack.error);
  await settle();
  assert.equal(fake.lastState(featureId('state')), 'En pause');
  ack = await fake.setValue(device, resume, 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(server.callsOf('printer.print.pause').length, 1);
  assert.equal(server.callsOf('printer.print.resume').length, 1);
  const target = device.features.find((f) => f.external_id === featureId('extruder_target'));
  ack = await fake.setValue(device, target, 200);
  assert.equal(ack.success, false, 'heaters are not settable as a feature');
});

test('a command Klipper is slow to acknowledge is taken as accepted', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const [server] = world.servers;
  server.setPrintState('printing', { filename: 'a.gcode' });
  await settle();
  server.overrides['printer.print.pause'] = () => undefined; // waits for the moves in the queue
  const ack = await world.gladys.fake.sceneAction('control_print', {
    device: deviceId(1),
    command: 'pause',
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { applied: true });
});

test('Klipper refusing a command: its reason reaches the user', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const [server] = world.servers;
  server.overrides['printer.gcode.script'] = () => ({ error: ERRORS.sd_busy });
  const ack = await world.gladys.fake.sceneAction('cool_down', { device: deviceId(1) });
  assert.equal(ack.success, false);
  assert.match(ack.error, /Refusé par Klipper : SD busy/);
});

test('reconfiguration: a new address keeps the device, a new language renames the states', async (t) => {
  const first = createMoonraker({ host: '192.0.2.10' });
  const moved = createMoonraker({ host: '192.0.2.20' });
  const world = await createWorld({ servers: [first, moved] });
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  await fake.configUpdated({ url_1: 'http://192.0.2.20:7125', language: 'en' });
  await settle(40);
  assert.equal(first.sockets.size, 0, 'the old link is closed');
  assert.equal(deviceOf(world).external_id, deviceId(1));
  assert.equal(deviceOf(world).params[0].value, 'http://192.0.2.20:7125');
  assert.equal(fake.lastState(featureId('state')), 'Ready');
  assert.equal(deviceOf(world).features[0].name, 'State');
});

test('an invalid address and no address at all are reported', async (t) => {
  const world = await createWorld({ config: { url_1: 'ftp://nope' } });
  t.after(() => world.app.stop());
  assert.match(world.gladys.fake.connectionStatus.message.fr, /Imprimante 1 : adresse invalide/);
  await world.gladys.fake.configUpdated({});
  await settle();
  assert.match(
    world.gladys.fake.connectionStatus.message.en,
    /Enter the address of your Moonraker/,
  );
});

test('the capabilities survive a restart while Moonraker is off', async (t) => {
  const world = await createWorld();
  await world.app.stop();
  const [server] = world.servers;
  server.goDown();
  const again = await createWorld({ servers: [server], dataDir: world.dataDir });
  t.after(() => again.app.stop());
  assert.equal(again.gladys.fake.discoveredDevices.length, 1, 'the device stays in Discovery');
  assert.equal(deviceOf(again).features.length, deviceOf(world).features.length);
});

test('"Test the connection" lists the state and the macros of each printer', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const ack = await world.gladys.fake.action('test_connection');
  assert.equal(ack.success, true, ack.error);
  const message = ack.data.message;
  assert.match(message.fr, /^Imprimante 1 : Prête\.\nMacros : CANCEL_PRINT, END_PRINT, G12/);
  assert.doesNotMatch(message.en, /_CLIENT_LINEAR_MOVE/, 'private macros are hidden');
});

test('the webcam: a snapshot through its own address, never with the API key', async (t) => {
  const server = createMoonraker({ printer: 'rich', image: JPEG, apiKey: API_KEY });
  const world = await createWorld({
    servers: [server],
    config: { url_1: server.host, api_key_1: API_KEY },
  });
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  const ack = await fake.getImage(deviceOf(world));
  assert.equal(ack.success, true, ack.error);
  assert.equal(ack.data.image, `image/jpg;base64,${JPEG.toString('base64')}`);
  // Moonraker said http://localhost:8080/?action=snapshot: the printer's host.
  const fetched = world.net.fetches.at(-1);
  assert.equal(fetched.url, 'http://192.0.2.10:8080/?action=snapshot');
  assert.equal(fetched.options.headers, undefined, 'no API key sent to the webcam');
  assert.equal(fetched.options.redirect, 'manual');
  // Pushed when the device is added, then every minute.
  await fake.deviceCreated(deviceOf(world));
  await settle(40);
  assert.equal(fake.cameraImages.at(-1).device_external_id, featureId('camera'));

  server.image = Buffer.concat([JPEG, Buffer.alloc(150 * 1024)]);
  const tooBig = await fake.getImage(deviceOf(world));
  assert.equal(tooBig.success, false);
  assert.match(tooBig.error, /dépasse 150 Ko/);
  server.image = Buffer.from('<html>');
  assert.match((await fake.getImage(deviceOf(world))).error, /pas un JPEG/);
});

test('snapshot addresses: relative to the web server, or naming the Pi itself', async () => {
  const { PrinterLink } = await import('../src/printer.js');
  const link = (url, snapshotUrl) => {
    const printer = new PrinterLink({ slot: 1, url, apiKey: '' });
    printer.capabilities = { camera: { snapshotUrl } };
    return printer.snapshotUrl();
  };
  assert.equal(
    link('http://192.0.2.10:7125', '/webcam/?action=snapshot'),
    'http://192.0.2.10/webcam/?action=snapshot',
  );
  assert.equal(
    link('https://printer.example', '/webcam/?action=snapshot'),
    'https://printer.example/webcam/?action=snapshot',
  );
  assert.equal(
    link('http://192.0.2.10:8081', 'webcam2/?action=snapshot'),
    'http://192.0.2.10:8081/webcam2/?action=snapshot',
  );
  assert.equal(
    link('http://192.0.2.10:7125', 'http://127.0.0.1:8080/?action=snapshot'),
    'http://192.0.2.10:8080/?action=snapshot',
  );
  assert.equal(
    link('http://192.0.2.10:7125', 'http://198.51.100.7/snap.jpg'),
    'http://198.51.100.7/snap.jpg',
  );
  assert.equal(link('http://192.0.2.10:7125', 'rtsp://192.0.2.10/stream'), null);
});

test('refused after the identification: the link is dropped and retried, then recovers', async (t) => {
  const server = createMoonraker();
  server.overrides['server.info'] = () => ({ error: ERRORS.unauthorized });
  const world = await createWorld({ servers: [server] });
  t.after(() => world.app.stop());
  assert.equal(world.hub.printers.get(1).link.snapshot.state, 'unauthorized');
  const identifies = server.callsOf('server.connection.identify').length;
  delete server.overrides['server.info']; // the user trusted the network of Gladys
  await wait(250);
  await settle(40);
  assert.ok(server.callsOf('server.connection.identify').length > identifies, 'retried');
  assert.equal(world.gladys.fake.lastState(featureId('state')), 'Prête');
});

test('a slicer estimate that did not answer is asked again', async (t) => {
  const server = createMoonraker();
  let calls = 0;
  server.overrides['server.files.metadata'] = () => {
    calls += 1;
    return calls === 1 ? undefined : server.metadata; // first one never answers
  };
  const world = await createWorld({ servers: [server] });
  t.after(() => world.app.stop());
  server.setPrintState('printing', { filename: server.metadata.filename });
  await wait(250);
  server.update({ display_status: { progress: 0.5 } });
  await settle();
  assert.equal(calls, 2);
  assert.equal(
    world.hub.printers.get(1).link.metadata.estimatedTime,
    server.metadata.estimated_time,
  );
});

test('a webcam address giving an endless stream is cut at the size limit', async (t) => {
  const server = createMoonraker({ printer: 'rich', image: JPEG });
  let pulled = 0;
  server.snapshot = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      }),
      { status: 200, headers: { 'content-type': 'multipart/x-mixed-replace' } },
    );
  const world = await createWorld({ servers: [server] });
  t.after(() => world.app.stop());
  const ack = await world.gladys.fake.getImage(deviceOf(world));
  assert.equal(ack.success, false);
  assert.match(ack.error, /dépasse 150 Ko/);
  assert.ok(pulled < 10, `stopped reading (${pulled} chunks)`);
});
