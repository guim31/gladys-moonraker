// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `printer`, "Klipper 3D
// print".
//
// The Gladys device box already lists every feature. What the widget adds:
// the print at a glance (progress gauge, time left, temperatures as live
// tiles), the layer and when it will finish, and the buttons that matter in
// the current state — pause or resume, cancel (with a confirmation: the
// device box has no cancel button on purpose), preheat or cool down when
// idle, restart Klipper (with a confirmation) after it stopped on an error.
//
// Budget (8 components, 2 texts): at most four tiles, one status list and two
// buttons. No button opens a form, so Gladys 5.1 is enough: the preheat
// temperatures are widget settings. No emergency stop: Klipper's M112 is a
// last resort for someone standing at the printer, not a dashboard button.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { deviceIds } from './devices.js';
import { CommandError, WIDGET_KEY } from './hub.js';
import { ACTIVE_STATES, DOWN_STATES } from './moonraker/model.js';
import { PREHEAT_DEFAULTS } from './scenes.js';
import { DONE_TEXT, STATE_LABELS, formatDuration } from './texts.js';

export { WIDGET_KEY };

export const TEXT = {
  pick: {
    en: 'Choose a Klipper printer in the widget settings.',
    fr: 'Choisissez une imprimante Klipper dans les réglages du widget.',
    de: 'Wähle einen Klipper-Drucker in den Widget-Einstellungen.',
    es: 'Elija una impresora Klipper en los ajustes del widget.',
  },
  unknown: {
    en: 'This printer is not configured in the Moonraker integration anymore.',
    fr: "Cette imprimante n'est plus configurée dans l'intégration Moonraker.",
    de: 'Dieser Drucker ist in der Moonraker-Integration nicht mehr eingerichtet.',
    es: 'Esta impresora ya no está configurada en la integración Moonraker.',
  },
  waiting: {
    en: 'Waiting for Moonraker to answer.',
    fr: "En attente d'une réponse de Moonraker.",
    de: 'Warte auf eine Antwort von Moonraker.',
    es: 'Esperando la respuesta de Moonraker.',
  },
  progress: { en: 'Progress', fr: 'Progression', de: 'Fortschritt', es: 'Progreso' },
  left: { en: 'Time left', fr: 'Restant', de: 'Restzeit', es: 'Restante' },
  tool: { en: 'Nozzle', fr: 'Buse', de: 'Düse', es: 'Boquilla' },
  bed: { en: 'Bed', fr: 'Plateau', de: 'Druckbett', es: 'Cama' },
  state: { en: 'State', fr: 'État', de: 'Status', es: 'Estado' },
  file: { en: 'File', fr: 'Fichier', de: 'Datei', es: 'Archivo' },
  layer: { en: 'Layer', fr: 'Couche', de: 'Schicht', es: 'Capa' },
  elapsed: { en: 'Elapsed', fr: 'Écoulé', de: 'Verstrichen', es: 'Transcurrido' },
  finish: { en: 'Ends at', fr: 'Fin vers', de: 'Fertig um', es: 'Termina a las' },
  targets: { en: 'Targets', fr: 'Consignes', de: 'Solltemperaturen', es: 'Consignas' },
  pause: { en: 'Pause', fr: 'Pause', de: 'Pausieren', es: 'Pausar' },
  resume: { en: 'Resume', fr: 'Reprendre', de: 'Fortsetzen', es: 'Reanudar' },
  cancel: { en: 'Cancel', fr: 'Annuler', de: 'Abbrechen', es: 'Cancelar' },
  preheat: { en: 'Preheat', fr: 'Préchauffer', de: 'Vorheizen', es: 'Precalentar' },
  cool_down: { en: 'Cool down', fr: 'Refroidir', de: 'Abkühlen', es: 'Enfriar' },
  firmware_restart: {
    en: 'Restart Klipper',
    fr: 'Redémarrer Klipper',
    de: 'Klipper neu starten',
    es: 'Reiniciar Klipper',
  },
};

const STATE_COLORS = {
  unreachable: WIDGET_COLORS.DANGER,
  unauthorized: WIDGET_COLORS.DANGER,
  klippy_disconnected: WIDGET_COLORS.DANGER,
  klippy_startup: WIDGET_COLORS.NEUTRAL,
  klippy_shutdown: WIDGET_COLORS.DANGER,
  klippy_error: WIDGET_COLORS.DANGER,
  standby: WIDGET_COLORS.SUCCESS,
  printing: WIDGET_COLORS.PRIMARY,
  paused: WIDGET_COLORS.WARNING,
  complete: WIDGET_COLORS.SUCCESS,
  cancelled: WIDGET_COLORS.NEUTRAL,
  error: WIDGET_COLORS.DANGER,
};

export const WIDGET_ACTIONS = [
  'pause',
  'resume',
  'cancel',
  'preheat',
  'cool_down',
  'firmware_restart',
];

// Klipper idle, a print may be prepared.
const IDLE_STATES = new Set(['standby', 'complete', 'cancelled', 'error']);

const pick = (table, language) => table[language] ?? table.en;
const textOnly = (text, ttl = 60) => ({
  ttl_seconds: ttl,
  components: [{ type: 'text', variant: 'body', text }],
});

function temperatureText(celsius, units) {
  const value = units === 'us' ? Math.round((celsius * 9) / 5 + 32) : Math.round(celsius);
  return `${value} °${units === 'us' ? 'F' : 'C'}`;
}

