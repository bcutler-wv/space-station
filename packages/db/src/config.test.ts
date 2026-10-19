import { expect, test } from 'vitest';
import { databaseUrl, loadRuntimeConfig } from './config.js';

const valid = {
  POSTGRES_PASSWORD: 'strong-example-pass!#@:/',
  STATION_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  APP_ORIGIN: 'https://localhost:8080',
};

test('rejects invalid bootstrap secrets without exposing their values', () => {
  expect(() => loadRuntimeConfig({ ...valid, STATION_MASTER_KEY: 'example-secret' })).toThrow(/STATION_MASTER_KEY/);
  expect(() => loadRuntimeConfig({ ...valid, POSTGRES_PASSWORD: 'short' })).toThrow(/POSTGRES_PASSWORD/);
});

test('encodes reserved password characters in the database URL', () => {
  const config = loadRuntimeConfig(valid);
  const url = new URL(databaseUrl(config));
  expect(decodeURIComponent(url.password)).toBe(valid.POSTGRES_PASSWORD);
  expect(url.hostname).toBe('127.0.0.1');
  expect(config.APP_PORT).toBe(8080);
});
