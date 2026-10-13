import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, normalizeUrl } from '../src/config.js';

test('addresses: Moonraker on 7125 by default, the web server when a URL is given', () => {
  assert.equal(normalizeUrl('192.0.2.10'), 'http://192.0.2.10:7125');
  assert.equal(normalizeUrl(' voron.local '), 'http://voron.local:7125');
  assert.equal(normalizeUrl('192.0.2.10:7126'), 'http://192.0.2.10:7126');
  assert.equal(normalizeUrl('http://192.0.2.10'), 'http://192.0.2.10');
  assert.equal(normalizeUrl('http://192.0.2.10/'), 'http://192.0.2.10');
  assert.equal(
    normalizeUrl('https://printer.example/moonraker/'),
    'https://printer.example/moonraker',
  );
  assert.equal(normalizeUrl('[2001:db8::1]'), 'http://[2001:db8::1]:7125');
});

test('unusable addresses are refused, credentials in the URL too', () => {
  for (const raw of [
    '',
    '  ',
    'ftp://192.0.2.10',
    'http://',
    'http://user:pw@192.0.2.10',
    'http://192.0.2.10/?token=x',
    42,
    null,
  ]) {
    assert.equal(normalizeUrl(raw), null, String(raw));
  }
});

test('the configuration: slots in order, invalid ones reported, French by default', () => {
  assert.deepEqual(normalizeConfig(DEFAULT_CONFIG), {
    printers: [],
    invalidSlots: [],
    language: 'fr',
  });
  assert.deepEqual(
    normalizeConfig({
      url_1: '192.0.2.10',
      api_key_1: ' KEY ',
      url_2: 'nope://',
      url_3: '192.0.2.12',
      language: 'de',
    }),
    {
      printers: [
        { slot: 1, url: 'http://192.0.2.10:7125', apiKey: 'KEY' },
        { slot: 3, url: 'http://192.0.2.12:7125', apiKey: '' },
      ],
      invalidSlots: [2],
      language: 'de',
    },
  );
  assert.equal(normalizeConfig({ language: 'it' }).language, 'fr');
  assert.deepEqual(normalizeConfig(null).printers, []);
});
