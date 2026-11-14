import { readRegistrationConfig,registerCommands } from './register.js';
import { DiscordRest } from './transport.js';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') console.log('Explicit registration only: --guild uses DISCORD_TEST_GUILD_ID; --global --production replaces global application commands. Both require DISCORD_CLIENT_ID and DISCORD_BOT_TOKEN.');
else {
  try { const config = readRegistrationConfig(process.env,args); await registerCommands(config,new DiscordRest(config.token)); console.log('Discord application commands registered.'); }
  catch { console.error('Discord registration failed. Check registration scope, identifiers, credentials and permissions.'); process.exitCode = 1; }
}
