// -----------------------------------------------------------------------------
// The hub: one PrinterLink per configured Moonraker, and everything Gladys
// sees of them — devices, states, connection status, scene events, commands.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { SLOTS } from './config.js';
import { buildDevice, buildStates, deviceIds, featureKeyOf, slotOf } from './devices.js';
import { ACTIVE_STATES, sameStructure } from './moonraker/model.js';
import { PrinterLink } from './printer.js';
import { STATE_LABELS, STATUS_TEXT, TEST_TEXT, commandMessage, formatDuration } from './texts.js';

const logger = createLogger({ name: 'moonraker-hub' });

export const WIDGET_KEY = 'printer';

// Scene trigger keys (manifest `scene_triggers`), by print event type.
export const TRIGGERS = {
  started: 'print_started',
  done: 'print_done',
  failed: 'print_failed',
  paused: 'print_paused',
};
export const KLIPPY_TRIGGER = 'klipper_shutdown';

// The core refuses camera images over 150 KB (the data URI included).
export const MAX_IMAGE_BYTES = 150 * 1024;

// requestWidgetRefresh is dropped by the core beyond one call per 10 s.
const WIDGET_REFRESH_GAP_MS = 10_500;

// A macro name as Klipper accepts it: no parameter, no second command.
const MACRO_NAME = /^[A-Za-z0-9][A-Za-z0-9_]{0,99}$/;

/** An Error carrying a coded, multi-language message. */
export class CommandError extends Error {
  constructor(code, language, ...args) {
    const message = commandMessage(code, ...args);
    super(message[language] ?? message.en);
    this.code = code;
    this.messages = message;
  }
}

export class Hub {
  constructor({
    gladys,
    store,
    fetch,
    createSocket,
    timings,
    rpcTimings,
    now = Date.now,
    version,
  }) {
    this.gladys = gladys;
    this.store = store;
    this.fetch = fetch;
    this.createSocket = createSocket;
    this.timings = timings;
    this.rpcTimings = rpcTimings;
    this.now = now;
    this.version = version;
    this.config = { printers: [], invalidSlots: [], language: 'fr' };
    // slot -> { slot, url, apiKey, link, capabilities }
    this.printers = new Map();
    // slot -> capabilities known from a previous run (store)
    this.known = {};
    this.lastStatus = '';
    this.widgetRefreshAt = 0;
    this.widgetTimer = null;
    this.stopped = false;
  }

  get language() {
    return this.config.language;
  }

  async start(config) {
    const saved = await this.store.load();
    this.known = saved && typeof saved.printers === 'object' ? saved.printers : {};
    await this.reconfigure(config);
  }

  /** New configuration: restart the printers whose address or key changed. */
  async reconfigure(config) {
    const languageChanged = config.language !== this.config.language;
    this.config = config;
    const wanted = new Map(config.printers.map((p) => [p.slot, p]));
    for (const [slot, printer] of this.printers) {
      const next = wanted.get(slot);
      if (!next || next.url !== printer.url || next.apiKey !== printer.apiKey) {
        printer.link.stop();
        this.printers.delete(slot);
      }
    }
    for (const [slot, settings] of wanted) {
      if (!this.printers.has(slot)) {
        this.#addPrinter(settings);
      }
    }
    await this.publishDevices();
    if (languageChanged) {
      await this.publishAllStates();
    }
    await this.updateConnectionStatus();
    this.refreshWidget();
  }

  /** Gladys reconnected (it may have restarted): send everything again. */
  async resync(config) {
    this.gladys.forgetPublishedStates?.();
    await this.reconfigure(config);
    await this.publishAllStates();
    this.lastStatus = '';
    await this.updateConnectionStatus();
  }

  stop() {
    this.stopped = true;
    for (const printer of this.printers.values()) {
      printer.link.stop();
    }
    clearTimeout(this.widgetTimer);
    return this.store.flush();
  }

