// -----------------------------------------------------------------------------
// Every text the container produces, in the four languages of the Gladys
// interface. German says "du", Spanish "usted" (test/i18n.test.js).
// A device integration never receives the user's language: the `language`
// field of the configuration picks one (default: French).
// -----------------------------------------------------------------------------

/** Feature names, frozen when the device is added to Gladys. */
export const NAMES = {
  en: {
    state: 'State',
    file: 'File',
    progress: 'Progress',
    elapsed: 'Elapsed time',
    left: 'Time left',
    layer: 'Layer',
    layerTotal: 'Total layers',
    extruder: 'Nozzle',
    bed: 'Bed',
    target: 'target',
    fan: 'Part cooling fan',
    pause: 'Pause',
    resume: 'Resume',
    camera: 'Webcam',
  },
  fr: {
    state: 'État',
    file: 'Fichier',
    progress: 'Progression',
    elapsed: 'Temps écoulé',
    left: 'Temps restant',
    layer: 'Couche',
    layerTotal: 'Nombre de couches',
    extruder: 'Buse',
    bed: 'Plateau',
    target: 'consigne',
    fan: 'Ventilateur de pièce',
    pause: 'Pause',
    resume: 'Reprise',
    camera: 'Webcam',
  },
  de: {
    state: 'Status',
    file: 'Datei',
    progress: 'Fortschritt',
    elapsed: 'Verstrichene Zeit',
    left: 'Restzeit',
    layer: 'Schicht',
    layerTotal: 'Schichten gesamt',
    extruder: 'Düse',
    bed: 'Druckbett',
    target: 'Soll',
    fan: 'Bauteillüfter',
    pause: 'Pausieren',
    resume: 'Fortsetzen',
    camera: 'Webcam',
  },
  es: {
    state: 'Estado',
    file: 'Archivo',
    progress: 'Progreso',
    elapsed: 'Tiempo transcurrido',
    left: 'Tiempo restante',
    layer: 'Capa',
    layerTotal: 'Capas totales',
    extruder: 'Boquilla',
    bed: 'Cama',
    target: 'consigna',
    fan: 'Ventilador de capa',
    pause: 'Pausar',
    resume: 'Reanudar',
    camera: 'Webcam',
  },
};

/** The `state` feature (text), one label per state of src/moonraker/model.js. */
export const STATE_LABELS = {
  en: {
    unreachable: 'Moonraker unreachable',
    unauthorized: 'API key missing or refused',
    klippy_disconnected: 'Klipper disconnected',
    klippy_startup: 'Klipper starting',
    klippy_shutdown: 'Klipper stopped (shutdown)',
    klippy_error: 'Klipper error',
    standby: 'Ready',
    printing: 'Printing',
    paused: 'Paused',
    complete: 'Finished',
    cancelled: 'Cancelled',
    error: 'Print error',
  },
  fr: {
    unreachable: 'Moonraker injoignable',
    unauthorized: "Clé d'API absente ou refusée",
    klippy_disconnected: 'Klipper déconnecté',
    klippy_startup: 'Démarrage de Klipper',
    klippy_shutdown: 'Klipper arrêté (shutdown)',
    klippy_error: 'Klipper en erreur',
    standby: 'Prête',
    printing: 'Impression',
    paused: 'En pause',
    complete: 'Terminée',
    cancelled: 'Annulée',
    error: "Erreur d'impression",
  },
  de: {
    unreachable: 'Moonraker nicht erreichbar',
    unauthorized: 'API-Schlüssel fehlt oder abgelehnt',
    klippy_disconnected: 'Klipper getrennt',
    klippy_startup: 'Klipper startet',
    klippy_shutdown: 'Klipper gestoppt (Shutdown)',
    klippy_error: 'Klipper-Fehler',
    standby: 'Bereit',
    printing: 'Druckt',
    paused: 'Pausiert',
    complete: 'Fertig',
    cancelled: 'Abgebrochen',
    error: 'Druckfehler',
  },
  es: {
    unreachable: 'Moonraker inaccesible',
    unauthorized: 'Clave de API ausente o rechazada',
    klippy_disconnected: 'Klipper desconectado',
    klippy_startup: 'Klipper arrancando',
    klippy_shutdown: 'Klipper detenido (shutdown)',
    klippy_error: 'Error de Klipper',
    standby: 'Lista',
    printing: 'Imprimiendo',
    paused: 'En pausa',
    complete: 'Terminada',
    cancelled: 'Cancelada',
    error: 'Error de impresión',
  },
};

/** The `file` feature when no job is selected (a text state is never empty). */
export const NO_FILE = {
  en: 'No file',
  fr: 'Aucun fichier',
  de: 'Keine Datei',
  es: 'Ningún archivo',
};

