import { readFile } from 'node:fs/promises';
const names = ['DATABASE_URL','ENCRYPTION_KEY','DISCORD_BOT_TOKEN','DISCORD_CLIENT_SECRET'] as const;
/** Only explicit secret names; never include path, content or raw filesystem errors. */
export async function resolveSecrets(env: NodeJS.ProcessEnv,read: (path: string) => Promise<string> = path => readFile(path,'utf8')): Promise<NodeJS.ProcessEnv> {
  const result = { ...env };
  for (const name of names) if (env[`${name}_FILE`] !== undefined) {
    try {
      if (env[name] !== undefined || !env[`${name}_FILE`]) throw new Error();
      const value = await read(env[`${name}_FILE`]!);
      if (!value || Buffer.byteLength(value) > 8192) throw new Error(); result[name] = value.replace(/[\r\n]+$/,'');
    } catch { throw new Error(`Invalid secret configuration: ${name}`); }
  }
  return result;
}
