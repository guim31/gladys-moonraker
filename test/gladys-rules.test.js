// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from realistic
// fixtures (Moonraker driving Klipper with a simulated micro-controller): a
// single-nozzle printer, a printer with two nozzles, a heated chamber, a host
// temperature sensor and a webcam, and one whose Klipper is stopped — in
// every feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { API_KEY, createMoonraker } from './helpers/fakeMoonraker.js';
import { createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

function threePrinters() {
  return [
    createMoonraker({ host: '192.0.2.10' }),
    createMoonraker({
      host: '192.0.2.11',
      printer: 'rich',
      apiKey: API_KEY,
      image: JPEG,
      printState: 'printing',
    }),
    createMoonraker({ host: '192.0.2.12', printState: 'complete' }),
  ];
}

const config = (servers, language) => ({
  ...Object.fromEntries(
    servers.flatMap((server, index) => [
      [`url_${index + 1}`, server.host],
      [`api_key_${index + 1}`, server.apiKey ?? ''],
    ]),
  ),
  ...(language ? { language } : {}),
});

const scenarios = [
  { label: 'default language (French)', language: undefined },
  { label: 'English names', language: 'en' },
  { label: 'German names', language: 'de' },
  { label: 'Spanish names', language: 'es' },
];

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async () => {
    const servers = threePrinters();
    const { gladys, app } = await createWorld({
      servers,
      config: config(servers, scenario.language),
    });
    try {
      const devices = gladys.fake.discoveredDevices;
      assert.equal(devices.length, 3, 'one device per Moonraker instance');
      const rich = devices.find((d) => d.external_id.endsWith(':2'));
      for (const key of [
        'extruder1_target',
        'heater_chamber_temperature',
        'heater_chamber_target',
        'sensor_raspberry_pi',
        'fan',
        'camera',
      ]) {
        assert.ok(
          rich.features.some((f) => f.external_id.endsWith(`:${key}`)),
          `${key} missing`,
        );
      }

      for (const device of devices) {
        const where = device.name;

        // should_poll: true if and only if poll_frequency is provided, in ms.
        if (device.poll_frequency === undefined) {
          assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
        } else {
          assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
          assert.ok(
            table.poll_frequencies_ms.includes(device.poll_frequency),
            `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
          );
        }

        assert.ok(device.features.length > 0, `${where}: no feature`);
        const externalIds = new Set();
        const names = new Set();
        for (const feature of device.features) {
          const at = `${where} / ${feature.name}`;
          const pair = table.pairs[`${feature.category}/${feature.type}`];
          assert.ok(
            pair,
            `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`,
          );
          assert.ok(
            pair.label_en && pair.label_fr && pair.icon,
            `${at}: couple without label or icon`,
          );

          assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
          assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
          assert.ok(
            Number.isFinite(feature.min) && Number.isFinite(feature.max),
            `${at}: finite min/max`,
          );
          assert.ok(feature.min <= feature.max, `${at}: min > max`);
          assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
          assert.equal(
            typeof feature.has_feedback,
            'boolean',
            `${at}: has_feedback must be a boolean`,
          );
          if (feature.unit !== undefined) {
            assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
          }

          assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
          externalIds.add(feature.external_id);
          assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
          names.add(feature.name);
        }
      }
    } finally {
      await app.stop();
    }
  });
}
