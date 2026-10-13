// What reaches `docker logs` at the default level (info): the lifecycle only.
// A normal cycle (pushed updates, published states) writes nothing at info, a
// repeated failure logs one line, and its recovery one more.
//
// The SDK logger writes through console.log (debug, info) and console.error
// (warn, error), re-reading LOG_LEVEL on every call: the tests capture both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMoonraker, settle, wait } from './helpers/fakeMoonraker.js';
import { createWorld, featureId } from './helpers/world.js';

/** Capture every log line from now on; `lines()` keeps info and above. */
function captureLogs(t) {
  const previous = process.env.LOG_LEVEL;
  // Debug lines are produced too (they must not break anything), then filtered.
  process.env.LOG_LEVEL = 'debug';
  const captured = [];
  const record = (...args) => captured.push(args.map(String).join(' '));
  t.mock.method(console, 'log', record);
  t.mock.method(console, 'error', record);
  t.after(() => {
    if (previous === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = previous;
    }
  });
  return {
    all: () => [...captured],
    lines: () => captured.filter((line) => !line.includes('[DEBUG]')),
    reset: () => captured.splice(0),
  };
}

test('a normal cycle writes nothing at info: updates, prints, states, webcam rounds', async (t) => {
  const logs = captureLogs(t);
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1000, 7)]);
  const server = createMoonraker({ printer: 'rich', image: JPEG });
  const world = await createWorld({ servers: [server] });
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  await fake.deviceCreated(fake.discoveredDevices[0]);
  await settle();
  // The start: lifecycle lines only, a handful.
  const start = logs.lines().filter((line) => line.includes('[moonraker-'));
  assert.ok(
    start.some((line) => /Printer 1: connected to Moonraker$/.test(line)),
    start.join(),
  );
  assert.ok(
    start.some((line) => /Printer 1: Klipper ready/.test(line)),
    start.join(),
  );
  assert.ok(start.length <= 3, start.join('\n'));
  logs.reset();

  const before = fake.states.length;
  for (let i = 0; i < 20; i += 1) {
    server.update({
      extruder: { temperature: 100 + i },
      heater_bed: { temperature: 50 + i / 2 },
      print_stats: { total_duration: 10 + i },
    });
    server.procStat();
    await settle(5);
  }
  await world.hub.publishAllStates();
  for (let i = 0; i < 3; i += 1) {
    world.hub.printers.get(1).link.emit('camera');
    await settle();
  }
  await fake.poll(fake.discoveredDevices[0]);
  await settle();
  assert.ok(fake.states.length > before, 'states were published');
  assert.deepEqual(logs.lines(), [], 'nothing at info or above');
});

test('Moonraker down: one warning, nothing per attempt, one line when it is back', async (t) => {
  const logs = captureLogs(t);
  const world = await createWorld();
  t.after(() => world.app.stop());
  const [server] = world.servers;
  logs.reset();
  server.goDown();
  // FAST_RPC retries every 20 to 100 ms: a dozen attempts at least.
  await wait(600);
  await settle();
  const down = logs.lines().filter((line) => line.includes('[moonraker-'));
  assert.equal(down.length, 1, down.join('\n'));
  assert.match(down[0], /\[WARN\].*Printer 1: Moonraker closed the connection/);
  assert.ok(
    logs.all().filter((line) => line.includes('retrying in')).length >= 3,
    'the attempts are at debug',
  );
  logs.reset();
  server.goUp();
  await wait(200);
  await settle(40);
  assert.equal(world.gladys.fake.lastState(featureId('state')), 'Prête');
  const back = logs.lines().filter((line) => line.includes('[moonraker-'));
  assert.ok(back.some((line) => /\[INFO\].*Printer 1: connected to Moonraker again/.test(line)));
  assert.ok(back.length <= 2, back.join('\n'));
});

test('states Gladys refuses: one warning, then one line when they go through again', async (t) => {
  const logs = captureLogs(t);
  const world = await createWorld();
  t.after(() => world.app.stop());
  const [server] = world.servers;
  logs.reset();
  const publish = t.mock.method(world.gladys, 'publishChangedStates', async () => {
    throw new Error('Gladys is restarting');
  });
  for (let i = 0; i < 5; i += 1) {
    server.update({ extruder: { temperature: 120 + i } });
    await settle();
  }
  assert.ok(publish.mock.callCount() >= 5);
  const failing = logs.lines();
  assert.equal(failing.length, 1, failing.join('\n'));
  assert.match(failing[0], /\[WARN\].*Cannot publish the states of printer 1/);
  logs.reset();
  publish.mock.restore();
  server.update({ extruder: { temperature: 150 } });
  await settle();
  assert.equal(world.gladys.fake.lastState(featureId('extruder_temperature')), 150);
  const back = logs.lines();
  assert.equal(back.length, 1, back.join('\n'));
  assert.match(back[0], /\[INFO\].*States of printer 1 published again/);
});

test('a stuck Klipper: one warning, not one per retry', async (t) => {
  const logs = captureLogs(t);
  const server = createMoonraker();
  server.overrides['printer.objects.list'] = () => undefined;
  const world = await createWorld({ servers: [server] });
  t.after(() => world.app.stop());
  // requestTimeout 200 ms + klippyRetry 30 ms: several attempts.
  await wait(800);
  await settle();
  assert.ok(server.callsOf('printer.objects.list').length >= 3);
  const stuck = logs.lines().filter((line) => line.includes('cannot read the printer'));
  assert.equal(stuck.length, 1, stuck.join('\n'));
  delete server.overrides['printer.objects.list'];
  logs.reset();
  await wait(400);
  await settle(40);
  const back = logs.lines().filter((line) => line.includes('[moonraker-'));
  assert.equal(back.length, 1, back.join('\n'));
  assert.match(back[0], /\[INFO\].*Printer 1: Klipper ready/);
});

test('a webcam that keeps failing: one warning, one line when it answers again', async (t) => {
  const logs = captureLogs(t);
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1000, 7)]);
  const server = createMoonraker({ printer: 'rich', image: JPEG });
  const world = await createWorld({ servers: [server] });
  t.after(() => world.app.stop());
  const fake = world.gladys.fake;
  await fake.deviceCreated(fake.discoveredDevices[0]);
  await settle();
  logs.reset();
  const link = world.hub.printers.get(1).link;
  const camera = t.mock.method(link, 'cameraImage', async () => {
    throw new Error('Webcam unreachable (ECONNREFUSED)');
  });
  for (let i = 0; i < 4; i += 1) {
    link.emit('camera');
    await settle();
  }
  assert.equal(camera.mock.callCount(), 4);
  const failing = logs.lines();
  assert.equal(failing.length, 1, failing.join('\n'));
  assert.match(failing[0], /\[WARN\].*Printer 1: no webcam image/);
  logs.reset();
  camera.mock.restore();
  link.emit('camera');
  await settle();
  const back = logs.lines();
  assert.equal(back.length, 1, back.join('\n'));
  assert.match(back[0], /\[INFO\].*Printer 1: webcam image back/);
});
