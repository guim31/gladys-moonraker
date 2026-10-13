// The `printer` dashboard widget: contents checked with the SDK validator (the
// core's vocabulary and budget), live tiles cross-checked with the discovered
// devices (the validator does not know them), buttons by state, actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createMoonraker, settle } from './helpers/fakeMoonraker.js';
import { createWorld, deviceId } from './helpers/world.js';

const get = async (world, settings, language = 'en', units = 'metric') => {
  const ack = await world.gladys.fake.widgetGet('printer', { settings, language, units });
  assert.equal(ack.success, true, ack.error);
  return ack.data.content;
};

function assertValid(world, content) {
  const report = validateWidgetContent(content);
  assert.deepEqual(report.errors ?? [], [], JSON.stringify(report));
  assert.deepEqual(report.warnings ?? [], [], JSON.stringify(report));
  const features = new Set(
    world.gladys.fake.discoveredDevices.flatMap((d) => d.features.map((f) => f.external_id)),
  );
  for (const component of content.components) {
    if (component.device_feature) {
      assert.ok(features.has(component.device_feature), `${component.device_feature} exists`);
    }
  }
}

const buttons = (content) =>
  content.components
    .filter((c) => c.type === 'button')
    .map((c) => `${c.action.key}${c.action.confirm ? '!' : ''}`);
const status = (content) =>
  Object.fromEntries(
    content.components.find((c) => c.type === 'status').items.map((i) => [i.label, i.value]),
  );

test('without a printer, or with an unknown one, the widget says what to do', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  for (const [settings, pattern] of [
    [{}, /Choose a Klipper printer/],
    [{ device: deviceId(3) }, /not configured/],
  ]) {
    const content = await get(world, settings);
    assert.match(content.components[0].text, pattern);
    assertValid(world, content);
  }
});

test('at rest: progress, time left, nozzle and bed tiles, state, preheat and cool down', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const content = await get(world, { device: deviceId(1) }, 'fr');
  assertValid(world, content);
  assert.deepEqual(
    content.components.map((c) => c.type),
    ['gauge', 'value', 'value', 'value', 'status', 'button', 'button'],
  );
  assert.deepEqual(status(content), { État: 'Prête', Consignes: '60 °C' });
  // The bed target of the recorded printer is 60 °C: cool down is offered.
  assert.deepEqual(buttons(content), ['preheat', 'cool_down']);
  assert.equal(content.ttl_seconds, 300);
});

test('printing: layer, elapsed, end time, pause and a confirmed cancel', async (t) => {
  const clock = Date.parse('2026-10-13T10:00:00Z');
  const world = await createWorld({ now: () => clock });
  t.after(() => world.app.stop());
  const [server] = world.servers;
  server.setPrintState('printing', {
    filename: 'gladys-cube.gcode',
    total_duration: 3900,
    print_duration: 3800,
    info: { total_layer: 120, current_layer: 42 },
  });
  server.update({ display_status: { progress: 0.5 } });
  await settle();
  const content = await get(world, { device: deviceId(1) }, 'en', 'us');
  assertValid(world, content);
  const items = status(content);
  assert.equal(items.State, 'Printing');
  assert.equal(items.File, 'gladys-cube.gcode');
  assert.equal(items.Layer, '42 / 120');
  assert.equal(items.Elapsed, '1 h 05 min');
  assert.ok(items['Ends at'], 'the end time');
  assert.equal(items.Targets, '140 °F');
  assert.deepEqual(buttons(content), ['pause', 'cancel!']);
  assert.equal(content.ttl_seconds, 30);
  server.setPrintState('paused');
  await settle();
  const paused = await get(world, { device: deviceId(1) });
  assert.deepEqual(buttons(paused), ['resume', 'cancel!']);
  assert.equal(status(paused)['Ends at'], undefined, 'no end time while paused');
});

test('Klipper stopped: a confirmed restart button, nothing else', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const [server] = world.servers;
  server.shutdown();
  await settle();
  const content = await get(world, { device: deviceId(1) }, 'de');
  assertValid(world, content);
  assert.equal(status(content).Status, 'Klipper gestoppt (Shutdown)');
  assert.deepEqual(buttons(content), ['firmware_restart!']);
  const ack = await world.gladys.fake.widgetAction(
    'printer',
    'firmware_restart',
    {},
    { settings: { device: deviceId(1) } },
  );
  assert.equal(ack.success, true, ack.error);
  assert.equal(ack.data.message.de, 'Klipper startet neu.');
  assert.equal(server.callsOf('printer.firmware_restart').length, 1);
});

test('a printer with two nozzles and a chamber keeps within the budget', async (t) => {
  const world = await createWorld({ servers: [createMoonraker({ printer: 'rich' })] });
  t.after(() => world.app.stop());
  const content = await get(world, { device: deviceId(1) });
  assertValid(world, content);
  assert.ok(content.components.length <= 8);
});

test('widget actions: preheat with the widget settings, cool down, refusals as toasts', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  const [server] = world.servers;
  const tap = (key, settings = {}) =>
    fake.widgetAction('printer', key, {}, { settings: { device: deviceId(1), ...settings } });
  let ack = await tap('preheat', { preheat_tool: '215', preheat_bed: 70 });
  assert.equal(ack.success, true, ack.error);
  assert.equal(ack.data.message.fr, 'Préchauffage lancé.');
  assert.deepEqual(server.callsOf('printer.gcode.script').at(-1).params, {
    script:
      'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=215\nSET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=70',
  });
  ack = await tap('cool_down');
  assert.equal(ack.data.message.en, 'Heaters off.');
  assert.equal(server.callsOf('printer.gcode.script').at(-1).params.script, 'TURN_OFF_HEATERS');
  ack = await tap('pause');
  assert.equal(ack.success, true);
  assert.equal(ack.data.message.fr, 'Aucune impression en cours.', 'a refusal is a toast');
  ack = await tap('preheat', { preheat_tool: 300 });
  assert.equal(ack.data.message.en, 'Temperature out of range (0 to 250 °C).');
  ack = await tap('firmware_restart');
  assert.equal(ack.data.message.en, 'Klipper is not stopped on an error.');
  server.setPrintState('printing', { filename: 'a.gcode' });
  await settle();
  ack = await tap('preheat');
  assert.equal(ack.data.message.en, 'A print is in progress: temperatures left unchanged.');
  ack = await tap('cancel');
  assert.equal(ack.data.message.es, 'Cancelación solicitada.');
  assert.equal(server.callsOf('printer.print.cancel').length, 1);
});