  #addPrinter(settings) {
    const { slot, url, apiKey } = settings;
    const link = new PrinterLink({
      slot,
      url,
      apiKey,
      fetch: this.fetch,
      createSocket: this.createSocket,
      timings: this.timings,
      rpcTimings: this.rpcTimings,
      version: this.version,
    });
    const known = this.known[slot];
    const printer = {
      slot,
      url,
      apiKey,
      link,
      capabilities: known?.capabilities ?? null,
      lastError: '',
    };
    this.printers.set(slot, printer);
    link.on('capabilities', (capabilities) => this.#onCapabilities(printer, capabilities));
    link.on('update', (snapshot, previous) => this.#onUpdate(printer, snapshot, previous));
    link.on('print', (event) => this.#onPrint(printer, event));
    link.on('klippy', (event) => this.#onKlippy(printer, event));
    link.on('camera', () => this.#pushCamera(printer));
    link.start();
  }

  // --- Devices and states -------------------------------------------------

  /** Every printer whose structure is known, as Gladys devices. */
  buildDevices() {
    return [...this.printers.values()]
      .filter((printer) => printer.capabilities)
      .sort((a, b) => a.slot - b.slot)
      .map((printer) => buildDevice(this.gladys, printer, this.language));
  }

  async publishDevices() {
    try {
      await this.gladys.publishDiscoveredDevices(this.buildDevices());
    } catch (err) {
      logger.error('Cannot publish the devices', err);
    }
  }

  async #onCapabilities(printer, capabilities) {
    if (this.printers.get(printer.slot) !== printer) {
      return;
    }
    const changed = !sameStructure(printer.capabilities, capabilities);
    const renamed = printer.capabilities?.hostname !== capabilities.hostname;
    const macros =
      JSON.stringify(printer.capabilities?.macros) !== JSON.stringify(capabilities.macros);
    printer.capabilities = capabilities;
    this.known[printer.slot] = { capabilities };
    if (changed || renamed || macros) {
      this.store.save({ printers: this.known });
    }
    if (changed || renamed) {
      await this.publishDevices();
    }
  }

  async #onUpdate(printer, snapshot, previous) {
    if (printer.capabilities) {
      await this.#publishStates(printer);
    }
    if (
      snapshot.state !== previous.state ||
      snapshot.file !== previous.file ||
      snapshot.layer !== previous.layer
    ) {
      this.refreshWidget();
    }
    if (snapshot.state !== previous.state || printer.link.lastError !== printer.lastError) {
      // Deduplicated: only a change of the status reaches Gladys.
      printer.lastError = printer.link.lastError;
      await this.updateConnectionStatus();
    }
  }

  async #publishStates(printer) {
    if (!printer.capabilities || this.stopped || this.printers.get(printer.slot) !== printer) {
      return;
    }
    const states = buildStates(this.gladys, printer, printer.link.snapshot, this.language);
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      logger.warn(`Cannot publish the states of printer ${printer.slot}: ${err.message}`);
    }
  }

  async publishAllStates() {
    for (const printer of this.printers.values()) {
      await this.#publishStates(printer);
    }
  }

  /** The user added a device: states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    const slot = slotOf(this.gladys, device?.external_id);
    const printer = this.printers.get(slot);
    if (!printer) {
      return;
    }
    this.gladys.forgetPublishedStates?.(device.external_id);
    await this.#publishStates(printer);
    if (printer.capabilities?.camera) {
      this.#pushCamera(printer);
    }
    this.refreshWidget();
  }

  // --- Scene events ---------------------------------------------------------

  async #onPrint(printer, event) {
    const key = TRIGGERS[event.type];
    if (!key || !printer.capabilities || this.printers.get(printer.slot) !== printer) {
      return;
    }
    const data = {
      device: deviceIds(this.gladys, printer.slot).device,
      printer: this.#deviceName(printer),
      file: event.file ?? '',
    };
    if (event.type !== 'started') {
      data.duration = formatDuration(event.seconds, this.language);
      data.duration_minutes =
        typeof event.seconds === 'number' ? Math.round(event.seconds / 60) : null;
    }
    if (event.type === 'failed') {
      data.reason = event.reason ?? 'error';
    }
    logger.info(`Printer ${printer.slot}: print ${event.type} (${data.file})`);
    await this.#fire(key, data);
    this.refreshWidget();
  }

  async #onKlippy(printer, event) {
    if (!printer.capabilities || this.printers.get(printer.slot) !== printer) {
      return;
    }
    logger.warn(`Printer ${printer.slot}: Klipper ${event.state} (${event.message})`);
    await this.#fire(KLIPPY_TRIGGER, {
      device: deviceIds(this.gladys, printer.slot).device,
      printer: this.#deviceName(printer),
      message: event.message || event.state,
    });
  }

  async #fire(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
    } catch (err) {
      logger.warn(`Cannot fire ${key}: ${err.message}`);
    }
  }

  #deviceName(printer) {
    const created = (this.gladys.devices ?? []).find(
      (device) => device.external_id === deviceIds(this.gladys, printer.slot).device,
    );
    return created?.name ?? buildDevice(this.gladys, printer, this.language).name;
  }

  // --- Widget ---------------------------------------------------------------

  /** Nudge the open dashboards, with a trailing call inside the core's 10 s gap. */
  refreshWidget() {
    if (this.stopped) {
      return;
    }
    const wait = this.widgetRefreshAt + WIDGET_REFRESH_GAP_MS - this.now();
    if (wait <= 0) {
      this.widgetRefreshAt = this.now();
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
      return;
    }
    if (!this.widgetTimer) {
      this.widgetTimer = setTimeout(() => {
        this.widgetTimer = null;
        this.refreshWidget();
      }, wait);
      this.widgetTimer.unref?.();
    }
  }

