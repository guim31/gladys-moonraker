# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.0] - 2026-10-13

### Added

- One Gladys device per Moonraker (Klipper) printer, up to three: state, file,
  progress, elapsed and remaining time, layer and total layers, temperatures
  and targets of every nozzle, the bed and each `heater_generic` (read only,
  kept out of the room temperature; heating goes through the widget and the
  scene actions), temperature sensors, part cooling fan, pause and resume
  buttons, and the webcam snapshot.
- Live values over Moonraker's WebSocket, an optional API key, the bounds of
  each heater read from Klipper's `max_temp`.
- "Klipper 3D print" dashboard widget: progress gauge, time left,
  temperatures, state, file, layer, end time, targets, and pause / resume /
  cancel (with confirmation) / preheat / cool down / restart Klipper (with
  confirmation) buttons depending on the state.
- Scene triggers: print started, print finished, print failed or cancelled
  (filter by reason), print paused, Klipper stopped on an error.
- Scene actions: pause, resume or cancel a print, preheat (refused during a
  print), turn the heaters off, run a Klipper macro by name.
- "Test the connection" action: the state and the macros of each printer.
- Texts and documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-moonraker/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guim31/gladys-moonraker/releases/tag/v1.0.0
