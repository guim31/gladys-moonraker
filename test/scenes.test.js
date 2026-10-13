// Scene actions: control_print, preheat, cool_down, run_macro. A refusal is
// `applied: false`; an unknown printer or macro fails the action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMoonraker, settle } from './helpers/fakeMoonraker.js';
import { createWorld, deviceId } from './helpers/world.js';

const run = (world, key, fields) =>
  world.gladys.fake.sceneAction(key, { device: deviceId(1), ...fields });

test('control_print: pause, resume, cancel; nothing to do is not applied', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const [server] = world.servers;
  let ack = await run(world, 'control_print', { command: 'pause' });
  assert.deepEqual(ack.data.outputs, { applied: false });
  server.setPrintState('printing', { filename: 'a.gcode' });
  await settle();
  ack = await run(world, 'control_print', { command: 'pause' });
  assert.deepEqual(ack.data.outputs, { applied: true });
  await settle();
  ack = await run(world, 'control_print', { command: 'resume' });
  assert.deepEqual(ack.data.outputs, { applied: true });
  await settle();
  ack = await run(world, 'control_print', { command: 'cancel' });
  assert.deepEqual(ack.data.outputs, { applied: true });
  ack = await run(world, 'control_print', { command: 'shutdown' });
  assert.equal(ack.success, false);
});

test('preheat: every nozzle and the bed, within Klipper limits, never during a print', async (t) => {
  const world = await createWorld({ servers: [createMoonraker({ printer: 'rich' })] });
  t.after(() => world.app.stop());
  const [server] = world.servers;
  let ack = await run(world, 'preheat', { tool_temperature: '240,4', bed_temperature: 100 });
  assert.deepEqual(ack.data.outputs, { applied: true });
  assert.equal(
    server.callsOf('printer.gcode.script').at(-1).params.script,
    [
      'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=240',
      'SET_HEATER_TEMPERATURE HEATER=extruder1 TARGET=240',
      'SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=100',
    ].join('\n'),
    'the chamber is left alone',
  );
  ack = await run(world, 'preheat', { tool_temperature: 260 });
  assert.equal(ack.success, false);
  assert.match(ack.error, /0 à 250 °C/);
  ack = await run(world, 'preheat', { tool_temperature: 'hot' });
  assert.equal(ack.success, false);
  server.setPrintState('printing', { filename: 'a.gcode' });
  await settle();
  ack = await run(world, 'preheat', {});
  assert.deepEqual(ack.data.outputs, { applied: false });
});

test('cool_down: TURN_OFF_HEATERS, during a print too', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const [server] = world.servers;
  server.setPrintState('printing', { filename: 'a.gcode' });
  await settle();
  const ack = await run(world, 'cool_down', {});
  assert.deepEqual(ack.data.outputs, { applied: true });
  assert.equal(server.callsOf('printer.gcode.script').at(-1).params.script, 'TURN_OFF_HEATERS');
});

test('run_macro: only a macro the printer lists, by its name, nothing else', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const [server] = world.servers;
  let ack = await run(world, 'run_macro', { macro: ' end_print ' });
  assert.deepEqual(ack.data.outputs, { applied: true });
  assert.equal(server.callsOf('printer.gcode.script').at(-1).params.script, 'END_PRINT');
  const sent = server.callsOf('printer.gcode.script').length;
  for (const macro of [
    'LIGHTS_ON',
    '_CLIENT_LINEAR_MOVE',
    'END_PRINT\nM112',
    'END_PRINT TEMP=300',
    'M112',
    '',
  ]) {
    ack = await run(world, 'run_macro', { macro });
    assert.equal(ack.success, false, JSON.stringify(macro));
  }
  assert.match(ack.error, /Saisissez le nom d'une macro/);
  assert.equal(server.callsOf('printer.gcode.script').length, sent, 'nothing else was sent');
  server.shutdown();
  await settle();
  ack = await run(world, 'run_macro', { macro: 'END_PRINT' });
  assert.deepEqual(ack.data.outputs, { applied: false }, 'Klipper stopped');
});

test('an unknown printer fails the action', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const ack = await world.gladys.fake.sceneAction('cool_down', { device: deviceId(3) });
  assert.equal(ack.success, false);
  assert.match(ack.error, /n'est plus configurée/);
});
