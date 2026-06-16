import { useEffect, useState } from 'react'
import {
  addWorkspace,
  listWorkspaces,
  readFile,
  reindex,
  search,
  type Hit,
  type Workspace,
} from './api/client'
import { C } from './theme'
import { FilesPanel } from './views/FilesPanel'
import { StatePanel } from './views/StatePanel'
import { GraphPanel } from './views/GraphPanel'
import { ChatPanel } from './views/ChatPanel'
import { GatesPanel } from './views/GatesPanel'
import { DashboardPanel } from './views/DashboardPanel'

// The agent conversation is the persistent centerpiece (center column). The right
// column is the stage: whichever workspace view you're looking at while you keep
// chatting. Switching the stage never interrupts the conversation.
type Stage = 'state' | 'graph' | 'files' | 'search' | 'gates' | 'dashboard'
const STAGES: Stage[] = ['state', 'graph', 'files', 'search', 'gates', 'dashboard']

function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/g)
  return (
    <span style={{ color: C.muted, fontSize: 13 }}>
      {parts.map((p, i) =>
        p.startsWith('[') && p.endsWith(']') ? (
          <mark key={i} style={{ background: 'transparent', color: C.accent, fontWeight: 600 }}>{p.slice(1, -1)}</mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  )
}

function SearchPanel({ wsid }: { wsid: string }) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [open, setOpen] = useState<{ path: string; content: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onSearch = async () => {
    if (!query.trim()) return
    setError(null)
    try { setHits((await search(query.trim(), wsid)).hits); setOpen(null) } catch (e) { setError(String(e)) }
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 16 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSearch()} placeholder="Search memory + docs…" style={{ flex: 1, padding: '.6rem .8rem', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8 }} />
        <button onClick={onSearch} style={{ padding: '.6rem 1rem', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, cursor: 'pointer' }}>Search</button>
        <button onClick={() => reindex(wsid)} title="Rebuild index" style={{ padding: '.6rem .8rem', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 8, cursor: 'pointer', color: C.muted }}>↻</button>
      </div>
      {error && <div style={{ color: C.err, marginTop: 10, fontSize: 13 }}>{error}</div>}
      <div style={{ marginTop: 16 }}>
        {hits.map((h, i) => (
          <div key={i} onClick={() => readFile(h.workspace, h.path).then(setOpen)} style={{ padding: '.7rem .8rem', marginBottom: 8, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, cursor: 'pointer' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: 14 }}>{h.title}</strong>
              {h.private && <span style={{ fontSize: 10, color: C.priv, border: `1px solid ${C.priv}`, borderRadius: 4, padding: '1px 5px' }}>PRIVATE</span>}
            </div>
            <div style={{ fontSize: 12, color: C.muted, margin: '2px 0 5px' }}>{h.path}</div>
            <Snippet text={h.snippet} />
          </div>
        ))}
        {query && hits.length === 0 && <div style={{ color: C.muted }}>no matches</div>}
        {open && (
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: '1rem', marginTop: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong style={{ fontSize: 13, color: C.muted }}>{open.path}</strong>
              <button onClick={() => setOpen(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: C.muted }}>✕</button>
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 10 }}>{open.content}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [active, setActive] = useState<string>('')
  const [addPath, setAddPath] = useState('')
  const [stage, setStage] = useState<Stage>('state')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = () =>
    listWorkspaces().then((ws) => { setWorkspaces(ws); setActive((a) => a || (ws.length ? ws[0].id : '')) }).catch((e) => setError(String(e)))

  useEffect(() => { refresh() }, [])

  const onAdd = async () => {
    if (!addPath.trim()) return
    setBusy(true); setError(null)
    try { const ws = await addWorkspace(addPath.trim()); setAddPath(''); setActive(ws.id); await refresh() }
    catch (e) { setError(String(e)) } finally { setBusy(false) }
  }

  const stageView = !active ? null
    : stage === 'state' ? <StatePanel key={active} wsid={active} />
      : stage === 'graph' ? <GraphPanel key={active} wsid={active} />
        : stage === 'files' ? <FilesPanel key={active} wsid={active} />
          : stage === 'search' ? <SearchPanel key={active} wsid={active} />
            : stage === 'gates' ? <GatesPanel key={active} wsid={active} />
              : <DashboardPanel workspaces={workspaces} />

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '236px minmax(440px, 1.1fr) minmax(400px, 1fr)', gridTemplateRows: 'minmax(0, 1fr)', height: '100vh', overflow: 'hidden' }}>
      {/* Workspaces */}
      <aside style={{ borderRight: `1px solid ${C.border}`, padding: '1rem', overflow: 'auto', background: C.panel }}>
        <h2 style={{ margin: '0 0 .9rem', fontSize: 18 }}>Vivary</h2>
        <div style={{ fontSize: 11, letterSpacing: '.13em', color: C.muted, marginBottom: 8 }}>WORKSPACES</div>
        {workspaces.map((w) => (
          <button key={w.id} onClick={() => setActive(w.id)} style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4, padding: '.55rem .65rem', borderRadius: 8, cursor: 'pointer', background: w.id === active ? C.raise : 'transparent', border: `1px solid ${w.id === active ? C.border : 'transparent'}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{w.name}</span>
              <span style={{ color: w.health.ok ? C.accent : C.warn }}>{w.health.ok ? '●' : '○'}</span>
            </div>
            <div style={{ fontSize: 11, color: C.muted }}>{w.health.graph?.nodes ?? 0} nodes</div>
          </button>
        ))}
        <div style={{ marginTop: 16 }}>
          <input value={addPath} onChange={(e) => setAddPath(e.target.value)} placeholder="workspace path…" onKeyDown={(e) => e.key === 'Enter' && onAdd()} style={{ width: '100%', padding: '.45rem', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7 }} />
          <button onClick={onAdd} disabled={busy} style={{ marginTop: 6, width: '100%', padding: '.45rem', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7, cursor: 'pointer' }}>{busy ? 'adding…' : '+ Add workspace'}</button>
        </div>
        {error && <div style={{ color: C.err, marginTop: 12, fontSize: 12 }}>{error}</div>}
      </aside>

      {/* Agent: the persistent centerpiece */}
      {active ? <ChatPanel key={active} wsid={active} /> : <div style={{ color: C.muted, padding: 24 }}>Add a workspace to begin.</div>}

      {/* Stage: the view you navigate while you keep chatting */}
      <aside style={{ borderLeft: `1px solid ${C.border}`, background: C.panel, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 2, padding: '8px 10px 0', borderBottom: `1px solid ${C.border}`, overflowX: 'auto' }}>
          {STAGES.map((s) => (
            <button key={s} onClick={() => setStage(s)} disabled={!active} style={{ padding: '.45rem .7rem 11px', background: 'transparent', border: 'none', borderBottom: `2px solid ${stage === s ? C.accent : 'transparent'}`, color: stage === s ? C.text : C.muted, cursor: 'pointer', textTransform: 'capitalize', fontSize: 13, whiteSpace: 'nowrap' }}>{s}</button>
          ))}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>{stageView}</div>
      </aside>
    </div>
  )
}

export default App
