import type { Client } from '@opensearch-project/opensearch';
import { boundedSearchSdkRequest, SearchEngineError } from './opensearch-runtime.js';
import { createV2IndexBody, verifyV2IndexProfile } from './opensearch-v2-profile.js';

type Options = NonNullable<Parameters<Client['info']>[1]>;
type Abortable = Promise<unknown> & { abort(): void };
type IndexSdk = Pick<Client['indices'], 'create' | 'get'>;

/** Fixed SDK adapter, with no production caller or credential acquisition. */
export async function createLiteralV2IndexOnce(indices: IndexSdk, index: string): Promise<{ uuid: string }> {
  const body = createV2IndexBody(index);
  const response = await boundedSearchSdkRequest<unknown>(options =>
    indices.create({ index, body }, options as Options) as unknown as Abortable, 32_768, 5_000);
  if (!response || typeof response !== 'object' || Array.isArray(response) ||
      Object.getPrototypeOf(response) !== Object.prototype) throw new SearchEngineError('response');
  const result = response as Record<string, unknown>;
  if (result.acknowledged !== true || result.shards_acknowledged !== true || result.index !== index)
    throw new SearchEngineError('partial');
  const readback = await boundedSearchSdkRequest<unknown>(options =>
    indices.get({ index }, options as Options) as unknown as Abortable, 128_000, 5_000);
  return { uuid: verifyV2IndexProfile(readback, index, null) };
}
