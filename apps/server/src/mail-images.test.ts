import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ImageWorkBudget, normalizeMailRaster } from './mail-images.js';

describe('mail image work limits', () => {
  it('reserves capacity before work and counts failed attempts', () => {
    const budget = new ImageWorkBudget(2, 3, 1, 2, 1, 1);
    const a = budget.reserve('item-a', 0);
    const b = budget.reserve('item-a', 0);
    expect(a && b).toBeTruthy();
    expect(budget.reserve('item-a', 0)).toBeNull();
    a!.finish();
    b!.finish();
    expect(budget.reserve('item-a', 0)).not.toBeNull();
    expect(budget.reserve('item-a', 0)).toBeNull();
  });

  it('releases concurrency after failures and caps distinct item entries', () => {
    const budget = new ImageWorkBudget(1, 2, 1, 1, 1, 1);
    const first = budget.reserve('item-a', 0)!;
    expect(budget.reserve('item-b', 0)).toBeNull();
    first.finish();
    first.finish();
    expect(budget.reserve('item-b', 0)).toBeNull();
    const next = budget.reserve('item-b', 60_001);
    expect(next).not.toBeNull();
    next!.finish(2);
    expect(budget.reserve('item-b', 60_001)).toBeNull();
  });

  it('reserves worst-case bytes for concurrent requests but releases unused space', () => {
    const budget = new ImageWorkBudget(4, 10, 1, 1, 3, 1);
    const reservations = [budget.reserve('item', 0), budget.reserve('item', 0), budget.reserve('item', 0)];
    expect(reservations.every(Boolean)).toBe(true);
    expect(budget.reserve('item', 0)).toBeNull();
    reservations[0]!.finish(1);
    const fourth = budget.reserve('item', 0);
    expect(fourth).not.toBeNull();
    reservations[1]!.finish(3);
    reservations[2]!.finish(3);
    fourth!.finish(3);
    expect(budget.reserve('item', 0)).toBeNull();
  });

  it('allows all 64 small successful images within the item budget', () => {
    const budget = new ImageWorkBudget();
    for (let index = 0; index < 64; index++) {
      const reservation = budget.reserve('one-message', 0);
      expect(reservation).not.toBeNull();
      reservation!.finish(4_096);
    }
  });

  it('stops repeated large or partial failures at the aggregate byte ceiling', () => {
    const budget = new ImageWorkBudget();
    for (let index = 0; index < 5; index++) {
      const reservation = budget.reserve('failed-message', 0);
      expect(reservation).not.toBeNull();
      reservation!.finish(6 * 1024 * 1024);
    }
    expect(budget.reserve('failed-message', 0)).toBeNull();
  });
});

describe('mail raster normalization', () => {
  it('converts AVIF identified by sharp as HEIF/AV1 into safe PNG', async () => {
    const avif = await sharp({ create: { width: 2, height: 2, channels: 4,
      background: { r: 1, g: 2, b: 3, alpha: 1 } } }).avif().toBuffer();
    const output = await normalizeMailRaster(avif);
    expect(output.contentType).toBe('image/png');
    expect(output.data.subarray(1, 4).toString('ascii')).toBe('PNG');
  });
});
