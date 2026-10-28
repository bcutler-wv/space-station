/** Docker omits a false HostConfig.Mounts.ReadOnly; effective Mounts.RW must still be true. */
export function transferInvocationWritable(host, effective, source) {
  return host?.Type === 'volume' && host.Source === source &&
    host.Target === '/run/create-boundary' &&
    [undefined, false].includes(host.ReadOnly) &&
    host.VolumeOptions?.NoCopy === true &&
    effective?.Type === 'volume' && effective.Name === source &&
    effective.Destination === '/run/create-boundary' && effective.RW === true;
}
