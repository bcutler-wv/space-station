import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

/** Fixture-only interception after a real pinned SDK connection gets headers. */
export function installHeldCreateResponse(Connection, { marker, heldPath, releasePath,
  ticks = 300, tickMs = 100 }) {
  const request = Connection.prototype.request;
  Connection.prototype.request = function fixtureRequest(params, callback) {
    if (params.method !== 'PUT' ||
        !/^\/station-mail-v2-g[a-z0-9]{16,64}(?:\?|$)/.test(params.path))
      return request.call(this, params, callback);
    let settled = false, heldResponse;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      if (error && heldResponse && !heldResponse.destroyed) heldResponse.destroy();
      callback(error, response);
    };
    const handle = request.call(this, params, (error, response) => {
      if (error) { finish(error, response); return; }
      heldResponse = response;
      marker('TRANSPORT_REAL_RESPONSE_HELD');
      writeFileSync(heldPath, '1', { mode: 0o600, flag: 'wx' });
      void (async () => {
        for (let tick = 0; tick < ticks && !settled; tick++) {
          if (existsSync(releasePath)) {
            marker('TRANSPORT_RELEASED'); finish(null, response); return;
          }
          await delay(tickMs);
        }
        finish(Error('Fixture transport hold expired'), null);
      })();
    });
    handle.once('abort', () => {
      marker('TRANSPORT_ABORTED'); finish(Error('Fixture request aborted'), null);
    });
    handle.once('error', () => finish(Error('Fixture request error'), null));
    return handle;
  };
  return () => { Connection.prototype.request = request; };
}
