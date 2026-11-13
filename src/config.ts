export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  mode: 'foundation' | 'runtime';
  port: number;
  publicOrigin: string;
  databaseUrl: string | undefined;
  encryptionKey: Buffer | undefined;
  encryptionKeyVersion: number;
  discordBotToken: string | undefined;
  discordClientId: string | undefined;
  discordClientSecret: string | undefined;
  creatorUserId: string | undefined;
}

/** Errors contain field names only: never serialize environment values or URL errors. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const invalid = new Set<string>();
  const nodeEnv = env.NODE_ENV ?? 'development';
  const mode = env.APP_MODE ?? 'foundation';
  if (!['development', 'test', 'production'].includes(nodeEnv)) invalid.add('NODE_ENV');
  if (!['foundation', 'runtime'].includes(mode)) invalid.add('APP_MODE');
  const integer = (name: string, fallback: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) invalid.add(name);
    return value;
  };
  const port = integer('PORT', 3000, 65535);
  const encryptionKeyVersion = integer('ENCRYPTION_KEY_VERSION', 1, 2147483647);
  const publicOrigin = env.PUBLIC_ORIGIN ?? 'http://localhost:3000';
  try {
    const url = new URL(publicOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || (nodeEnv === 'production' && url.protocol !== 'https:')) invalid.add('PUBLIC_ORIGIN');
  } catch { invalid.add('PUBLIC_ORIGIN'); }
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl !== undefined) {
    try {
      const url = new URL(databaseUrl);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) invalid.add('DATABASE_URL');
    } catch { invalid.add('DATABASE_URL'); }
  }
  let encryptionKey: Buffer | undefined;
  if (env.ENCRYPTION_KEY !== undefined) {
    encryptionKey = Buffer.from(env.ENCRYPTION_KEY, 'base64');
    if (encryptionKey.length !== 32 || encryptionKey.toString('base64') !== env.ENCRYPTION_KEY) invalid.add('ENCRYPTION_KEY');
  }
  for (const name of ['DISCORD_CLIENT_ID', 'CREATOR_USER_ID'] as const) {
    if (env[name] !== undefined && !/^\d{17,20}$/.test(env[name])) invalid.add(name);
  }
  if (mode === 'runtime') {
    for (const name of ['PUBLIC_ORIGIN', 'DATABASE_URL', 'ENCRYPTION_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'CREATOR_USER_ID'] as const) {
      if (!env[name]?.trim()) invalid.add(name);
    }
  }
  if (invalid.size) throw new Error(`Invalid configuration fields: ${[...invalid].sort().join(', ')}`);
  return {
    nodeEnv: nodeEnv as AppConfig['nodeEnv'], mode: mode as AppConfig['mode'], port,
    publicOrigin: new URL(publicOrigin).origin, databaseUrl, encryptionKey, encryptionKeyVersion,
    discordBotToken: env.DISCORD_BOT_TOKEN, discordClientId: env.DISCORD_CLIENT_ID,
    discordClientSecret: env.DISCORD_CLIENT_SECRET, creatorUserId: env.CREATOR_USER_ID,
  };
}
