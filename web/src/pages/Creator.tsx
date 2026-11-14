import { useEffect,useState } from 'react';
import { api,explain } from '../api.js';
export function Creator({ creator }: { creator: boolean }) {
  const [ids,setIds] = useState<string[]>([]),[id,setId] = useState(''),[error,setError] = useState(''),[status,setStatus] = useState('');
  async function load() { try { setIds((await api<{ guildIds: string[] }>('/api/creator/approvals')).guildIds); } catch (e) { setError(explain(e)); } }
  useEffect(() => { if (creator) void load(); },[creator]);
  async function change(guild: string,approved: boolean) { setError(''); try { if (!/^\d{17,20}$/.test(guild)) { setError('Enter a valid server ID.'); return; } await api(`/api/creator/approvals/${guild}`,'PUT',{ approved }); setStatus(approved ? 'Server approved. Its owner can configure it after installation.' : 'Approval revoked; server disabled and saved keys removed.'); await load(); } catch (e) { setError(explain(e)); } }
  if (!creator) return <p role="alert">Creator access is required.</p>;
  return <section className="page narrow"><p className="eyebrow">CREATOR CONTROL</p><h1>Server approvals</h1><p>Approval allows configuration; it does not enable AI or grant access to server settings. Owners contact you directly.</p>{error && <p role="alert" className="error">{error}</p>}<p role="status">{status}</p><form className="panel" onSubmit={e => { e.preventDefault(); void change(id,true); }}><label>Server ID<input inputMode="numeric" value={id} onChange={e => setId(e.target.value)} /></label><button className="primary">Approve server</button></form><ul className="approval-list">{ids.map(g => <li className="panel" key={g}><code>{g}</code><button className="danger" onClick={() => { if (confirm('Revoke approval? This disables the server and removes its saved provider keys.')) void change(g,false); }}>Revoke approval</button></li>)}</ul></section>;
}
