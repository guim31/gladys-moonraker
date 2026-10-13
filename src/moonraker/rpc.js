// -----------------------------------------------------------------------------
// The link to one Moonraker: its JSON-RPC 2.0 WebSocket (`/websocket`), the
// only transport the integration uses. Requests, their answers, and the
// notifications Moonraker pushes (`notify_status_update`, `notify_klippy_*`).
//
// Facts checked on Moonraker (API 1.5.0, image ei99070/docker-klipper-simulavr):
// - the socket opens without credentials; `server.connection.identify` then
//   authenticates it with `api_key` (or nothing, from a trusted network).
//   Refused, every request answers `{ code: -32602, message: "Unauthorized" }`
//   ("Invalid API Key" for a wrong key);
// - Moonraker sends `notify_proc_stat_update` every second to every client:
//   a silence of a minute means a dead link;
// - a request Klippy cannot answer (Klipper stuck) never gets an answer:
//   every request has a timeout.
//
// Node 22+ ships WebSocket as a global: no dependency needed.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'moonraker-rpc' });

export const DEFAULT_RPC_TIMINGS = {
  requestTimeout: 10_000,
  idleTimeout: 60_000,
  reconnectMin: 2_000,
  reconnectMax: 60_000,
  // A refused key will not become valid by retrying fast.
  unauthorizedRetry: 60_000,
};

export const CLIENT_INFO = {
  client_name: 'gladys-moonraker',
  type: 'other',
  url: 'https://github.com/guim31/gladys-moonraker',
};

export class MoonrakerError extends Error {
  /**
   * @param {'unreachable' | 'unauthorized' | 'timeout' | 'closed' | 'klippy' | 'rpc'} kind
   * @param {string} message
   * @param {number} [code] JSON-RPC error code
   */
  constructor(kind, message, code) {
    super(message);
    this.name = 'MoonrakerError';
    this.kind = kind;
    this.code = code;
  }
}

/** A JSON-RPC `error` object -> MoonrakerError. */
export function errorOf(error) {
  const message = typeof error?.message === 'string' ? error.message : 'Moonraker error';
  const code = typeof error?.code === 'number' ? error.code : undefined;
  if (code === 401 || code === 403 || /unauthori[sz]ed|invalid api key|forbidden/i.test(message)) {
    return new MoonrakerError('unauthorized', message.slice(0, 300), code);
  }
  if (code === 503 || /klippy (host )?(not connected|disconnected)/i.test(message)) {
    return new MoonrakerError('klippy', message.slice(0, 300), code);
  }
  return new MoonrakerError('rpc', message.slice(0, 300), code);
}

export function socketUrl(baseUrl) {
  return `${baseUrl.replace(/^http/i, 'ws')}/websocket`;
}

/**
 * Emits `open` (identified, requests may flow), `close` (MoonrakerError: why)
 * and `notification` (method, params). Reconnects by itself until stop().
 */
