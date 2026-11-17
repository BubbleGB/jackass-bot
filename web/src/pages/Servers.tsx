import { useEffect,useState } from 'react';
import { api,explain } from '../api.js';

interface Server { id: string; name: string; level: string }
export function Servers() {
  const [servers,setServers] = useState<Server[]>([]),[next,setNext] = useState<string | null>(null),[error,setError] = useState(''),[loading,setLoading] = useState(true),[query,setQuery] = useState(''),[failedAfter,setFailedAfter] = useState('');
  async function load(after = '') {
    setLoading(true); setError('');
    try {
      const r = await api<{ servers: Server[]; next: string | null }>(`/api/servers${after ? `?after=${after}` : ''}`);
      setServers(current => [...new Map((after ? [...current,...r.servers] : r.servers).map(s => [s.id,s])).values()]);
      setNext(r.next);
    } catch (e) { setError(explain(e)); setFailedAfter(after); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); },[]);
  const search = query.trim().toLocaleLowerCase(),visible = servers.filter(s => s.name.toLocaleLowerCase().includes(search) || s.id.includes(search));
  return <section className="page server-page">
    <div className="page-heading"><div><p className="eyebrow">MISSION CONTROL</p><h1>Choose your galaxy.</h1><p className="lead">Your servers. Your voice. One place to keep it all in orbit.</p></div><span className="badge">Access checked with Discord</span></div>
    <div className="list-toolbar"><label className="search-field" htmlFor="server-search">Search loaded servers<input id="server-search" type="search" placeholder="Server name or ID" value={query} onChange={e => setQuery(e.target.value)} aria-describedby="server-search-hint" /></label><p id="server-search-hint" className="small">{servers.length} {servers.length === 1 ? 'server' : 'servers'} loaded{next ? ' · Check more servers to search the next page.' : ''}</p></div>
    {error && <div className="recovery"><p role="alert" className="error">{error}</p><button type="button" disabled={loading} onClick={() => { void load(failedAfter); }}>Retry loading servers</button></div>}
    <div className="server-grid" aria-busy={loading}>{visible.map(s => <a className="server-card panel" href={`/servers/${s.id}`} key={s.id}><span className="server-icon" aria-hidden="true">{Array.from(s.name)[0]}</span><div className="server-card-copy"><span className="card-kicker">SERVER DASHBOARD</span><h2>{s.name}</h2><p>{s.level === 'delegate' ? 'Delegated access' : 'Full control'}</p><small>{s.id}</small></div><span className="card-arrow" aria-hidden="true">→</span></a>)}</div>
    {loading && <p className="loading-inline" role="status">Checking current Discord access…</p>}
    {!loading && !error && !servers.length && <div className="panel empty-state"><span className="empty-icon" aria-hidden="true">✦</span><h2>No approved servers available yet.</h2><p>Check that the bot is installed, your server is approved, and your current role has access. Owners contact the creator for approval.</p><a className="button secondary" href="/#privacy">Approval and contact information</a><button type="button" className="quiet" onClick={() => { void load(); }}>Check access again</button></div>}
    {!!servers.length && !visible.length && <div className="panel empty-state"><h2>No matching servers.</h2><p>Try another name or ID{next ? ', or check more servers below' : ''}.</p><button type="button" onClick={() => setQuery('')}>Clear search</button></div>}
    {next && !error && <button type="button" disabled={loading} onClick={() => { void load(next); }}>{loading ? 'Checking servers…' : 'Check more servers'}</button>}
    <aside className="tip">Only approved servers you can currently manage appear here. A removed role or server membership takes effect on your next protected action.</aside>
  </section>;
}
