import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { guild,channel,user } from './constants.mjs';
import { CredentialCipher } from '/app/dist/settings/credentials.js';
const require = createRequire('/app/package.json'),{ Pool } = require('pg'),url = (await readFile(process.env.DATABASE_URL_FILE,'utf8')).trim(),key = Buffer.from((await readFile(process.env.ENCRYPTION_KEY_FILE,'utf8')).trim(),'base64');
const pool = new Pool({ connectionString: url }),cipher = new CredentialCipher(1,new Map([[1,key]])),e = cipher.seal(guild,'openai','fake-image-provider-key');
try {
  await pool.query('INSERT INTO guild_settings(guild_id,enabled,direct_enabled,instructions) VALUES($1,true,true,$2)',[guild,'Image smoke personality']);
  await pool.query('INSERT INTO approved_guilds(guild_id,approved_by) VALUES($1,$2)',[guild,user]);
  await pool.query('INSERT INTO auto_channels(guild_id,channel_id) VALUES($1,$2)',[guild,channel]);
  await pool.query("INSERT INTO provider_configs(guild_id,provider,ciphertext,nonce,key_version,model_id,priority,daily_allowance) VALUES($1,'openai',$2,$3,1,'gpt-5.4-mini-2026-03-17',1,50000)",[guild,e.ciphertext,e.nonce]);
} finally { await pool.end(); }
