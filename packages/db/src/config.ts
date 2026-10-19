import { z } from 'zod';
import { isIP } from 'node:net';

const base64Key = z.string().refine((value) => {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  return Buffer.from(value, 'base64').length === 32;
}, 'STATION_MASTER_KEY must be 32 random bytes encoded as base64');

const port = z.coerce.number().int().min(1).max(65535);
const runtimeSchema = z.object({
  POSTGRES_PASSWORD: z.string().min(16).refine((value) => !/[\r\n\0]/.test(value)),
  STATION_MASTER_KEY: base64Key,
  APP_PORT: port.default(8080),
  APP_HOST: z.string().default('127.0.0.1'),
  APP_ORIGIN: z.string().url(),
  APP_TLS_KEY_PATH: z.string().default(''),
  APP_TLS_CERT_PATH: z.string().default(''),
  APP_TRUSTED_PROXY_IP: z.string().refine((value) => !value || isIP(value) > 0, 'APP_TRUSTED_PROXY_IP must be one IP address').default(''),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: port.default(5432),
  DB_NAME: z.string().default('station'),
  DB_USER: z.string().default('station'),
});

export type RuntimeConfig = z.infer<typeof runtimeSchema>;

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const result = runtimeSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid runtime configuration: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }
  return result.data;
}

export function databaseUrl(config: RuntimeConfig): string {
  const url = new URL('postgresql://station/');
  url.username = config.DB_USER;
  url.password = config.POSTGRES_PASSWORD;
  url.hostname = config.DB_HOST;
  url.port = String(config.DB_PORT);
  url.pathname = `/${config.DB_NAME}`;
  return url.toString();
}
