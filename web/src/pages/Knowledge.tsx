import { useEffect,useState } from 'react';
import { api,ApiError,explain,type Session } from '../api.js';
import { ReadRecovery,useOptionalRead } from '../optional-read.js';
import type { KnowledgeEntry,KnowledgeSummary } from '../../../src/knowledge/types.js';
import { knowledgeLimits as limits } from '../../../src/knowledge/limits.js';
import { characters,validText } from '../../../src/knowledge/text.js';
interface Fields { title: string; body: string; enabled: boolean }
interface Editor { id: string | null; base: KnowledgeEntry | null; draft: Fields }
interface List { entries: KnowledgeSummary[]; totalBodyCharacters: number }
const fields = (e: Fields): Fields => ({ title: e.title,body: e.body,enabled: e.enabled });
const blank = (): Editor => ({ id: null,base: null,draft: { title: '',body: '',enabled: true } });
function restored(key: string): Editor | null {
  try {
    const e = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Editor | null;
    if (e && (e.id === null || typeof e.id === 'string') && typeof e.draft?.title === 'string' && typeof e.draft.body === 'string' && typeof e.draft.enabled === 'boolean' && (e.base === null || (e.base.id === e.id && Number.isSafeInteger(e.base.revision)))) return e;
  } catch { /* The storage effect reports unavailable storage; the editor still works in memory. */ }
  return null;
}
export function Knowledge({ guildId,session }: { guildId: string; session: Session }) {
  const path = `/api/guilds/${guildId}/knowledge`,key = `gn-draft:knowledge:${session.userId}:${guildId}`;
  const [editor,setEditor] = useState<Editor | null>(() => restored(key)),[status,setStatus] = useState(''),[error,setError] = useState(''),[storageError,setStorageError] = useState(''),[busy,setBusy] = useState(false),[loadingId,setLoadingId] = useState<string>(),[loadError,setLoadError] = useState(''),[latest,setLatest] = useState<KnowledgeEntry>(),[conflict,setConflict] = useState(false),[latestError,setLatestError] = useState(''),[latestLoading,setLatestLoading] = useState(false),[deleted,setDeleted] = useState(false);
  const list = useOptionalRead<List>(path,0);
  const dirty = !!editor && (editor.base ? JSON.stringify(fields(editor.base)) !== JSON.stringify(editor.draft) : !!editor.draft.title || !!editor.draft.body || !editor.draft.enabled);
  useEffect(() => {
    try { if (editor) sessionStorage.setItem(key,JSON.stringify(editor)); else sessionStorage.removeItem(key); setStorageError(''); }
    catch { setStorageError('Browser storage is unavailable. Your draft is kept in memory, but reloading or closing this tab may lose it.'); }
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload',warn); return () => window.removeEventListener('beforeunload',warn);
  },[editor,dirty,key]);
  function change(draft: Fields) { if (editor) setEditor({ ...editor,draft }); setStatus(''); }
  function canSwitch() { return !dirty || window.confirm('Discard your unsaved knowledge draft and switch entries?'); }
  function resetFeedback() { setError(''); setStatus(''); setLatest(undefined); setConflict(false); setLatestError(''); setDeleted(false); setLoadError(''); setLoadingId(undefined); }
  async function loadEntry(id: string) {
    setLoadingId(id); setLoadError(''); setBusy(true);
    try { const r = await api<{ entry: KnowledgeEntry }>(`${path}/${id}`); setEditor({ id,base: r.entry,draft: fields(r.entry) }); setLoadingId(undefined); setStatus('Entry loaded.'); }
    catch (e) { setLoadError(e instanceof ApiError && e.status === 404 ? 'This entry was deleted. Refresh the list to see current entries.' : explain(e)); }
    finally { setBusy(false); }
  }
  async function fetchLatest(id: string) {
    setLatestLoading(true); setLatestError(''); setLatest(undefined);
    try { setLatest((await api<{ entry: KnowledgeEntry }>(`${path}/${id}`)).entry); }
    catch (e) { if (e instanceof ApiError && e.status === 404) { setDeleted(true); setConflict(false); setError('This entry was deleted while you were editing. Your draft is safe. Save it as a new entry if you want to keep it.'); } else setLatestError(explain(e)); }
    finally { setLatestLoading(false); }
  }
  async function failed(e: unknown) {
    if (e instanceof ApiError && e.status === 409 && editor?.id) { setConflict(true); setError('Another staff member changed this entry. Your draft is safe. Review the latest version and choose how to continue.'); await fetchLatest(editor.id); }
    else if (e instanceof ApiError && e.status === 404 && editor?.id) { setDeleted(true); setError('This entry was deleted while you were editing. Your draft is safe. Save it as a new entry if you want to keep it.'); }
    else setError(e instanceof ApiError && e.code === 'knowledge_limit' ? 'The server knowledge limit was reached. Refresh the entries and reduce the text or number of entries. Your draft is kept.' : e instanceof ApiError && e.code === 'invalid_knowledge' ? 'Check the title and text limits. Both need nonblank, valid Unicode text without NUL characters. Your draft is kept.' : explain(e));
  }
  async function save(asNew = false) {
    if (!editor) return; setError(''); setStatus('');
    for (const [name,value,max,id] of [['Entry title',editor.draft.title,limits.titleCharacters,'knowledge-title'],['Knowledge text',editor.draft.body,limits.bodyCharacters,'knowledge-body']] as const) {
      if (!validText(value,max)) { setError(`${name} must contain nonblank, valid Unicode text without NUL characters, up to ${max.toLocaleString()} characters.`); document.getElementById(id)?.focus(); return; }
    }
    setBusy(true);
    try {
      const isNew = asNew || !editor.id;
      const r = await api<{ entry: KnowledgeEntry }>(isNew ? path : `${path}/${editor.id}`,isNew ? 'POST' : 'PATCH',isNew ? editor.draft : { revision: editor.base!.revision,patch: editor.draft });
      setEditor({ id: r.entry.id,base: r.entry,draft: fields(r.entry) }); resetFeedback(); setStatus('Entry saved. Your server knowledge is up to date.'); await list.reload();
    } catch (e) { await failed(e); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!editor?.id || !editor.base || !window.confirm('Delete this knowledge entry? This permanently removes its saved text.')) return;
    setBusy(true); setError(''); setStatus('');
    try { await api(`${path}/${editor.id}`,'DELETE',{ revision: editor.base.revision }); setEditor(null); resetFeedback(); setStatus('Entry deleted.'); await list.reload(); }
    catch (e) { await failed(e); }
    finally { setBusy(false); }
  }
  return <section className="page dashboard knowledge-page"><div className="page-heading"><div><a className="back" href={`/servers/${guildId}`}>← Server settings</a><p className="eyebrow">MISSION CONTROL / STAFF REFERENCES</p><h1>Server knowledge</h1><p className="small">Server {guildId}</p></div><span className="badge">Plain-text references</span></div>
    <div className="tip">Selected passages from enabled entries are sent to your AI provider when relevant to a conversation. Do not store secrets, passwords or private credentials here. The knowledge token budget is managed in <a className="text-link" href={`/servers/${guildId}#knowledge`}>server settings</a>.</div>
    {storageError && <p role="alert" className="error">{storageError}</p>}
    <div className="knowledge-layout"><aside className="panel knowledge-list" aria-label="Knowledge entries"><div className="section-title"><h2>Entries</h2><button type="button" className="primary" disabled={busy || latestLoading} onClick={() => { if (canSwitch()) { resetFeedback(); setEditor(blank()); } }}>New entry</button></div><ReadRecovery label="entries" read={list} />{list.value && <><p className="small">{list.value.entries.length} / {limits.entries} entries · {list.value.totalBodyCharacters.toLocaleString()} / {limits.totalBodyCharacters.toLocaleString()} total characters</p>{!list.value.entries.length && <p>No entries yet. Add a guide, FAQ or server reference.</p>}<ul>{list.value.entries.map(e => <li key={e.id}><button type="button" disabled={busy || latestLoading} aria-current={editor?.id === e.id ? 'true' : undefined} onClick={() => { if (editor?.id !== e.id && canSwitch()) { resetFeedback(); void loadEntry(e.id); } }}><span>{e.title}</span><small>{e.enabled ? 'Enabled' : 'Disabled'} · {e.bodyCharacters.toLocaleString()} characters · Revision {e.revision}</small></button></li>)}</ul></>}<button type="button" className="quiet" disabled={list.loading} onClick={() => { void list.reload(); }}>Refresh entries</button></aside>
    <div className="knowledge-editor">{loadError && <div className="panel"><p role="alert" className="error">{loadError}</p><button type="button" disabled={busy} onClick={() => { if (loadingId && canSwitch()) void loadEntry(loadingId); }}>Retry loading entry</button></div>}{busy && loadingId && <p>Loading entry… Your current draft is kept until loading succeeds.</p>}
      {editor ? <form noValidate onSubmit={e => { e.preventDefault(); if (!conflict && !deleted) void save(); }}><fieldset className="editor-fields" disabled={busy}><section className="panel section"><p className="eyebrow">{editor.id ? `ENTRY / REVISION ${editor.base?.revision}` : 'NEW REFERENCE'}</p><h2>{editor.id ? 'Edit entry' : 'New knowledge entry'}</h2><label htmlFor="knowledge-title">Entry title<input id="knowledge-title" value={editor.draft.title} onChange={e => change({ ...editor.draft,title: e.target.value })} aria-describedby="title-count" /></label><p id="title-count" className="small">{characters(editor.draft.title).toLocaleString()} / {limits.titleCharacters.toLocaleString()} characters</p><label htmlFor="knowledge-body">Knowledge text</label><textarea id="knowledge-body" rows={18} value={editor.draft.body} onChange={e => change({ ...editor.draft,body: e.target.value })} aria-describedby="body-count" placeholder="Paste your plain-text server guide here…" /><p id="body-count" className="small">{characters(editor.draft.body).toLocaleString()} / {limits.bodyCharacters.toLocaleString()} characters</p><label className="check"><input type="checkbox" checked={editor.draft.enabled} onChange={e => change({ ...editor.draft,enabled: e.target.checked })} />Use this entry in AI responses</label><p className="small">Changes to the text or enabled switch take effect when you save.</p></section>
      {conflict && <section className="panel section conflict"><h2>Review the newer entry</h2>{latestLoading && <p>Loading latest entry…</p>}{latestError && <><p role="alert" className="error">{latestError}</p><button type="button" onClick={() => { if (editor.id) void fetchLatest(editor.id); }}>Retry loading latest entry</button></>}{latest && <><p><b>{latest.title}</b> · Revision {latest.revision} · {latest.enabled ? 'Enabled' : 'Disabled'}</p><details open><summary>Latest saved text</summary><pre>{latest.body}</pre></details><div className="actions"><button type="button" onClick={() => { setEditor({ ...editor,base: latest }); setLatest(undefined); setConflict(false); setError(''); setStatus('Your draft is on the latest revision. Review it, then Save entry.'); }}>Keep my draft on latest revision</button><button type="button" onClick={() => { setEditor({ id: latest.id,base: latest,draft: fields(latest) }); resetFeedback(); setStatus('Latest entry loaded; your draft was discarded.'); }}>Load latest and discard my draft</button></div></>}</section>}
      <div className="save-bar"><div>{error && <p role="alert" className="error">{error}</p>}<p role="status">{status || (dirty ? (storageError ? 'Unsaved draft · kept in memory only' : 'Unsaved draft · kept in this tab') : 'No unsaved edits')}</p></div><div className="save-actions">{deleted ? <button type="button" className="primary" onClick={() => { void save(true); }}>Save as new entry</button> : <><button type="button" className="quiet" disabled={!dirty} onClick={() => { if (window.confirm('Discard your unsaved knowledge edits?')) { setEditor(editor.base ? { ...editor,draft: fields(editor.base) } : blank()); resetFeedback(); setStatus('Draft discarded.'); } }}>Discard edits</button><button type="submit" className="primary" disabled={conflict}>{busy ? 'Saving…' : 'Save entry'}</button></>}</div></div>{editor.id && !deleted && <div className="actions"><button type="button" className="danger quiet" disabled={conflict} onClick={() => { void remove(); }}>Delete entry</button></div>}</fieldset></form> : <section className="panel"><h2>Knowledge for your conversations</h2><p>Select an entry to edit its text, or create a new reference.</p>{error && <p role="alert" className="error">{error}</p>}<p role="status">{status}</p></section>}
    </div></div></section>;
}