function clockTime(date, language) {
  try {
    return date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

function button(language, key, icon, extra = {}) {
  return { type: 'button', label: pick(TEXT[key], language), icon, action: { key }, ...extra };
}

/** The printer of the widget settings, or null. */
export function printerOfSettings(hub, settings) {
  return (
    [...hub.printers.values()].find(
      (p) => deviceIds(hub.gladys, p.slot).device === settings.device,
    ) ?? null
  );
}

/**
 * The widget content for a printer.
 * @param {object} hub
 * @param {{ settings?: object, language?: string, units?: string }} request
 */
export function buildContent(hub, { settings = {}, language = 'en', units = 'metric' }) {
  const lang = STATE_LABELS[language] ? language : 'en';
  if (typeof settings.device !== 'string' || settings.device === '') {
    return textOnly(pick(TEXT.pick, lang), 300);
  }
  const printer = printerOfSettings(hub, settings);
  if (!printer) {
    return textOnly(pick(TEXT.unknown, lang), 300);
  }
  const capabilities = printer.capabilities;
  if (!capabilities) {
    return textOnly(pick(TEXT.waiting, lang), 30);
  }
  const ids = deviceIds(hub.gladys, printer.slot);
  const snapshot = printer.link.snapshot;
  const active = ACTIVE_STATES.has(snapshot.state);
  const fresh = !DOWN_STATES.has(snapshot.state);
  const components = [
    {
      type: 'gauge',
      label: pick(TEXT.progress, lang),
      device_feature: ids.feature('progress'),
      color: WIDGET_COLORS.PRIMARY,
    },
    { type: 'value', label: pick(TEXT.left, lang), device_feature: ids.feature('time_left') },
  ];
  const nozzle = capabilities.heaters.find((h) => h.kind === 'extruder');
  if (nozzle) {
    components.push({
      type: 'value',
      label: pick(TEXT.tool, lang),
      device_feature: ids.feature(`${nozzle.key}_temperature`),
    });
  }
  const bed = capabilities.heaters.find((h) => h.kind === 'bed');
  if (bed) {
    components.push({
      type: 'value',
      label: pick(TEXT.bed, lang),
      device_feature: ids.feature(`${bed.key}_temperature`),
    });
  }

  const items = [
    {
      label: pick(TEXT.state, lang),
      value: STATE_LABELS[lang][snapshot.state].slice(0, 40),
      color: STATE_COLORS[snapshot.state],
    },
  ];
  if (snapshot.file && fresh) {
    items.push({ label: pick(TEXT.file, lang), value: snapshot.file.slice(0, 40), icon: 'file' });
  }
  if (active && snapshot.layer !== null && snapshot.layerTotal) {
    items.push({
      label: pick(TEXT.layer, lang),
      value: `${Math.round(snapshot.layer)} / ${Math.round(snapshot.layerTotal)}`,
      icon: 'layers',
    });
  }
  if (active && snapshot.totalDuration !== null) {
    items.push({
      label: pick(TEXT.elapsed, lang),
      value: formatDuration(snapshot.totalDuration, lang),
      icon: 'clock',
    });
  }
  if (snapshot.state === 'printing' && snapshot.timeLeft !== null) {
    items.push({
      label: pick(TEXT.finish, lang),
      value: clockTime(new Date(hub.now() + snapshot.timeLeft * 1000), lang),
      icon: 'flag',
    });
  }
  const targets = capabilities.heaters
    .map((heater) => snapshot.temperatures[heater.key]?.target ?? 0)
    .filter((target) => target > 0)
    .map((target) => temperatureText(target, units));
  if (targets.length > 0 && fresh && !snapshot.state.startsWith('klippy_')) {
    items.push({
      label: pick(TEXT.targets, lang),
      value: targets.join(' / ').slice(0, 40),
      icon: 'thermometer',
    });
  }
  components.push({ type: 'status', items });

  const confirmed = (key, icon, style) => {
    const result = button(lang, key, icon, { style });
    result.action.confirm = true;
    return result;
  };
  if (snapshot.state === 'printing') {
    components.push(button(lang, 'pause', 'pause'), confirmed('cancel', 'x-circle', 'danger'));
  } else if (snapshot.state === 'paused') {
    components.push(button(lang, 'resume', 'play'), confirmed('cancel', 'x-circle', 'danger'));
  } else if (IDLE_STATES.has(snapshot.state)) {
    components.push(button(lang, 'preheat', 'thermometer'));
    if (targets.length > 0) {
      components.push(button(lang, 'cool_down', 'wind'));
    }
  } else if (['klippy_shutdown', 'klippy_error'].includes(snapshot.state)) {
    components.push(confirmed('firmware_restart', 'refresh-cw', 'secondary'));
  }

  return { ttl_seconds: active ? 30 : 300, components };
}

function settingNumber(value, fallback) {
  const number = typeof value === 'string' ? Number(value.replace(',', '.')) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : fallback;
}

export const WIDGETS = {
  [WIDGET_KEY]: {
    get(hub, request) {
      return buildContent(hub, request ?? {});
    },

    /** Resolves the toast (the widget action receives no language: all four). */
    async action(hub, { actionKey, settings = {} }) {
      const device = settings.device;
      try {
        switch (actionKey) {
          case 'pause':
          case 'resume':
          case 'cancel':
          case 'firmware_restart':
            await hub.command(device, actionKey);
            break;
          case 'preheat':
            await hub.preheat(device, {
              tool: settingNumber(settings.preheat_tool, PREHEAT_DEFAULTS.tool_temperature),
              bed: settingNumber(settings.preheat_bed, PREHEAT_DEFAULTS.bed_temperature),
            });
            break;
          case 'cool_down':
            await hub.coolDown(device);
            break;
          default:
            throw new Error(`Unknown widget action ${actionKey}`);
        }
      } catch (err) {
        if (err instanceof CommandError) {
          return err.messages;
        }
        throw err;
      }
      return DONE_TEXT[actionKey];
    },
  },
};
