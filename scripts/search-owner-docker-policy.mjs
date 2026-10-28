/** Private exact Docker policy shared by the two fixed owner commands. */
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const keys = (value, expected) => value && typeof value === 'object' &&
  !Array.isArray(value) && equal(Object.keys(value).sort(), [...expected].sort());
export const keysSubset = (value, allowed) => value && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
export const sameStat = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode && a.size === b.size && a.nlink === b.nlink &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
export const sameVolume = (a, b) => a.Name === b.Name && a.Driver === b.Driver &&
  a.Scope === b.Scope && a.CreatedAt === b.CreatedAt && a.Mountpoint === b.Mountpoint &&
  equal(a.Labels, b.Labels) && equal(a.Options, b.Options);
export const exactCapAdd = (value, wanted) => {
  const observed = value ?? [];
  if (!Array.isArray(observed) || observed.length !== wanted.length) return false;
  const names = observed.map(item => {
    if (item === 'CHOWN' || item === 'CAP_CHOWN') return 'CHOWN';
    if (item === 'DAC_OVERRIDE' || item === 'CAP_DAC_OVERRIDE') return 'DAC_OVERRIDE';
    return null;
  });
  return equal(names.sort(), [...wanted].sort());
};

export function verifyOwnerContainerPolicy(item, expected, reject) {
  const { id, image, env, entrypoint, command, user, project, service, capAdd,
    pids, memory, nanoCpus, tmpfs, mounts, volumes, networks, none, terminal } = expected;
  if (item.Id !== id || !item.Config || !item.HostConfig || !item.NetworkSettings ||
      item.Image !== image || !/^sha256:[0-9a-f]{64}$/.test(item.Image) ||
      item.Config.User !== user || !equal(item.Config.Cmd, command) ||
      !equal(item.Config.Entrypoint, entrypoint) || !equal(item.Config.Env, env) ||
      item.Config.Labels?.['com.docker.compose.project'] !== project ||
      item.Config.Labels?.['com.docker.compose.service'] !== service ||
      item.HostConfig.Privileged !== false || item.HostConfig.ReadonlyRootfs !== true ||
      !equal(item.HostConfig.CapDrop?.map(x => x.toUpperCase()), ['ALL']) ||
      !exactCapAdd(item.HostConfig.CapAdd, capAdd) || item.HostConfig.PidsLimit !== pids ||
      item.HostConfig.Memory !== memory || item.HostConfig.NanoCpus !== nanoCpus ||
      item.HostConfig.RestartPolicy?.Name !== 'no' ||
      !equal(item.HostConfig.SecurityOpt, ['no-new-privileges:true']) ||
      (item.HostConfig.Devices ?? []).length !== 0 ||
      (item.HostConfig.GroupAdd ?? []).length !== 0 || item.HostConfig.PidMode !== '' ||
      item.HostConfig.IpcMode !== 'private' ||
      Object.keys(item.HostConfig.PortBindings ?? {}).length !== 0 ||
      Object.values(item.NetworkSettings.Ports ?? {}).some(value => value !== null)) reject('inspect-policy');
  if (!keys(item.HostConfig.Tmpfs, ['/tmp']) || item.HostConfig.Tmpfs['/tmp'] !== tmpfs)
    reject('inspect-tmpfs');
  const actualMounts = new Map();
  for (const mount of item.Mounts ?? []) {
    if (actualMounts.has(mount.Destination)) reject('inspect-mounts');
    actualMounts.set(mount.Destination, mount);
  }
  if (actualMounts.size !== mounts.length) reject('inspect-mounts');
  for (const mount of mounts) {
    const actual = actualMounts.get(mount.target);
    const source = mount.type === 'bind' ? mount.source : volumes[mount.source]?.name;
    if (!actual || actual.Type !== mount.type || actual.Destination !== mount.target ||
        (mount.type === 'bind' ? actual.Source !== source : actual.Name !== source) ||
        actual.RW !== !mount.read_only) reject('inspect-mounts');
  }
  const hostMounts = item.HostConfig.Mounts;
  if (!Array.isArray(hostMounts) || hostMounts.length !== mounts.length ||
      (item.HostConfig.Binds ?? []).length !== 0 ||
      (item.HostConfig.VolumesFrom ?? []).length !== 0) reject('inspect-host-mounts');
  const byTarget = new Map();
  for (const mount of hostMounts) {
    if (!mount || typeof mount.Target !== 'string' || byTarget.has(mount.Target)) reject('inspect-host-mounts');
    byTarget.set(mount.Target, mount);
  }
  for (const wanted of mounts) {
    const actual = byTarget.get(wanted.target);
    const source = wanted.type === 'bind' ? wanted.source : volumes[wanted.source]?.name;
    if (!actual || actual.Type !== wanted.type || actual.Source !== source ||
        actual.Target !== wanted.target ||
        (wanted.read_only ? actual.ReadOnly !== true :
          ![undefined, false].includes(actual.ReadOnly)) ||
        ![undefined, '', 'default'].includes(actual.Consistency) ||
        actual.TmpfsOptions != null || actual.ImageOptions != null ||
        actual.ClusterOptions != null) reject('inspect-host-mounts');
    if (wanted.type === 'bind') {
      const opts = actual.BindOptions;
      if (actual.VolumeOptions != null || opts != null &&
          (!keysSubset(opts, ['Propagation', 'NonRecursive', 'CreateMountpoint',
            'ReadOnlyNonRecursive', 'ReadOnlyForceRecursive']) ||
            ![undefined, '', 'rprivate'].includes(opts.Propagation) ||
            ![undefined, false].includes(opts.NonRecursive) ||
            ![undefined, false].includes(opts.CreateMountpoint) ||
            ![undefined, false].includes(opts.ReadOnlyNonRecursive) ||
            ![undefined, false].includes(opts.ReadOnlyForceRecursive))) reject('inspect-host-mounts');
    } else {
      const opts = actual.VolumeOptions;
      if (actual.BindOptions != null ||
          (wanted.volume?.nocopy === true ? opts == null || opts.NoCopy !== true :
            opts != null && ![undefined, false].includes(opts.NoCopy)) ||
          opts != null && (!keysSubset(opts, ['NoCopy', 'Labels', 'Subpath', 'DriverConfig']) ||
            opts.Labels != null && !keys(opts.Labels, []) ||
            ![undefined, ''].includes(opts.Subpath) || opts.DriverConfig != null))
        reject('inspect-host-mounts');
    }
  }
  const networkMap = item.NetworkSettings.Networks ?? {};
  const actualNetworks = Object.values(networkMap).map(network => network.NetworkID).sort();
  if (none) {
    if (item.HostConfig.NetworkMode !== 'none' ||
        !(keys(networkMap, []) && actualNetworks.length === 0 ||
          keys(networkMap, ['none']) && equal(actualNetworks, networks))) reject('inspect-network');
  } else if (!equal(actualNetworks, [...networks].sort())) reject('inspect-network');
  if (terminal && (item.State?.Status !== 'exited' || item.State?.ExitCode !== 0 ||
      !item.State?.StartedAt || !item.State?.FinishedAt ||
      item.State.StartedAt === '0001-01-01T00:00:00Z' ||
      item.State.FinishedAt === '0001-01-01T00:00:00Z' ||
      item.State.Running !== false || item.State.OOMKilled !== false ||
      item.State.Dead !== false || item.State.Error !== '' ||
      item.RestartCount !== 0)) reject('inspect-terminal');
}
