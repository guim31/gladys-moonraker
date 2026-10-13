// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys (a real GladysIntegration on an
// in-memory transport), the integration wired on it by registerHandlers, and
// fake Moonraker instances on a fake network. Store under a temporary folder.
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { Store } from '../../src/store.js';
import { createMoonraker, network, settle } from './fakeMoonraker.js';

// States reach Gladys at once in the tests (the 5 s throttle has its own test).
export const FAST_TIMINGS = {
  updateInterval: 0,
  klippyRetry: 30,
  cameraInterval: 60_000,
  commandTimeout: 200,
  cameraTimeout: 200,
};
export const FAST_RPC = {
  requestTimeout: 200,
  idleTimeout: 60_000,
  reconnectMin: 20,
  reconnectMax: 100,
  unauthorizedRetry: 100,
};

/**
 * @param {object} [options]
 * @param {object[]} [options.servers] fake instances (default: one, at rest)
 * @param {object} [options.config] integration config (default: printer 1 on the first instance)
 * @param {boolean} [options.connect]
 */
export async function createWorld({
  servers,
  config,
  devices = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'moonraker-test-')),
  timings = FAST_TIMINGS,
  rpcTimings = FAST_RPC,
  now,
} = {}) {
  const instances = servers ?? [createMoonraker()];
  const net = network(...instances);
  const gladys = createFakeGladys({
    config: config ?? { url_1: instances[0].host },
    devices,
  });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    fetch: net.fetch,
    createSocket: net.createSocket,
    timings,
    rpcTimings,
    now,
  });
  if (connect) {
    await gladys.connect();
    await settle(40);
  }
  return { gladys, app, hub: app.hub, servers: instances, net, dataDir };
}

export const deviceId = (slot = 1) => `ext:test-integration:printer:${slot}`;
export const featureId = (key, slot = 1) => `${deviceId(slot)}:${key}`;