const pad = (minutes) => String(minutes).padStart(2, '0');

/** Durations: "1 h 05 min" and its translations. */
export const DURATION = {
  en: { hours: (h, m) => `${h} h ${pad(m)} min`, minutes: (m) => `${m} min` },
  fr: { hours: (h, m) => `${h} h ${pad(m)} min`, minutes: (m) => `${m} min` },
  de: { hours: (h, m) => `${h} Std. ${pad(m)} Min.`, minutes: (m) => `${m} Min.` },
  es: { hours: (h, m) => `${h} h ${pad(m)} min`, minutes: (m) => `${m} min` },
};

export function formatDuration(seconds, language) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return '';
  }
  const table = DURATION[language] ?? DURATION.en;
  const total = Math.round(seconds / 60);
  if (total < 60) {
    return table.minutes(total);
  }
  return table.hours(Math.floor(total / 60), total % 60);
}

/** Why a command was refused; thrown to Gladys or shown as a widget toast. */
export const COMMAND_ERRORS = {
  en: {
    unreachable: 'Moonraker does not answer.',
    not_ready: 'Klipper is not ready.',
    not_printing: 'No print in progress.',
    not_paused: 'The print is not paused.',
    printing: 'A print is in progress: temperatures left unchanged.',
    not_stopped: 'Klipper is not stopped on an error.',
    refused: (detail) => `Klipper refused: ${detail}`,
    unknown_device: 'This printer is not configured in the integration anymore.',
    out_of_range: (max) => `Temperature out of range (0 to ${max} °C).`,
    no_macro: 'Enter the name of a macro.',
    unknown_macro: (name) => `No macro named ${name} on this printer.`,
    camera_unreachable: 'The webcam does not answer.',
    camera_format: 'The webcam image is not a JPEG.',
    camera_size: 'The webcam image is larger than 150 KB: lower its resolution.',
    no_camera: 'No webcam with snapshots in Moonraker.',
  },
  fr: {
    unreachable: 'Moonraker ne répond pas.',
    not_ready: "Klipper n'est pas prêt.",
    not_printing: 'Aucune impression en cours.',
    not_paused: "L'impression n'est pas en pause.",
    printing: 'Une impression est en cours : températures inchangées.',
    not_stopped: "Klipper n'est pas arrêté sur une erreur.",
    refused: (detail) => `Refusé par Klipper : ${detail}`,
    unknown_device: "Cette imprimante n'est plus configurée dans l'intégration.",
    out_of_range: (max) => `Température hors limites (0 à ${max} °C).`,
    no_macro: "Saisissez le nom d'une macro.",
    unknown_macro: (name) => `Aucune macro ${name} sur cette imprimante.`,
    camera_unreachable: 'La webcam ne répond pas.',
    camera_format: "L'image de la webcam n'est pas un JPEG.",
    camera_size: "L'image de la webcam dépasse 150 Ko : baissez sa résolution.",
    no_camera: 'Aucune webcam avec capture dans Moonraker.',
  },
  de: {
    unreachable: 'Moonraker antwortet nicht.',
    not_ready: 'Klipper ist nicht bereit.',
    not_printing: 'Kein Druck aktiv.',
    not_paused: 'Der Druck ist nicht pausiert.',
    printing: 'Ein Druck läuft: Temperaturen unverändert.',
    not_stopped: 'Klipper ist nicht wegen eines Fehlers gestoppt.',
    refused: (detail) => `Von Klipper abgelehnt: ${detail}`,
    unknown_device: 'Dieser Drucker ist in der Integration nicht mehr eingerichtet.',
    out_of_range: (max) => `Temperatur außerhalb des Bereichs (0 bis ${max} °C).`,
    no_macro: 'Gib den Namen eines Makros ein.',
    unknown_macro: (name) => `Kein Makro ${name} auf diesem Drucker.`,
    camera_unreachable: 'Die Webcam antwortet nicht.',
    camera_format: 'Das Webcam-Bild ist kein JPEG.',
    camera_size: 'Das Webcam-Bild ist größer als 150 KB: Verringere seine Auflösung.',
    no_camera: 'Keine Webcam mit Schnappschuss in Moonraker.',
  },
  es: {
    unreachable: 'Moonraker no responde.',
    not_ready: 'Klipper no está listo.',
    not_printing: 'No hay ninguna impresión en curso.',
    not_paused: 'La impresión no está en pausa.',
    printing: 'Hay una impresión en curso: temperaturas sin cambios.',
    not_stopped: 'Klipper no está detenido por un error.',
    refused: (detail) => `Rechazado por Klipper: ${detail}`,
    unknown_device: 'Esta impresora ya no está configurada en la integración.',
    out_of_range: (max) => `Temperatura fuera de rango (0 a ${max} °C).`,
    no_macro: 'Introduzca el nombre de una macro.',
    unknown_macro: (name) => `No hay ninguna macro ${name} en esta impresora.`,
    camera_unreachable: 'La webcam no responde.',
    camera_format: 'La imagen de la webcam no es un JPEG.',
    camera_size: 'La imagen de la webcam supera los 150 KB: reduzca su resolución.',
    no_camera: 'No hay ninguna webcam con captura en Moonraker.',
  },
};

