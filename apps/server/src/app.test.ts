import { afterEach, expect, test } from 'vitest';
import { healthResponseSchema } from '@station/shared';
import { buildApp } from './app.js';

const app = buildApp();
afterEach(async () => app.close());

test('GET /health returns the shared API contract', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' });
  expect(response.statusCode).toBe(200);
  expect(healthResponseSchema.parse(response.json())).toEqual({ status: 'ok' });
});
