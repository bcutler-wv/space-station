/** Internal observer accounting seam. Production supplies fixed limits; tests use a fake clock. */
export function observerBudget(limits: { milliseconds: number; bytes: number }, now: () => number,
  fail: (kind: 'timeout' | 'response') => never) {
  const deadline = now() + limits.milliseconds;
  let received = 0;
  const check = () => { if (now() >= deadline) fail('timeout'); };
  return {
    check,
    remaining(maximum: number) {
      check();
      const value = Math.min(maximum, Math.floor(deadline - now()));
      if (value < 1) fail('timeout');
      return value;
    },
    chunk(bytes: number) {
      received += bytes;
      if (received > limits.bytes) fail('response');
      check();
    },
  };
}