/** One multi-language object for a coded command error. */
export function commandMessage(code, ...args) {
  return Object.fromEntries(
    Object.entries(COMMAND_ERRORS).map(([language, table]) => {
      const text = table[code] ?? table.unreachable;
      return [language, (typeof text === 'function' ? text(...args) : text).slice(0, 200)];
    }),
  );
}

/** The connection status of the Configuration screen. */
export const STATUS_TEXT = {
  en: {
    none: 'Enter the address of your Moonraker (Mainsail or Fluidd printer), then save.',
    invalid: (n) => `Printer ${n}: invalid address.`,
    unauthorized: (n) => `Printer ${n}: API key missing or refused by Moonraker.`,
    unreachable: (n) => `Printer ${n}: Moonraker does not answer.`,
  },
  fr: {
    none: "Saisissez l'adresse de votre Moonraker (imprimante Mainsail ou Fluidd), puis enregistrez.",
    invalid: (n) => `Imprimante ${n} : adresse invalide.`,
    unauthorized: (n) => `Imprimante ${n} : clé d'API absente ou refusée par Moonraker.`,
    unreachable: (n) => `Imprimante ${n} : Moonraker ne répond pas.`,
  },
  de: {
    none: 'Gib die Adresse deines Moonraker ein (Drucker mit Mainsail oder Fluidd) und speichere.',
    invalid: (n) => `Drucker ${n}: ungültige Adresse.`,
    unauthorized: (n) => `Drucker ${n}: API-Schlüssel fehlt oder wurde von Moonraker abgelehnt.`,
    unreachable: (n) => `Drucker ${n}: Moonraker antwortet nicht.`,
  },
  es: {
    none: 'Introduzca la dirección de su Moonraker (impresora con Mainsail o Fluidd) y guarde.',
    invalid: (n) => `Impresora ${n}: dirección no válida.`,
    unauthorized: (n) => `Impresora ${n}: clave de API ausente o rechazada por Moonraker.`,
    unreachable: (n) => `Impresora ${n}: Moonraker no responde.`,
  },
};

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

/** The report of the "Test the connection" action. */
export const TEST_TEXT = {
  en: {
    none: 'No Moonraker configured.',
    ok: (n, state) => `Printer ${n}: ${state}.`,
    macros: (list) => `Macros: ${list}.`,
    noMacro: 'No macro.',
  },
  fr: {
    none: 'Aucun Moonraker configuré.',
    ok: (n, state) => `Imprimante ${n} : ${state}.`,
    macros: (list) => `Macros : ${list}.`,
    noMacro: 'Aucune macro.',
  },
  de: {
    none: 'Kein Moonraker eingerichtet.',
    ok: (n, state) => `Drucker ${n}: ${state}.`,
    macros: (list) => `Makros: ${list}.`,
    noMacro: 'Kein Makro.',
  },
  es: {
    none: 'No hay ningún Moonraker configurado.',
    ok: (n, state) => `Impresora ${n}: ${state}.`,
    macros: (list) => `Macros: ${list}.`,
    noMacro: 'Ninguna macro.',
  },
};

/** Toasts of the widget buttons (the widget action receives no language). */
export const DONE_TEXT = {
  pause: {
    en: 'Pause requested.',
    fr: 'Pause demandée.',
    de: 'Pause angefordert.',
    es: 'Pausa solicitada.',
  },
  resume: {
    en: 'Resume requested.',
    fr: 'Reprise demandée.',
    de: 'Fortsetzen angefordert.',
    es: 'Reanudación solicitada.',
  },
  cancel: {
    en: 'Cancellation requested.',
    fr: 'Annulation demandée.',
    de: 'Abbruch angefordert.',
    es: 'Cancelación solicitada.',
  },
  preheat: {
    en: 'Preheating.',
    fr: 'Préchauffage lancé.',
    de: 'Vorheizen gestartet.',
    es: 'Precalentamiento iniciado.',
  },
  cool_down: {
    en: 'Heaters off.',
    fr: 'Chauffes coupées.',
    de: 'Heizungen aus.',
    es: 'Calentadores apagados.',
  },
  firmware_restart: {
    en: 'Klipper is restarting.',
    fr: 'Klipper redémarre.',
    de: 'Klipper startet neu.',
    es: 'Klipper se está reiniciando.',
  },
};