  // --- Connection status ----------------------------------------------------

  statusMessage() {
    const lines = Object.fromEntries(Object.keys(STATUS_TEXT).map((language) => [language, []]));
    const add = (key, slot) => {
      for (const [language, table] of Object.entries(STATUS_TEXT)) {
        lines[language].push(table[key](slot));
      }
    };
    for (const slot of this.config.invalidSlots) {
      add('invalid', slot);
    }
    for (const slot of SLOTS) {
      const printer = this.printers.get(slot);
      if (!printer) {
        continue;
      }
      if (printer.link.snapshot.state === 'unauthorized') {
        add('unauthorized', slot);
      } else if (printer.link.snapshot.state === 'unreachable' && printer.link.lastError) {
        // Only once an attempt failed (a fresh start says nothing yet).
        add('unreachable', slot);
      }
    }
    if (this.printers.size === 0 && this.config.invalidSlots.length === 0) {
      for (const [language, table] of Object.entries(STATUS_TEXT)) {
        lines[language].push(table.none);
      }
    }
    if (lines.en.length === 0) {
      return null;
    }
    return Object.fromEntries(
      Object.entries(lines).map(([language, list]) => [language, list.join(' ').slice(0, 500)]),
    );
  }

  async updateConnectionStatus() {
    if (this.stopped) {
      return;
    }
    const message = this.statusMessage();
    const links = [...this.printers.values()].map((p) => p.link);
    const connected = message === null && links.some((link) => link.connected);
    // A printer still on its first attempt: nothing to say yet.
    if (!connected && message === null && links.some((l) => !l.connected && !l.lastError)) {
      return;
    }
    const fingerprint = JSON.stringify({ connected, message });
    if (fingerprint === this.lastStatus) {
      return;
    }
    this.lastStatus = fingerprint;
    try {
      await this.gladys.setConnectionStatus(connected, message ?? undefined);
    } catch (err) {
      logger.warn(`Cannot set the connection status: ${err.message}`);
    }
  }

  // --- Commands -----------------------------------------------------------

  printerOf(externalId) {
    const printer = this.printers.get(slotOf(this.gladys, externalId));
    if (!printer) {
      throw new CommandError('unknown_device', this.language);
    }
    return printer;
  }

  /**
   * Run a command on the printer of a device external id. Throws a
   * CommandError (coded, multi-language) when the printer refuses it.
   */
  async command(externalId, name, value) {
    const printer = this.printerOf(externalId);
    try {
      await printer.link.command(name, value);
    } catch (err) {
      if (err.code) {
        throw new CommandError(err.code, this.language, err.detail);
      }
      throw err;
    }
    return printer;
  }

