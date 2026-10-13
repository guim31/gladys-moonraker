// -----------------------------------------------------------------------------
// A Moonraker instance in memory: its JSON-RPC WebSocket (a WebSocket
// stand-in) and the webcam of the printer (a `fetch` implementation),
// answering with the bodies recorded on a real Moonraker driving Klipper with
// a simulated micro-controller (test/fixtures/moonraker/). The tests drive it:
// change the print state, stop Klipper, take Moonraker down, replay the
// recorded print session.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

// Silent integration logs (LOG_LEVEL is read on every log call);
// LOG_LEVEL=debug npm test shows them.
process.env.LOG_LEVEL ??= 'silent';

export function fixture(name) {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/moonraker/${name}`, import.meta.url), 'utf8'),
  );
}

export const API_KEY = 'TEST0123456789ABCDEFGHIJKLMNOPQR';
export const ERRORS = fixture('errors.json');

const clone = (value) => JSON.parse(JSON.stringify(value));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Recorded printers: a single nozzle (no webcam) and a richer one. */
export const PRINTERS = {
  single: () => ({
    serverInfo: fixture('single-server-info.json'),
    printerInfo: fixture('single-printer-info.json'),
    objects: fixture('single-objects-list.json').objects,
    query: fixture('single-query-heaters-configfile.json').status,
    webcams: fixture('single-webcams-list.json'),
    // Recorded after a cancelled print; the tests start from a printer at rest.
    status: {
      ...fixture('single-subscribe-after-cancel.json').status,
      print_stats: fixture('rich-subscribe.json').status.print_stats,
    },
    metadata: fixture('rich-metadata.json'),
  }),
  rich: () => ({
    serverInfo: fixture('rich-server-info.json'),
    printerInfo: fixture('rich-printer-info.json'),
    objects: fixture('rich-objects-list.json').objects,
    query: fixture('rich-query-heaters-configfile.json').status,
    webcams: fixture('rich-webcams-list.json'),
    status: fixture('rich-subscribe.json').status,
    metadata: fixture('rich-metadata.json'),
  }),
};

function pick(object, keys) {
  return Object.fromEntries(keys.filter((k) => k in object).map((k) => [k, object[k]]));
}

/** Let the in-memory sockets and timers of a few event-loop turns run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeSocket {
  constructor(server, url) {
    this.server = server;
    this.url = url;
    this.closed = false;
    this.identified = false;
    this.subscription = null;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    setImmediate(() => {
      if (this.closed) {
        return;
      }
      if (server.down) {
        this.#close();
        return;
      }
      server.sockets.add(this);
      this.onopen?.();
    });
  }

  send(raw) {
    if (this.closed) {
      throw new Error('socket closed');
    }
    const message = JSON.parse(raw);
    this.server.calls.push({ method: message.method, params: message.params });
    setImmediate(() => this.server.handle(this, message));
  }

  deliver(data) {
    if (!this.closed) {
      this.onmessage?.({ data: JSON.stringify(data) });
    }
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.server.sockets.delete(this);
    }
  }

  /** Closed by the server side. */
  #close() {
    this.closed = true;
    this.server.sockets.delete(this);
    this.onclose?.({ code: 1006 });
  }

  drop() {
    this.#close();
  }
}

export class FakeMoonraker {
  /**
   * @param {object} [options]
   * @param {string} [options.host]
   * @param {'single' | 'rich'} [options.printer]
   * @param {string | null} [options.apiKey] required key (null: trusted network)
   * @param {Buffer} [options.image] webcam snapshot bytes
   * @param {string} [options.printState] print_stats.state at start
   */
  constructor({ host = '192.0.2.10', printer = 'single', apiKey = null, image, printState } = {}) {
    this.host = host;
    this.url = `http://${host}:7125`;
    const data = PRINTERS[printer]();
    this.serverInfo = data.serverInfo;
    this.printerInfo = data.printerInfo;
    this.objects = data.objects;
    this.query = data.query;
    this.webcams = data.webcams;
    this.status = clone(data.status);
    this.metadata = data.metadata;
    this.apiKey = apiKey;
    this.image = image;
    this.imageStatus = 200;
    this.klippyState = 'ready';
    this.down = false;
    this.sockets = new Set();
    this.calls = [];
    // method -> (params) => result | { error } | undefined (no answer)
    this.overrides = {};
    if (printState) {
      this.status.print_stats.state = printState;
      if (printState !== 'standby') {
        this.status.print_stats.filename = this.metadata.filename;
      }
    }
  }

  callsOf(method) {
    return this.calls.filter((call) => call.method === method);
  }

  handle(socket, message) {
    if (socket.closed) {
      return;
    }
    const reply = (body) => socket.deliver({ jsonrpc: '2.0', id: message.id, ...body });
    const { method, params = {} } = message;
    if (method === 'server.connection.identify') {
      if (this.apiKey && params.api_key !== this.apiKey) {
        reply({ error: params.api_key ? ERRORS.invalid_api_key : ERRORS.unauthorized });
        return;
      }
      socket.identified = true;
      reply({ result: { connection_id: 4242 } });
      return;
    }
    if (!socket.identified) {
      reply({ error: ERRORS.unauthorized });
      return;
    }
    if (this.overrides[method]) {
      const result = this.overrides[method](params);
      if (result === undefined) {
        return; // never answers (Klipper stuck)
      }
      reply(isObject(result) && result.error ? { error: result.error } : { result });
      return;
    }
    const klippyReady = this.klippyState === 'ready';
    const notReady = () =>
      reply({
        error:
          this.klippyState === 'shutdown'
            ? ERRORS.shutdown
            : { code: 503, message: 'Klippy Host not connected' },
      });
    switch (method) {
      case 'server.info':
        reply({ result: { ...this.serverInfo, klippy_state: this.klippyState } });
        return;
      case 'printer.info':
        reply({
          result: {
            ...this.printerInfo,
            state: this.klippyState,
            state_message: this.status.webhooks.state_message,
          },
        });
        return;
      case 'server.webcams.list':
        reply({ result: this.webcams });
        return;
      case 'printer.firmware_restart':
        // Accepted in every Klipper state: it is the way out of a shutdown.
        reply({ result: 'ok' });
        return;
      case 'server.files.metadata':
        if (params.filename === this.metadata.filename) {
          reply({ result: this.metadata });
        } else {
          reply({ error: ERRORS.metadata_missing });
        }
        return;
      default:
        break;
    }
    if (!klippyReady) {
      notReady();
      return;
    }
    switch (method) {
      case 'printer.objects.list':
        reply({ result: { objects: this.objects } });
        return;
      case 'printer.objects.query':
        reply({ result: { eventtime: 1, status: this.#select(params.objects) } });
        return;
      case 'printer.objects.subscribe':
        socket.subscription = params.objects;
        reply({ result: { eventtime: 1, status: this.#select(params.objects) } });
        return;
      case 'printer.print.pause':
        reply({ result: 'ok' });
        this.update({ print_stats: { state: 'paused' } });
        return;
      case 'printer.print.resume':
        reply({ result: 'ok' });
        this.update({ print_stats: { state: 'printing' } });
        return;
      case 'printer.print.cancel':
        reply({ result: 'ok' });
        this.update({ print_stats: { state: 'cancelled' }, virtual_sdcard: { progress: 0 } });
        return;
      case 'printer.gcode.script':
        this.#gcode(params.script, reply);
        return;
      default:
        reply({ error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }

  #select(objects) {
    const status = {};
    for (const [name, fields] of Object.entries(objects ?? {})) {
      const source = name in this.status ? this.status[name] : this.query[name];
      if (!isObject(source)) {
        continue;
      }
      status[name] = Array.isArray(fields) ? pick(source, fields) : clone(source);
    }
    return status;
  }

  /** The few G-code commands the integration sends, as Klipper answers them. */
  #gcode(script, reply) {
    const updates = {};
    for (const line of script.split('\n')) {
      const set = /^SET_HEATER_TEMPERATURE HEATER=(\S+) TARGET=(\S+)$/.exec(line);
      if (set) {
        const object =
          ['extruder', 'heater_bed'].includes(set[1]) || /^extruder\d+$/.test(set[1])
            ? set[1]
            : `heater_generic ${set[1]}`;
        const max = this.query.configfile.settings[object.toLowerCase()]?.max_temp ?? 300;
        const value = Number(set[2]);
        if (value > max) {
          reply({
            error: {
              code: 400,
              message: `Requested temperature (${value.toFixed(1)}) out of range (0.0:${max.toFixed(1)})`,
            },
          });
          return;
        }
        updates[object] = { target: value };
        continue;
      }
      if (line === 'TURN_OFF_HEATERS') {
        for (const name of Object.keys(this.status)) {
          if ('target' in this.status[name]) {
            updates[name] = { target: 0 };
          }
        }
      }
      // Unknown commands: Klipper answers ok and prints "Unknown command".
    }
    reply({ result: 'ok' });
    if (Object.keys(updates).length > 0) {
      this.update(updates);
    }
  }

  /** Change Klipper objects and notify the subscribed sockets (only their fields). */
  update(diff) {
    for (const [name, fields] of Object.entries(diff)) {
      this.status[name] = { ...(this.status[name] ?? {}), ...fields };
    }
    for (const socket of this.sockets) {
      if (!socket.identified || !socket.subscription) {
        continue;
      }
      const filtered = {};
      for (const [name, fields] of Object.entries(diff)) {
        const wanted = socket.subscription[name];
        if (wanted === undefined) {
          continue;
        }
        filtered[name] = Array.isArray(wanted) ? pick(fields, wanted) : fields;
        if (Object.keys(filtered[name]).length === 0) {
          delete filtered[name];
        }
      }
      if (Object.keys(filtered).length > 0) {
        socket.deliver({ jsonrpc: '2.0', method: 'notify_status_update', params: [filtered, 2] });
      }
    }
  }

  notify(method, params) {
    for (const socket of this.sockets) {
      if (socket.identified) {
        socket.deliver({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
      }
    }
  }

  /** A print state change, as Klipper reports it. */
  setPrintState(state, extra = {}) {
    this.update({ print_stats: { state, ...extra } });
  }

  /** Klipper shuts down (thermal runaway, M112...). */
  shutdown(message = ERRORS.shutdown.message) {
    this.klippyState = 'shutdown';
    this.update({ webhooks: { state: 'shutdown', state_message: message } });
    this.notify('notify_klippy_shutdown');
  }

  /** Klipper restarts: disconnected, then ready again with fresh objects. */
  klippyDisconnect() {
    this.klippyState = 'disconnected';
    this.notify('notify_klippy_disconnected');
    for (const socket of this.sockets) {
      socket.subscription = null;
    }
  }

  klippyReady() {
    this.klippyState = 'ready';
    this.status.webhooks = { state: 'ready', state_message: 'Printer is ready' };
    this.notify('notify_klippy_ready');
  }

  /** Moonraker stops: every socket drops, new ones are refused. */
  goDown() {
    this.down = true;
    for (const socket of [...this.sockets]) {
      socket.drop();
    }
  }

  goUp() {
    this.down = false;
  }

  /** Sends Moonraker's periodic notification (keeps the idle watchdog quiet). */
  procStat() {
    this.notify('notify_proc_stat_update', [{ cpu_temp: 40 }]);
  }

  /** The webcam answer for its snapshot URL. */
  snapshot() {
    if (!this.image) {
      return new Response('not found', { status: 404 });
    }
    return new Response(this.image, {
      status: this.imageStatus,
      headers: { 'content-type': 'image/jpeg' },
    });
  }
}

export function createMoonraker(options) {
  return new FakeMoonraker(options);
}

/**
 * The network of a test: WebSockets to the fake Moonraker instances, HTTP to
 * their webcams (mjpg-streamer on port 8080, or the web server on port 80).
 */
export function network(...servers) {
  const byHost = new Map(servers.map((server) => [server.host, server]));
  const sockets = [];
  const fetches = [];
  return {
    sockets,
    fetches,
    createSocket(url) {
      const { hostname } = new URL(url);
      const server = byHost.get(hostname);
      if (!server) {
        const socket = new FakeSocket({ down: true, sockets: new Set(), calls: [] }, url);
        sockets.push(socket);
        return socket;
      }
      const socket = new FakeSocket(server, url);
      sockets.push(socket);
      return socket;
    },
    async fetch(url, options = {}) {
      fetches.push({ url, options });
      const { hostname } = new URL(url);
      const server = byHost.get(hostname);
      if (!server || server.down) {
        const err = new TypeError('fetch failed');
        err.cause = { code: 'ECONNREFUSED' };
        throw err;
      }
      return server.snapshot(url);
    },
  };
}
