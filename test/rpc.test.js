// The JSON-RPC link: error kinds, timeouts, the idle watchdog, reconnection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MoonrakerError, RpcLink, errorOf, socketUrl } from '../src/moonraker/rpc.js';
import { ERRORS, createMoonraker, network, settle, wait } from './helpers/fakeMoonraker.js';

const TIMINGS = {
  requestTimeout: 50,
  idleTimeout: 80,
  reconnectMin: 10,
  reconnectMax: 40,
  unauthorizedRetry: 40,
};

test('error kinds from the recorded Moonraker errors', () => {
  assert.equal(errorOf(ERRORS.unauthorized).kind, 'unauthorized');
  assert.equal(errorOf(ERRORS.invalid_api_key).kind, 'unauthorized');
  assert.equal(errorOf({ code: 503, message: 'Klippy Host not connected' }).kind, 'klippy');
  assert.equal(errorOf(ERRORS.sd_busy).kind, 'rpc');
  assert.equal(errorOf(ERRORS.shutdown).kind, 'rpc');
  assert.equal(errorOf(undefined).message, 'Moonraker error');
  assert.equal(
    socketUrl('https://printer.example/moonraker'),
    'wss://printer.example/moonraker/websocket',
  );
  assert.equal(socketUrl('http://192.0.2.10:7125'), 'ws://192.0.2.10:7125/websocket');
});

test('requests, notifications, a request that never gets an answer', async (t) => {
  const server = createMoonraker();
  const net = network(server);
  const link = new RpcLink({ url: server.url, createSocket: net.createSocket, timings: TIMINGS });
  t.after(() => link.stop());
  await assert.rejects(link.call('server.info'), (err) => err.kind === 'unreachable');
  const opened = new Promise((resolve) => link.once('open', resolve));
  link.start();
  await opened;
  assert.equal((await link.call('server.info')).klippy_state, 'ready');
  const notes = [];
  link.on('notification', (method) => notes.push(method));
  server.notify('notify_klippy_ready');
  await settle();
  assert.deepEqual(notes, ['notify_klippy_ready']);
  server.overrides['printer.info'] = () => undefined;
  await assert.rejects(
    link.call('printer.info'),
    (err) => err instanceof MoonrakerError && err.kind === 'timeout',
  );
});

test('a silent Moonraker is dropped and reconnected; requests in flight fail at once', async (t) => {
  const server = createMoonraker();
  const net = network(server);
  const link = new RpcLink({ url: server.url, createSocket: net.createSocket, timings: TIMINGS });
  t.after(() => link.stop());
  const closes = [];
  link.on('close', (reason) => closes.push(reason.kind));
  let opens = 0;
  link.on('open', () => {
    opens += 1;
  });
  link.start();
  await settle();
  assert.equal(opens, 1);
  server.overrides['printer.info'] = () => undefined;
  const pending = link.call('printer.info', undefined, { timeout: 10_000 });
  server.goDown();
  await assert.rejects(pending, (err) => err.kind === 'closed');
  server.goUp();
  await wait(60);
  await settle();
  assert.equal(opens, 2, 'reconnected');
  // No message for idleTimeout: dropped, then reconnected.
  await wait(120);
  await settle();
  assert.ok(closes.filter((kind) => kind === 'unreachable').length >= 1, closes.join());
  assert.ok(opens >= 3);
});

test('stop() fails what is in flight and never reconnects', async () => {
  const server = createMoonraker();
  const net = network(server);
  const link = new RpcLink({ url: server.url, createSocket: net.createSocket, timings: TIMINGS });
  link.start();
  await settle();
  server.overrides['printer.info'] = () => undefined;
  const pending = link.call('printer.info', undefined, { timeout: 10_000 });
  link.stop();
  await assert.rejects(pending, (err) => err.kind === 'closed');
  const sockets = net.sockets.length;
  await wait(60);
  assert.equal(net.sockets.length, sockets, 'no new socket after stop');
});
