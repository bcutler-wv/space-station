/** Disposable passthrough probe: record the attempt, then preserve the SDK call. */
export function installWriterPrepareRequestProbe(Connection, emit) {
  if (typeof Connection !== 'function' ||
      typeof Connection.prototype?.request !== 'function' ||
      typeof emit !== 'function') throw Error('Invalid disposable request probe');
  const original = Connection.prototype.request;
  Connection.prototype.request = function request(params, callback) {
    const method = params?.method;
    emit(['GET', 'HEAD'].includes(method) ? method : 'OTHER');
    return original.call(this, params, callback);
  };
  return () => { Connection.prototype.request = original; };
}
