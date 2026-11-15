export const HELP = 'Mention me, reply to one of my messages, or use /ask for a public answer in a server text channel. Staff can use /settings and /status privately. Recent messages, participant names/IDs, selected staff knowledge passages and server instructions are sent to the configured OpenAI or Google provider. Providers may retain data under their own policies; do not share secrets.';
export const COMMANDS = [
  { name: 'help',description: 'Usage and provider privacy information',type: 1 },
  { name: 'ask',description: 'Ask using recent messages in this channel',type: 1,options: [{ type: 3,name: 'prompt',description: 'Your request',required: true,max_length: 6000 }] },
  { name: 'settings',description: 'Authorized staff: private server dashboard link',type: 1 },
  { name: 'status',description: 'Authorized staff: private usage and provider status',type: 1 },
] as const;
export type { UsageStatus } from '../usage/status.js';