  /**
   * Heaters of a printer to the given °C (preheat): `tool` goes to every
   * nozzle, `bed` to the bed. Klipper's `max_temp` of each heater bounds it.
   */
  async preheat(externalId, { tool, bed }) {
    const printer = this.printerOf(externalId);
    if (ACTIVE_STATES.has(printer.link.snapshot.state)) {
      throw new CommandError('printing', this.language);
    }
    const heaters = printer.link.capabilities?.heaters ?? printer.capabilities?.heaters ?? [];
    const targets = {};
    for (const heater of heaters) {
      const value = heater.kind === 'extruder' ? tool : heater.kind === 'bed' ? bed : undefined;
      if (value === undefined || value === null) {
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > heater.max) {
        throw new CommandError('out_of_range', this.language, heater.max);
      }
      targets[heater.heater] = Math.round(value);
    }
    if (Object.keys(targets).length === 0) {
      return printer;
    }
    return this.command(externalId, 'heaters', targets);
  }

  /** Every heater off (TURN_OFF_HEATERS), during a print too. */
  coolDown(externalId) {
    return this.command(externalId, 'cool_down');
  }

  /** Run a G-code macro of the printer, by name: only the macros Klipper lists. */
  async runMacro(externalId, name) {
    const printer = this.printerOf(externalId);
    const wanted = typeof name === 'string' ? name.trim() : '';
    if (wanted === '') {
      throw new CommandError('no_macro', this.language);
    }
    const macros = printer.link.capabilities?.macros ?? printer.capabilities?.macros ?? [];
    const macro = MACRO_NAME.test(wanted)
      ? macros.find((m) => m.toUpperCase() === wanted.toUpperCase())
      : undefined;
    if (!macro) {
      throw new CommandError('unknown_macro', this.language, wanted.slice(0, 60));
    }
    return this.command(externalId, 'macro', macro.toUpperCase());
  }

  /** onSetValue: the pause and resume buttons (everything else is read only). */
  async setValue(device, feature) {
    const key = featureKeyOf(feature?.external_id);
    if (key !== 'pause' && key !== 'resume') {
      throw new Error(`Feature ${key} cannot be controlled`);
    }
    await this.command(device.external_id, key);
  }

  /** onPoll (the devices are not polled; the states are pushed): the states again. */
  async poll(device) {
    const printer = this.printers.get(slotOf(this.gladys, device?.external_id));
    if (printer) {
      await this.#publishStates(printer);
    }
  }

  /** onGetImage: a fresh webcam image. */
  async getImage(device) {
    const printer = this.printerOf(device?.external_id);
    if (!printer.capabilities?.camera) {
      throw new CommandError('no_camera', this.language);
    }
    try {
      return await printer.link.cameraImage(MAX_IMAGE_BYTES);
    } catch (err) {
      throw new CommandError(err.code ?? 'camera_unreachable', this.language);
    }
  }

  async #pushCamera(printer) {
    const ids = deviceIds(this.gladys, printer.slot);
    const created = (this.gladys.devices ?? []).some((d) => d.external_id === ids.device);
    if (!created || !printer.link.connected || !printer.capabilities?.camera) {
      return;
    }
    try {
      const image = await printer.link.cameraImage(MAX_IMAGE_BYTES);
      await this.gladys.publishCameraImage(ids.feature('camera'), image);
    } catch (err) {
      if (printer.cameraError !== err.message) {
        logger.warn(`Printer ${printer.slot}: no webcam image (${err.message})`);
      }
      printer.cameraError = err.message;
      return;
    }
    printer.cameraError = null;
  }

  // --- "Test the connection" ---------------------------------------------------

  testReport() {
    if (this.printers.size === 0) {
      return Object.fromEntries(Object.entries(TEST_TEXT).map(([lang, t]) => [lang, t.none]));
    }
    const lines = Object.fromEntries(Object.keys(TEST_TEXT).map((language) => [language, []]));
    for (const printer of [...this.printers.values()].sort((a, b) => a.slot - b.slot)) {
      const { state } = printer.link.snapshot;
      const macros = printer.link.connected ? (printer.link.capabilities?.macros ?? null) : null;
      for (const [language, table] of Object.entries(TEST_TEXT)) {
        lines[language].push(table.ok(printer.slot, STATE_LABELS[language][state]));
        if (macros) {
          lines[language].push(macros.length > 0 ? table.macros(macros.join(', ')) : table.noMacro);
        }
      }
    }
    return Object.fromEntries(
      // Line breaks are honored by Gladys under the action button.
      Object.entries(lines).map(([language, list]) => [language, list.join('\n').slice(0, 3000)]),
    );
  }
}
