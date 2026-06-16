import { useEffect, useState } from 'react'
import { getTree, readFile, type TreeNode } from '../api/client'
import { C } from '../theme'

function Node({
  node,
  depth,
  onOpen,
}: {
  node: TreeNode
  depth: number
  onOpen: (path: string) => void
}) {
  const [open, setOpen] = useState(depth < 1)
  const pad = { paddingLeft: 8 + depth * 12 }
  if (node.type === 'dir') {
    return (
      <div>
        <div
          onClick={() => setOpen((o) => !o)}
          style={{ ...pad, cursor: 'pointer', padding: '2px 0', color: C.muted }}
        >
          {open ? '▾' : '▸'} {node.name}
        </div>
        {open && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} onOpen={onOpen} />)}
      </div>
    )
  }
  return (
    <div
      onClick={() => onOpen(node.path)}
      style={{ ...pad, cursor: 'pointer', padding: '2px 0', display: 'flex', gap: 6 }}
    >
      <span>{node.name}</span>
      {node.private && <span style={{ fontSize: 9, color: C.priv, border: `1px solid ${C.priv}`, borderRadius: 3, padding: '0 4px' }}>PRIV</span>}
    </div>
  )
}

export function FilesPanel({ wsid }: { wsid: string }) {
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [file, setFile] = useState<{ path: string; content: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setFile(null)
    getTree(wsid).then(setTree).catch((e) => setError(String(e)))
  }, [wsid])

  const open = (path: string) => readFile(wsid, path).then(setFile).catch((e) => setError(String(e)))

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12, height: '100%' }}>
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, overflow: 'auto', fontSize: 13 }}>
        {error && <div style={{ color: C.err }}>{error}</div>}
        {tree?.children?.map((c) => <Node key={c.path} node={c} depth={0} onOpen={open} />)}
      </div>
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14, overflow: 'auto' }}>
        {file ? (
          <>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>{file.path}</div>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>{file.content}</pre>
          </>
        ) : (
          <span style={{ color: C.muted }}>select a file</span>
        )}
      </div>
    </div>
  )
}
