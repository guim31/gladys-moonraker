# Moonraker (Klipper) for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com) that
follows and controls 3D printers running [Klipper](https://www.klipper3d.org),
through [Moonraker](https://moonraker.readthedocs.io), the API server behind
Mainsail and Fluidd: Voron, RatRig, Sovol, Elegoo, rooted Creality K1 / K2 and
the like. Over the local network, through Moonraker's JSON-RPC WebSocket. No
cloud, no account.

> **Developed without the hardware: feedback welcome.** Everything was
> exercised against a real Moonraker driving Klipper with a simulated
> micro-controller (simulavr, image `ei99070/docker-klipper-simulavr`): real
> prints to the end, pause, resume, cancellation, a print error, an emergency
> stop, a sensor shutdown, an API key, a webcam (mjpg-streamer). It has not
> been tried on a physical printer yet: please report what works and what does
> not in the [issues](https://github.com/guim31/gladys-moonraker/issues).

## Features

- **One device per Moonraker** (up to three): state, file, progress, elapsed
  and remaining time, layer and total layers, the temperatures and targets of
  every heater (nozzles, bed, `heater_generic`), the `temperature_sensor`s, the
  part cooling fan, pause and resume buttons, and the webcam snapshot.
  Temperatures and targets are read only: heating goes through the widget and
  the scenes, never the dashboard nor HomeKit, Alexa or Google.
- **Live**: Moonraker pushes Klipper's changes over its WebSocket; the
  integration hands them to Gladys at most every 5 seconds, state changes at
  once.
- **Dashboard widget "Klipper 3D print"**: progress gauge, time left,
  temperatures, state, file, layer, end time, targets, and the buttons that fit
  the moment (pause or resume, cancel with a confirmation, preheat, cool down,
  restart Klipper with a confirmation after a shutdown).
- **Scene triggers**: print started, print finished, print failed or cancelled
  (filter by reason), print paused, Klipper stopped on an error (with its
  message).
- **Scene actions**: pause / resume / cancel a print, preheat (refused during a
  print, within Klipper's `max_temp`), turn the heaters off, run a Klipper
  macro by name (only the macros Klipper lists, no free G-code).
- Texts in English, French, German and Spanish.

## Requirements

- Gladys Assistant 5.1 or later.
- Klipper and Moonraker reachable from Gladys, on port 7125 or through Mainsail
  or Fluidd. A Moonraker API key when Moonraker does not trust the network of
  Gladys (`trusted_clients`).

## Installation

1. In Gladys, open **Integrations → Install from GitHub** and enter
   `https://github.com/guim31/gladys-moonraker` (or find **Moonraker
   (Klipper)** in the catalog).
2. In **Configuration**, enter the IP address of the printer (port 7125 by
   default, or the address of Mainsail / Fluidd), and its API key if needed.
   Save.
3. Add the printer from the **Discover** tab.

The user guide is in [`docs/en.md`](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)); Gladys
links it from the Configuration screen.

## How it works

- One WebSocket per printer (`/websocket`), identified with
  `server.connection.identify` (and the API key when there is one).
- On connection, and every time Klipper becomes ready again:
  `server.info` (Klipper's state), `printer.info`, `printer.objects.list`
  (heaters, sensors, fan, `gcode_macro`s), `printer.objects.query` on `heaters`
  and `configfile.settings` (each heater's `max_temp`), `server.webcams.list`,
  then `printer.objects.subscribe` on the objects the integration reads.
- Print events come from `print_stats.state` transitions, Klipper's shutdowns
  from `webhooks` and `notify_klippy_shutdown`; the slicer estimate from
  `server.files.metadata`.
- Commands: `printer.print.pause|resume|cancel`, `printer.gcode.script`
  (`SET_HEATER_TEMPERATURE`, `TURN_OFF_HEATERS`, a listed macro),
  `printer.firmware_restart`. Never `printer.emergency_stop`.
- Only changed states are published (whole degrees, whole minutes), and
  everything is published again when a device is added. The devices are not
  polled by Gladys.
- What each printer has is kept in `/data/moonraker-state.json`, so a Gladys
  restart while the printer is off still publishes the same device.

## Limitations

- Up to three Moonraker instances.
- No file upload, print start, free G-code, time-lapse, Spoolman or Moonraker
  power devices from Gladys.
- The webcam image is a JPEG snapshot of 150 KB at most (a Gladys limit),
  refreshed every minute and on demand — not a video stream.
- No cancel button on the device itself (one tap would ruin a print), no
  emergency stop button at all.
- `.local` names do not resolve in the integration container: use an IP
  address.

## Development

Node.js 22+, ESM, no build step. The only runtime dependency is
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

```bash
npm install
npm test              # node --test: unit tests + simulated Moonraker instances
npm run lint
npm run format:check
npx github:GladysAssistant/integration-store .   # store validator
```

```
index.js                  SDK wiring (src/app.js registers the handlers)
src/hub.js                printers, states, connection status, scene events, commands
src/printer.js            one Moonraker: initialization, subscription, events, commands, webcam
src/devices.js            Moonraker -> Gladys device, snapshot -> states
src/moonraker/rpc.js      JSON-RPC WebSocket with timeouts, reconnection, idle watchdog
src/moonraker/model.js    reading Moonraker's answers (capabilities, snapshot)
src/widgets.js            "Klipper 3D print" dashboard widget
src/scenes.js             scene actions
src/texts.js              every text, in four languages
test/                     node --test; the SDK's fake Gladys, simulated Moonraker
test/fixtures/moonraker/  real Moonraker answers and sessions, anonymized
```

`test/gladys-rules.test.js` checks every discovered device against the
category/type table extracted from the Gladys core.

To run it outside Gladys:

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="moonraker" \
MOONRAKER_DATA_DIR=./data \
npm start
```

Releases are made by the **Release** workflow (Actions → Release); never edit
the versions by hand. A hand-pushed `vX.Y.Z` tag also builds the image and the
GitHub Release, but then `version` in `package.json` and in the manifest (with
the `docker_image` tag) must be bumped and committed before tagging. See
[`CLAUDE.md`](CLAUDE.md) for the project rules.

## Credits

- The Home Assistant custom integration
  [`moonraker`](https://github.com/marcolivierarsenault/moonraker-home-assistant)
  by Marc-Olivier Arsenault and contributors (MIT): the set of sensors and
  buttons, the handling of the slicer metadata and of the webcam addresses.
- [Moonraker](https://github.com/Arksine/moonraker) by Eric Callahan and
  contributors (GPL-3.0), and its
  [API documentation](https://moonraker.readthedocs.io/en/latest/external_api/introduction/).
- [Klipper](https://github.com/Klipper3d/klipper) by Kevin O'Connor and
  contributors (GPL-3.0). The cover uses the Klipper logo
  (`docs/img/klipper-logo.png` of the Klipper repository).
- [docker-klipper-simulavr](https://github.com/pedrolamas/docker-klipper-simulavr)
  by Pedro Lamas: the simulated printer the fixtures were recorded on.

## Disclaimer

This project is not affiliated with, endorsed or sponsored by the Klipper or
Moonraker projects. "Klipper", "Moonraker", "Mainsail" and "Fluidd" are the
names of their owners' projects.
