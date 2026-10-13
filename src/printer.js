// -----------------------------------------------------------------------------
// One Moonraker instance: connection, live state, print events and commands.
//
// Everything goes through the JSON-RPC WebSocket: on connection (and every
// time Klipper becomes ready again) the printer is read once — objects,
// heaters and their limits, macros, webcam — then the useful Klipper objects
// are subscribed to and Moonraker pushes their changes (about four a second
// while printing). Print events are derived from every change; the snapshot
// handed to Gladys is throttled (see `updateInterval`).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createLogger } from '@gladysassistant/integration-sdk';
import {
  ACTIVE_STATES,
  firstLine,
  mergeStatus,
  readCapabilities,
  readSnapshot,
  subscriptionOf,
} from './moonraker/model.js';
import { RpcLink } from './moonraker/rpc.js';

const logger = createLogger({ name: 'moonraker-printer' });

export const DEFAULT_TIMINGS = {
  // States handed to Gladys at most this often (a state or file change goes at
  // once): temperatures move every second while heating, and Gladys accepts
  // 300 states a minute for the whole integration.
  updateInterval: 5_000,
  // Klipper starting, stopped or disconnected: server.info again after this.
  klippyRetry: 5_000,
  // Webcam image pushed to Gladys (the dashboard camera box shows the last one).
  cameraInterval: 60_000,
  // A command Klipper has not acknowledged by then is taken as accepted: a
  // pause waits for the moves in the queue, a macro may heat for minutes.
  commandTimeout: 15_000,
  // Webcam snapshot download.
  cameraTimeout: 10_000,
};

const EMPTY_SNAPSHOT = {
  state: 'unreachable',
  printState: null,
  message: '',
  file: null,
  progress: null,
  totalDuration: null,
  printDuration: null,
  timeLeft: null,
  layer: null,
  layerTotal: null,
  temperatures: {},
  fan: null,
};

/** An Error with a `code` the callers turn into a message. */
export function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Events: `update` (snapshot, previous), `capabilities` (what the printer
 * has, read on each connection), `print` ({ type, file, seconds, reason }),
 * `klippy` ({ state, message }: Klipper stopped on an error), `camera`.
 */
