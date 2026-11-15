import { useCallback,useEffect,useRef,useState } from 'react';
import { api,explain } from './api.js';
export function useOptionalRead<T>(path: string,revision: number) {
  const [value,setValue] = useState<T>(),[error,setError] = useState(''),[loading,setLoading] = useState(true),generation = useRef(0);
  const reload = useCallback(async () => {
    const current = ++generation.current; setLoading(true); setError(''); setValue(undefined);
    try { const next = await api<T>(path); if (current === generation.current) setValue(next); return true; }
    catch (e) { if (current === generation.current) setError(explain(e)); return false; }
    finally { if (current === generation.current) setLoading(false); }
  },[path]);
  useEffect(() => { void reload(); return () => { generation.current++; }; },[reload,revision]);
  return { value,error,loading,reload };
}
export function ReadRecovery({ label,read }: { label: string; read: { loading: boolean; error: string; reload: () => Promise<boolean> } }) {
  return <div aria-live="polite">{read.loading && <p>Loading current {label}…</p>}{read.error && <><p role="alert" className="error">{read.error}</p><button type="button" onClick={() => { void read.reload(); }}>Retry loading {label}</button></>}</div>;
}
