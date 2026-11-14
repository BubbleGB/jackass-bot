// Mounted test fixture only. Not copied into the image, not loaded by its normal CMD.
import { createRequire } from 'node:module';
import { bot } from './constants.mjs';
const require = createRequire('/app/package.json'),{ Client,Events } = require('discord.js');
const originalFetch = globalThis.fetch,mock = process.env.GALAXY_MOCK_URL;
if (!mock?.startsWith('http://mocks:')) throw new Error('test_mock_configuration');
globalThis.fetch = (input,init) => {
  const u = new URL(String(input));
  const prefix = u.hostname === 'discord.com' ? '/discord'+u.pathname.replace(/^\/api\/v10/,'') : u.hostname === 'api.openai.com' ? '/openai'+u.pathname : u.hostname === 'generativelanguage.googleapis.com' ? '/google'+u.pathname : null;
  if (!prefix) throw new Error('external_request_blocked_in_image_test');
  return originalFetch(mock+prefix+u.search,init);
};
const destroy = Client.prototype.destroy;
Client.prototype.isReady = function () { return this.__imageReady === true; };
Client.prototype.login = async function () {
  this.__imageAbort = new AbortController();
  const response = await originalFetch(mock+'/gateway/login',{ signal: this.__imageAbort.signal }); if (!response.ok) throw new Error('mock_login');
  this.user = { id: bot,bot: true }; this.__imageReady = true; this.emit(Events.ClientReady,this);
  let polling = false;
  this.__imagePoll = setInterval(async () => {
    if (polling) return; polling = true;
    try { const r = await originalFetch(mock+'/gateway/poll',{ signal: this.__imageAbort.signal }); for (const e of await r.json()) this.emit(Events.MessageCreate,e); } catch { /* Test shutdown abort. */ } finally { polling = false; }
  },30); this.__imagePoll.unref(); return 'synthetic-token';
};
Client.prototype.destroy = async function () {
  this.__imageReady = false; clearInterval(this.__imagePoll); this.__imageAbort?.abort(); await destroy.call(this);
};
