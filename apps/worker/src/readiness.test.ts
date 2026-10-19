import { expect, test } from 'vitest';
import { hasLiveConsumer } from './readiness.js';

const host = 'worker-container';
const registered = {
  name: 'worker', host, live: true, stoppedOn: null,
  workers: [{ queue: 'runtime.probe' }],
};

test('queue existence without a registered consumer is unhealthy', () => {
  expect(hasLiveConsumer([], host)).toBe(false);
  expect(hasLiveConsumer([{ ...registered, workers: [] }], host)).toBe(false);
});

test('requires a live consumer on this container', () => {
  expect(hasLiveConsumer([registered], host)).toBe(true);
  expect(hasLiveConsumer([{ ...registered, live: false }], host)).toBe(false);
  expect(hasLiveConsumer([{ ...registered, stoppedOn: new Date() }], host)).toBe(false);
  expect(hasLiveConsumer([registered], 'another-container')).toBe(false);
});
