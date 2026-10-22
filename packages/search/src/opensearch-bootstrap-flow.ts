import { SearchEngineError } from './opensearch-runtime.js';
import { claimBootstrapIntroduction, completeBootstrapIntroduction, readBootstrapState,
  type BootstrapOwners } from './opensearch-bootstrap-state.js';

export type ProfileAccess = {
  verifySecurity(): Promise<void>;
  profile(): Promise<string>;
  createProfileStrict(): Promise<string>;
};
const invalid = (): never => { throw new Error('private search introduction state'); };

export async function verifyRetainedProfile(directory: string, access: ProfileAccess,
  owners?: BootstrapOwners): Promise<void> {
  const state = await readBootstrapState(directory, owners);
  if (state.phase !== 'ready' || state.kind === 'unintroduced' || state.kind === 'incomplete') invalid();
  await access.verifySecurity();
  const observed = await access.profile();
  if (state.kind === 'complete' && observed !== state.indexUuid) invalid();
}

export async function introduceProfile(directory: string, access: ProfileAccess,
  owners?: BootstrapOwners): Promise<void> {
  const state = await readBootstrapState(directory, owners);
  if (state.phase !== 'ready' || state.kind !== 'unintroduced') invalid();
  await access.verifySecurity();
  try { await access.profile(); }
  catch (error) {
    if (!(error instanceof SearchEngineError) || error.kind !== 'status' || error.statusCode !== 404) throw error;
    await claimBootstrapIntroduction(directory, owners);
    const observedUuid = await access.createProfileStrict();
    await completeBootstrapIntroduction(directory, observedUuid, owners);
    return;
  }
  invalid();
}
