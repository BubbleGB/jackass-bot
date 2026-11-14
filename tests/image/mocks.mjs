import http from 'node:http';
import { guild,channel,user,bot } from './constants.mjs';
const state = { logins: 0,generations: 0,counts: 0,deliveries: 0,safeMentions: true },messages = new Map(),events = [],logins = [],generations = [];
let ready = false,hold = false;
const json = (r,b) => { if (!r.destroyed) { r.writeHead(200,{ 'content-type': 'application/json' }); r.end(JSON.stringify(b)); } };
const generated = () => ({ status: 'completed',usage: { input_tokens: 20,output_tokens: 10,total_tokens: 30 },output: [{ type: 'message',content: [{ type: 'output_text',text: JSON.stringify({ kind: 'answer',text: 'Image smoke answer' }) }] }] });
const server = http.createServer(async (req,res) => {
  const u = new URL(req.url,'http://mocks'); let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 2000000) { res.destroy(); return; } }
  if (u.pathname === '/control/results') return json(res,state);
  if (u.pathname === '/control/ready') { ready = true; for (const r of logins.splice(0)) json(r,{}); return json(res,{}); }
  if (u.pathname === '/control/hold') { hold = true; return json(res,{}); }
  if (u.pathname === '/control/release') { hold = false; for (const r of generations.splice(0)) json(r,generated()); return json(res,{}); }
  if (u.pathname === '/control/send') {
    const b = JSON.parse(body),author = b.user ?? user; messages.set(b.id,author);
    events.push({ id: b.id,guildId: guild,channelId: channel,channel: { type: 0 },author: { id: author,bot: false },webhookId: null }); return json(res,{});
  }
  if (u.pathname === '/gateway/login') { state.logins++; if (ready) return json(res,{}); logins.push(res); return; }
  if (u.pathname === '/gateway/poll') return json(res,events.splice(0));
  if (u.pathname === '/discord/users/@me') return json(res,{ id: bot,bot: true });
  if (u.pathname === '/discord/users/@me/guilds') return json(res,u.searchParams.has('after') ? [] : [{ id: guild }]);
  if (u.pathname === `/discord/guilds/${guild}`) return json(res,{ id: guild,owner_id: user,name: 'Image smoke guild' });
  if (u.pathname === `/discord/guilds/${guild}/roles`) return json(res,[{ id: guild,permissions: '68608' }]);
  if (u.pathname.startsWith(`/discord/guilds/${guild}/members/`)) { const id = u.pathname.split('/').at(-1); return json(res,{ user: { id,bot: id === bot },roles: [] }); }
  if (u.pathname === `/discord/channels/${channel}`) return json(res,{ id: channel,guild_id: guild,type: 0,permission_overwrites: [] });
  if (u.pathname === `/discord/channels/${channel}/typing`) return json(res,{});
  if (u.pathname === `/discord/channels/${channel}/messages` && req.method === 'POST') {
    const b = JSON.parse(body),m = b.allowed_mentions; state.deliveries++; state.safeMentions &&= !!m && m.parse.length === 0 && m.roles.length === 0 && m.users.length <= 3 && m.replied_user === false;
    return json(res,{ id: String(900000000000000000n+BigInt(state.deliveries)) });
  }
  if (u.pathname === `/discord/channels/${channel}/messages`) return json(res,[]);
  if (u.pathname.startsWith(`/discord/channels/${channel}/messages/`)) { const id = u.pathname.split('/').at(-1); return json(res,{ id,channel_id: channel,guild_id: guild,author: { id: messages.get(id) ?? user,bot: false },content: 'Synthetic image conversation',timestamp: new Date(Date.now()-1000).toISOString(),type: 0,mentions: [{ id: bot }] }); }
  if (u.pathname === '/openai/v1/responses/input_tokens') { state.counts++; return json(res,{ input_tokens: 120 }); }
  if (u.pathname === '/openai/v1/responses') { state.generations++; if (hold) { generations.push(res); return; } return json(res,generated()); }
  res.writeHead(404); res.end('{}');
});
server.listen(9000,'0.0.0.0');
process.once('SIGTERM',() => { for (const r of [...logins,...generations]) r.destroy(); server.close(); });
