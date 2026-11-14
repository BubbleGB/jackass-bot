import { isSnowflake } from '../access/policy.js';
import { COMMANDS } from './commands.js';
import type { DiscordTransport } from './transport.js';
export interface Registration { applicationId: string; scope: { kind: 'guild'; guildId: string } | { kind: 'global'; production: true } }
export async function registerCommands(config: Registration,transport: DiscordTransport): Promise<void> {
  if (!isSnowflake(config.applicationId) || (config.scope.kind === 'guild' ? !isSnowflake(config.scope.guildId) : config.scope.kind !== 'global' || config.scope.production !== true)) throw new Error('registration_configuration');
  const path = config.scope.kind === 'guild' ? `/applications/${config.applicationId}/guilds/${config.scope.guildId}/commands` : `/applications/${config.applicationId}/commands`;
  const body = COMMANDS.map(c => config.scope.kind === 'global' ? { ...c,contexts: [0],integration_types: [0] } : { ...c });
  await transport.call({ method: 'PUT',path,body,signal: AbortSignal.timeout(10000) });
}
export function readRegistrationConfig(env: NodeJS.ProcessEnv,args: readonly string[]): Registration & { token: string } {
  const test = args.length === 1 && args[0] === '--guild',production = args.length === 2 && args.includes('--global') && args.includes('--production');
  if ((!test && !production) || !isSnowflake(env.DISCORD_CLIENT_ID) || !env.DISCORD_BOT_TOKEN?.trim() || (test && !isSnowflake(env.DISCORD_TEST_GUILD_ID))) throw new Error('registration_configuration');
  return { applicationId: env.DISCORD_CLIENT_ID,token: env.DISCORD_BOT_TOKEN,scope: test ? { kind: 'guild',guildId: env.DISCORD_TEST_GUILD_ID! } : { kind: 'global',production: true } };
}