export class PrinterLink extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} options.slot
   * @param {string} options.url
   * @param {string} options.apiKey
   * @param {typeof fetch} [options.fetch] webcam snapshots
   * @param {Function} [options.createSocket]
   * @param {object} [options.timings]
   * @param {object} [options.rpcTimings]
   * @param {string} [options.version]
   */
  constructor({ slot, url, apiKey, fetch, createSocket, timings = {}, rpcTimings, version }) {
    super();
    this.slot = slot;
    this.url = url;
    this.apiKey = apiKey;
    this.fetch = fetch ?? globalThis.fetch;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.rpc = new RpcLink({ url, apiKey, createSocket, timings: rpcTimings, version });
    this.rpc.on('open', () => this.#onOpen());
    this.rpc.on('close', (reason) => this.#onClose(reason));
    this.rpc.on('notification', (method, params) => this.#onNotification(method, params));
    this.snapshot = { ...EMPTY_SNAPSHOT };
    this.capabilities = null;
    this.status = {};
    this.klippyState = null;
    // print_stats.state last seen while Klipper was ready: events compare to it.
    this.lastPrintState = null;
    this.metadata = { file: null, estimatedTime: null };
    this.connected = false;
    this.lastError = '';
    this.running = false;
    this.generation = 0;
    this.timers = new Set();
    this.updateTimer = null;
    this.cameraTimer = null;
    this.emitted = null;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.rpc.start();
  }

  stop() {
    this.running = false;
    this.generation += 1;
    this.rpc.stop();
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    clearTimeout(this.updateTimer);
    clearInterval(this.cameraTimer);
    this.updateTimer = null;
    this.cameraTimer = null;
  }

  #later(fn, ms) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }

  // --- Connection -----------------------------------------------------------

  #onOpen() {
    this.connected = true;
    this.lastError = '';
    logger.info(`Printer ${this.slot}: connected to Moonraker`);
    this.#initialize();
  }

  #onClose(reason) {
    if (!this.running) {
      return;
    }
    this.generation += 1;
    const wasConnected = this.connected;
    this.connected = false;
    clearInterval(this.cameraTimer);
    this.cameraTimer = null;
    const firstFailure = this.lastError === '';
    if (this.lastError !== reason.message) {
      logger.warn(`Printer ${this.slot}: ${reason.message}`);
    }
    this.lastError = reason.message;
    const state = reason.kind === 'unauthorized' ? 'unauthorized' : 'unreachable';
    if (wasConnected || this.snapshot.state !== state || firstFailure) {
      // The last known values stay; only the state says Moonraker is gone.
      this.#setSnapshot({ ...this.snapshot, state }, { immediate: true });
    }
  }

  /**
   * Read the printer and subscribe to its objects. Run on every connection
   * and every time Klipper becomes ready; an older run in flight gives up.
   */
  async #initialize() {
    this.generation += 1;
    const generation = this.generation;
    const current = () => this.running && this.generation === generation;
    try {
      const server = await this.rpc.call('server.info');
      if (!current()) {
        return;
      }
      this.klippyState = server?.klippy_state ?? 'disconnected';
      if (this.klippyState !== 'ready') {
        let message = '';
        if (['shutdown', 'error'].includes(this.klippyState)) {
          // Why Klipper stopped ("Heater extruder not heating at expected rate").
          const info = await this.rpc.call('printer.info').catch(() => null);
          message = typeof info?.state_message === 'string' ? info.state_message : '';
          if (!current()) {
            return;
          }
        }
        this.#onKlippyState(this.klippyState, message);
        // Moonraker announces `notify_klippy_ready`; this covers a missed one.
        this.#later(() => current() && this.#initialize(), this.timings.klippyRetry);
        return;
      }
      const [info, list, query, webcams] = await Promise.all([
        this.rpc.call('printer.info'),
        this.rpc.call('printer.objects.list'),
        this.rpc.call('printer.objects.query', {
          objects: { heaters: null, configfile: ['settings'] },
        }),
        this.rpc.call('server.webcams.list').catch(() => null),
      ]);
      if (!current()) {
        return;
      }
      const capabilities = readCapabilities({
        objects: list?.objects,
        heaters: query?.status?.heaters,
        settings: query?.status?.configfile?.settings,
        webcams,
        info,
      });
      this.capabilities = capabilities;
      this.emit('capabilities', capabilities);
      const subscribed = await this.rpc.call('printer.objects.subscribe', {
        objects: subscriptionOf(capabilities),
      });
      if (!current()) {
        return;
      }
      this.status = mergeStatus({}, subscribed?.status);
      this.#applyStatus({ immediate: true });
      this.#startCamera();
      logger.info(
        `Printer ${this.slot}: Klipper ready (${capabilities.heaters.length} heaters, ` +
          `${capabilities.sensors.length} sensors, ${capabilities.macros.length} macros` +
          `${capabilities.camera ? ', webcam' : ''})`,
      );
    } catch (err) {
      if (!current()) {
        return;
      }
      if (err.kind === 'closed' || err.kind === 'unreachable') {
        return; // the link reconnects and runs this again
      }
      if (err.kind === 'unauthorized') {
        this.#onClose(err);
        return;
      }
      // Klipper not answering (stuck, restarting): try again shortly.
      logger.warn(`Printer ${this.slot}: cannot read the printer (${err.message})`);
      this.#onKlippyState('disconnected', err.message);
      this.#later(() => current() && this.#initialize(), this.timings.klippyRetry);
    }
  }

  #onNotification(method, params) {
    switch (method) {
      case 'notify_status_update':
        if (this.klippyState === 'ready' && Array.isArray(params)) {
          this.status = mergeStatus(this.status, params[0]);
          this.#applyStatus();
        }
        break;
      case 'notify_klippy_ready':
        this.#initialize();
        break;
      case 'notify_klippy_shutdown':
        this.#onKlippyState('shutdown', this.status.webhooks?.state_message);
        break;
      case 'notify_klippy_disconnected':
        this.#onKlippyState('disconnected', '');
        // The subscription died with Klippy: read everything again once it is back.
        this.#initialize();
        break;
      default:
        break;
    }
  }

  /** Klipper left (or never reached) `ready`. */
  #onKlippyState(klippyState, message) {
    this.klippyState = klippyState;
    this.status = mergeStatus(this.status, {
      webhooks: { state: klippyState, state_message: message ?? '' },
    });
    this.#applyStatus({ immediate: true });
  }

  // --- State ----------------------------------------------------------------

  #applyStatus({ immediate = false } = {}) {
    const capabilities = this.capabilities;
    const webhooksState = this.status.webhooks?.state;
    if (webhooksState && webhooksState !== this.klippyState && this.klippyState === 'ready') {
      // Shutdown is reported in the status (webhooks.state) before
      // notify_klippy_shutdown: either is enough.
      this.klippyState = webhooksState;
    }
    const next = readSnapshot(this.status, capabilities, {
      klippyState: this.klippyState,
      estimatedTime:
        this.metadata.file === this.status.print_stats?.filename
          ? this.metadata.estimatedTime
          : null,
    });
    this.#deriveEvents(next);
    this.#readMetadata(next.file);
    this.#setSnapshot(next, { immediate });
  }

  #deriveEvents(next) {
    const previous = this.snapshot;
    // Klipper stopped on an error: its own trigger, and the end of the print.
    const klippyDown = next.state === 'klippy_shutdown' || next.state === 'klippy_error';
    const wasDown = previous.state === 'klippy_shutdown' || previous.state === 'klippy_error';
    if (klippyDown && !wasDown && previous.state !== 'unreachable' && this.emittedOnce) {
      this.emit('klippy', {
        state: next.state === 'klippy_shutdown' ? 'shutdown' : 'error',
        message: next.message || firstLine(this.status.webhooks?.state_message),
      });
    }
    const ready =
      !next.state.startsWith('klippy_') && !['unreachable', 'unauthorized'].includes(next.state);
    const before = this.lastPrintState;
    const seconds = next.totalDuration ?? previous.totalDuration;
    const file = next.file ?? previous.file;
    if (!ready) {
      if (
        next.state !== 'unreachable' &&
        next.state !== 'unauthorized' &&
        next.state !== 'klippy_startup' &&
        ACTIVE_STATES.has(before)
      ) {
        // Klipper stopped or restarted under a running print: the print is lost.
        this.emit('print', { type: 'failed', file, seconds, reason: 'error' });
        this.lastPrintState = 'error';
      }
      return;
    }
    const now = next.printState;
    this.lastPrintState = now;
    if (before === null || before === now) {
      return; // first sight of the printer: nothing happened, it just is
    }
    // Klipper enters `complete`, `cancelled` and `error` only when a job ends,
    // so these fire even without `printing` seen before: a print failing at
    // once goes from `standby` to `error` in a single update (recorded), and
    // a print may end while Moonraker was out of reach. `standby` after a
    // job (SDCARD_RESET_FILE, a restart) tells nothing: no event.
    if (now === 'printing' && before !== 'paused') {
      this.emit('print', { type: 'started', file, seconds: null, reason: null });
    } else if (now === 'paused' && before === 'printing') {
      this.emit('print', { type: 'paused', file, seconds, reason: null });
    } else if (now === 'complete') {
      this.emit('print', { type: 'done', file, seconds, reason: null });
    } else if (now === 'cancelled') {
      this.emit('print', { type: 'failed', file, seconds, reason: 'cancelled' });
    } else if (now === 'error') {
      this.emit('print', { type: 'failed', file, seconds, reason: 'error' });
    }
  }

  /** The slicer's estimate of a new file (once per file). */
  async #readMetadata(file) {
    if (!file || this.metadata.file === file || this.metadata.reading === file) {
      return;
    }
    this.metadata.reading = file;
    let estimatedTime = null;
    try {
      const metadata = await this.rpc.call('server.files.metadata', { filename: file });
      const value = metadata?.estimated_time;
      estimatedTime =
        typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      // No metadata (a file printed from elsewhere, an unsupported slicer).
    }
    if (this.metadata.reading !== file) {
      return;
    }
    this.metadata = { file, estimatedTime, reading: null };
    if (estimatedTime !== null && this.running) {
      this.#applyStatus();
    }
  }

  /**
   * Hand the snapshot to the listeners: at once for a change of state or
   * file, otherwise at most every `updateInterval`.
   */
  #setSnapshot(next, { immediate = false } = {}) {
    if (!this.running) {
      return; // a replaced link must not publish over its successor
    }
    this.snapshot = next;
    const last = this.emitted;
    if (
      immediate ||
      this.timings.updateInterval <= 0 ||
      !last ||
      last.state !== next.state ||
      last.file !== next.file
    ) {
      this.#emitUpdate();
      return;
    }
    if (!this.updateTimer) {
      this.updateTimer = setTimeout(() => {
        this.updateTimer = null;
        if (this.running) {
          this.#emitUpdate();
        }
      }, this.timings.updateInterval);
      this.updateTimer.unref?.();
    }
  }

  #emitUpdate() {
    clearTimeout(this.updateTimer);
    this.updateTimer = null;
    const previous = this.emitted ?? { ...EMPTY_SNAPSHOT };
    this.emitted = this.snapshot;
    this.emittedOnce = true;
    this.emit('update', this.snapshot, previous);
  }

  // --- Commands -----------------------------------------------------------

  get ready() {
    return this.connected && this.klippyState === 'ready';
  }

  /**
   * Run a printer command. Throws an Error whose `code` the callers turn into
   * a message: `unreachable`, `not_ready`, `not_printing`, `not_paused`,
   * `printing`, `refused` (Klipper said no, `detail` holds why).
   * @param {'pause' | 'resume' | 'cancel' | 'heaters' | 'cool_down' | 'macro' | 'firmware_restart'} name
   */
  async command(name, value) {
    if (!this.connected) {
      throw codedError('unreachable', `Printer ${this.slot} is not connected`);
    }
    if (name === 'firmware_restart') {
      if (!['shutdown', 'error'].includes(this.klippyState)) {
        throw codedError('not_stopped', 'Klipper is not stopped on an error');
      }
      return this.#send('printer.firmware_restart');
    }
    if (!this.ready) {
      throw codedError('not_ready', `Klipper is ${this.klippyState ?? 'not ready'}`);
    }
    const state = this.snapshot.state;
    switch (name) {
      case 'pause':
        if (state !== 'printing') {
          throw codedError('not_printing', 'No print in progress');
        }
        return this.#send('printer.print.pause');
      case 'resume':
        if (state !== 'paused') {
          throw codedError('not_paused', 'The print is not paused');
        }
        return this.#send('printer.print.resume');
      case 'cancel':
        if (!ACTIVE_STATES.has(state)) {
          throw codedError('not_printing', 'No print in progress');
        }
        return this.#send('printer.print.cancel');
      case 'heaters': {
        const lines = Object.entries(value).map(
          ([heater, target]) => `SET_HEATER_TEMPERATURE HEATER=${heater} TARGET=${target}`,
        );
        return this.#gcode(lines.join('\n'));
      }
      case 'cool_down':
        return this.#gcode('TURN_OFF_HEATERS');
      case 'macro':
        return this.#gcode(value);
      default:
        throw new Error(`Unknown command ${name}`);
    }
  }

  #gcode(script) {
    return this.#send('printer.gcode.script', { script });
  }

  async #send(method, params) {
    try {
      await this.rpc.call(method, params, { timeout: this.timings.commandTimeout });
    } catch (err) {
      if (err.kind === 'timeout') {
        // Sent and queued: Klipper answers when the command is done.
        logger.info(`Printer ${this.slot}: ${method} sent, no answer yet`);
        return;
      }
      if (err.kind === 'rpc' || err.kind === 'klippy') {
        const refused = codedError('refused', err.message);
        refused.detail = firstLine(err.message);
        throw refused;
      }
      throw codedError('unreachable', err.message);
    }
  }

  // --- Webcam -----------------------------------------------------------------

  #startCamera() {
    clearInterval(this.cameraTimer);
    this.cameraTimer = null;
    if (this.capabilities?.camera) {
      this.emit('camera');
      this.cameraTimer = setInterval(() => this.emit('camera'), this.timings.cameraInterval);
      this.cameraTimer.unref?.();
    }
  }

  /**
   * Where the snapshot is. Moonraker stores what the user typed in Mainsail or
   * Fluidd: a path relative to their web server (`/webcam/?action=snapshot`),
   * or a URL that often names the Raspberry Pi itself (`localhost`).
   */
  snapshotUrl() {
    const raw = this.capabilities?.camera?.snapshotUrl;
    if (!raw) {
      return null;
    }
    const base = new URL(this.url);
    // The web server of Mainsail or Fluidd, not Moonraker's own port.
    const origin = `${base.protocol}//${base.hostname}${
      base.port === '' || base.port === '7125' ? '' : `:${base.port}`
    }`;
    let url;
    try {
      url = new URL(raw, `${origin}/`);
    } catch {
      return null;
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }
    if (['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname)) {
      url.hostname = base.hostname;
    }
    return url.toString();
  }

  /** The webcam image as Gladys wants it, or throws (coded). */
  async cameraImage(maxBytes) {
    const url = this.snapshotUrl();
    if (!url) {
      throw codedError('no_camera', 'No webcam with snapshots');
    }
    let response;
    try {
      // No API key: the webcam is another service, the key is Moonraker's.
      response = await this.fetch(url, {
        signal: AbortSignal.timeout(this.timings.cameraTimeout),
        redirect: 'manual',
      });
    } catch (err) {
      throw codedError(
        'camera_unreachable',
        `Webcam unreachable (${err?.cause?.code ?? err.name})`,
      );
    }
    if (response.status !== 200) {
      throw codedError('camera_unreachable', `Webcam answered HTTP ${response.status}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    const isJpeg = data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    if (!isJpeg) {
      throw codedError('camera_format', 'The webcam image is not a JPEG');
    }
    const encoded = `image/jpg;base64,${data.toString('base64')}`;
    if (encoded.length > maxBytes) {
      throw codedError(
        'camera_size',
        `The webcam image is too large (${Math.round(data.length / 1024)} KB)`,
      );
    }
    return encoded;
  }
}