export class RpcLink extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.url normalized base URL (see normalizeUrl)
   * @param {string} [options.apiKey]
   * @param {(url: string) => WebSocket} [options.createSocket]
   * @param {object} [options.timings]
   * @param {string} [options.version] the integration version, told to Moonraker
   */
  constructor({ url, apiKey = '', createSocket, timings = {}, version = '0.0.0' }) {
    super();
    this.url = url;
    this.apiKey = apiKey;
    this.createSocket = createSocket ?? ((target) => new WebSocket(target));
    this.timings = { ...DEFAULT_RPC_TIMINGS, ...timings };
    this.version = version;
    this.socket = null;
    this.running = false;
    this.open = false;
    this.failures = 0;
    this.nextId = 0;
    this.pending = new Map();
    this.retryTimer = null;
    this.idleTimer = null;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.#connect();
  }

  stop() {
    this.running = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.idleTimer);
    this.retryTimer = null;
    this.idleTimer = null;
    this.#drop(new MoonrakerError('closed', 'Link stopped'), { notify: false });
  }

  /**
   * One JSON-RPC request. Rejects with a MoonrakerError.
   * @param {string} method
   * @param {object} [params]
   * @param {{ timeout?: number }} [options]
   */
  call(method, params, { timeout } = {}) {
    if (!this.open) {
      return Promise.reject(new MoonrakerError('unreachable', 'Moonraker is not connected'));
    }
    return this.#request(this.socket, method, params, timeout);
  }

  #request(socket, method, params, timeout = this.timings.requestTimeout) {
    return new Promise((resolve, reject) => {
      this.nextId += 1;
      const id = this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MoonrakerError('timeout', `No answer to ${method} within ${timeout} ms`));
      }, timeout);
      // Not unref'd: a request awaited by someone keeps the process alive
      // until it settles (bounded by the timeout).
      this.pending.set(id, { resolve, reject, timer });
      const message = { jsonrpc: '2.0', method, id };
      if (params !== undefined) {
        message.params = params;
      }
      try {
        socket.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new MoonrakerError('closed', `Cannot send ${method} (${err.message})`));
      }
    });
  }

  #connect() {
    let socket;
    try {
      socket = this.createSocket(socketUrl(this.url));
    } catch (err) {
      this.#scheduleRetry(
        new MoonrakerError('unreachable', `Moonraker unreachable (${err.message})`),
      );
      return;
    }
    this.socket = socket;
    socket.onopen = () => this.#identify(socket);
    socket.onmessage = (event) => this.#receive(socket, event.data);
    socket.onerror = () => {
      // The close event follows and carries the retry.
    };
    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }
      const reason = this.open
        ? new MoonrakerError('closed', 'Moonraker closed the connection')
        : new MoonrakerError('unreachable', 'Moonraker unreachable (connection refused or closed)');
      this.#drop(reason);
      this.#scheduleRetry(reason);
    };
    this.#armIdle();
  }

  async #identify(socket) {
    try {
      await this.#request(socket, 'server.connection.identify', {
        ...CLIENT_INFO,
        version: this.version,
        ...(this.apiKey ? { api_key: this.apiKey } : {}),
      });
    } catch (err) {
      if (this.socket !== socket) {
        return;
      }
      this.#drop(err);
      this.#scheduleRetry(err);
      return;
    }
    if (this.socket !== socket || !this.running) {
      return;
    }
    this.failures = 0;
    this.open = true;
    this.emit('open');
  }

  #receive(socket, raw) {
    if (this.socket !== socket) {
      return;
    }
    this.#armIdle();
    let data;
    try {
      data = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') {
      return;
    }
    if (data.id !== undefined && data.id !== null && this.pending.has(data.id)) {
      const request = this.pending.get(data.id);
      this.pending.delete(data.id);
      clearTimeout(request.timer);
      if (data.error) {
        request.reject(errorOf(data.error));
      } else {
        request.resolve(data.result);
      }
      return;
    }
    if (typeof data.method === 'string' && this.open) {
      this.emit('notification', data.method, data.params);
    }
  }

  #armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.socket) {
        return;
      }
      const reason = new MoonrakerError('unreachable', 'No message from Moonraker for a minute');
      logger.warn(`${reason.message} (${this.url}), reconnecting`);
      this.#drop(reason);
      this.#scheduleRetry(reason);
    }, this.timings.idleTimeout);
    this.idleTimer.unref?.();
  }

  /** Close the socket, fail the requests in flight, tell the listeners. */
  #drop(reason, { notify = true } = {}) {
    const socket = this.socket;
    this.socket = null;
    clearTimeout(this.idleTimer);
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
    // Every request in flight went through the socket being dropped.
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new MoonrakerError('closed', 'Connection to Moonraker lost'));
    }
    this.pending.clear();
    this.open = false;
    if (notify) {
      this.emit('close', reason);
    }
  }

  #scheduleRetry(reason) {
    if (!this.running) {
      return;
    }
    this.failures += 1;
    const delay =
      reason.kind === 'unauthorized'
        ? this.timings.unauthorizedRetry
        : Math.min(
            this.timings.reconnectMax,
            this.timings.reconnectMin * 2 ** Math.min(this.failures - 1, 10),
          );
    if (this.failures === 1 || this.failures % 10 === 0) {
      logger.info(`Link to ${this.url} down (${reason.message}), retrying in ${delay} ms`);
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running && !this.socket) {
        this.#connect();
      }
    }, delay);
    this.retryTimer.unref?.();
  }
}
