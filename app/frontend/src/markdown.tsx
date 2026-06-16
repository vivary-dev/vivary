// A small, dependency-free Markdown renderer for the chat prose. It parses to React
// elements (never dangerouslySetInnerHTML, so there is no HTML-injection surface) and is
// scoped to the subset agents actually emit: headings, paragraphs, fenced/inline code,
// lists, blockquotes, rules, bold, and links.
//
// Two deliberate choices for this workspace:
//   * A leading YAML frontmatter block (--- ... ---) is stripped, not shown. The chat is a
//     conversation, not a file viewer — nobody wants the `name:`/`description:` header.
//   * `_`/`__` are NOT emphasis. This codebase is full of snake_case and __init__-style
//     identifiers; only `*`/`**` mark italic/bold so those names render intact.
import type { ReactNode } from 'react'
import { C, FONT_MONO, FONT_SERIF } from './theme'

// Drop a YAML frontmatter block when it leads the text. Convention: the very first line
// is `---`, closed by a later `---` on its own line.
function stripFrontmatter(src: string): string {
  return src.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
}

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'code'; code: string }
  | { t: 'list'; ordered: boolean; items: string[] }
  | { t: 'quote'; lines: string[] }
  | { t: 'hr' }

const ul = (s: string) => /^\s*[-*+]\s+(.*)$/.exec(s)
const ol = (s: string) => /^\s*\d+[.)]\s+(.*)$/.exec(s)

function isBlockStart(line: string): boolean {
  return (
    /^#{1,6}\s/.test(line) ||
    /^\s*(?:```+|~~~+)/.test(line) ||
    /^\s*>/.test(line) ||
    !!ul(line) ||
    !!ol(line) ||
    /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
  )
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    const fence = /^\s*(```+|~~~+)/.exec(line)
    if (fence) {
      const marker = fence[1][0] === '`' ? '`{3,}' : '~{3,}'
      const close = new RegExp(`^\\s*${marker}\\s*$`)
      i++
      const code: string[] = []
      while (i < lines.length && !close.test(lines[i])) { code.push(lines[i]); i++ }
      i++ // consume the closing fence (no-op if EOF)
      blocks.push({ t: 'code', code: code.join('\n') })
      continue
    }

    if (!line.trim()) { i++; continue }

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { blocks.push({ t: 'h', level: h[1].length, text: h[2].trim() }); i++; continue }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ t: 'hr' }); i++; continue }

    if (/^\s*>/.test(line)) {
      const ql: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) { ql.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      blocks.push({ t: 'quote', lines: ql })
      continue
    }

    if (ul(line) || ol(line)) {
      const ordered = !!ol(line)
      const items: string[] = []
      for (let m: RegExpExecArray | null; i < lines.length && (m = ordered ? ol(lines[i]) : ul(lines[i])); i++) {
        items.push(m[1])
      }
      blocks.push({ t: 'list', ordered, items })
      continue
    }

    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { para.push(lines[i].trim()); i++ }
    blocks.push({ t: 'p', text: para.join(' ') })
  }
  return blocks
}

const sCode: React.CSSProperties = { fontFamily: FONT_MONO, fontSize: '0.86em', background: C.raise, border: `1px solid ${C.border}`, borderRadius: 5, padding: '1px 5px' }
const sPre: React.CSSProperties = { fontFamily: FONT_MONO, fontSize: 12.5, lineHeight: 1.55, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 9, padding: '11px 13px', overflowX: 'auto', margin: 0, color: C.read, whiteSpace: 'pre' }
const sStrong: React.CSSProperties = { color: C.accent, fontWeight: 650 }
const sLink: React.CSSProperties = { color: C.blue, textDecoration: 'underline', textUnderlineOffset: 2 }
const sQuote: React.CSSProperties = { margin: 0, padding: '2px 0 2px 13px', borderLeft: `2px solid ${C.border}`, color: C.muted, display: 'flex', flexDirection: 'column', gap: 6 }
const HSIZE = [24, 21, 18, 16.5, 15, 14]

function safeHref(url: string): string | undefined {
  const u = url.trim()
  return /^(?:https?:|mailto:)/i.test(u) ? u : undefined
}

type Matcher = { re: RegExp; node: (m: RegExpExecArray, k: string) => ReactNode }
const INLINE: Matcher[] = [
  { re: /`([^`]+)`/, node: (m, k) => <code key={k} style={sCode}>{m[1]}</code> },
  {
    re: /\[([^\]]+)\]\(([^)\s]+)\)/,
    node: (m, k) => {
      const href = safeHref(m[2])
      const inner = renderInline(m[1], k + '>')
      return href
        ? <a key={k} href={href} target="_blank" rel="noreferrer noopener" style={sLink}>{inner}</a>
        : <span key={k}>{inner}</span>
    },
  },
  { re: /\*\*([^*]+)\*\*/, node: (m, k) => <strong key={k} style={sStrong}>{renderInline(m[1], k + '>')}</strong> },
  { re: /\*([^*]+)\*/, node: (m, k) => <em key={k}>{renderInline(m[1], k + '>')}</em> },
]

// Split the earliest inline construct out of `text`, render it, recurse on the remainder.
// On ties the array order wins, so `**` is tried before `*`.
function renderInline(text: string, keyBase = 'i'): ReactNode[] {
  let best: { m: RegExpExecArray; def: Matcher } | null = null
  for (const def of INLINE) {
    const m = def.re.exec(text)
    if (m && (best === null || m.index < best.m.index)) best = { m, def }
  }
  if (!best) return text ? [text] : []
  const { m, def } = best
  const before = text.slice(0, m.index)
  const after = text.slice(m.index + m[0].length)
  return [
    ...(before ? [before] : []),
    def.node(m, `${keyBase}-${m.index}`),
    ...renderInline(after, `${keyBase}+`),
  ]
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.t) {
    case 'h':
      return <div key={key} style={{ fontFamily: FONT_SERIF, fontWeight: 650, fontSize: HSIZE[b.level - 1] ?? 14, lineHeight: 1.3, color: C.text }}>{renderInline(b.text)}</div>
    case 'p':
      return <p key={key} style={{ margin: 0 }}>{renderInline(b.text)}</p>
    case 'code':
      return <pre key={key} style={sPre}><code>{b.code}</code></pre>
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul'
      return <Tag key={key} style={{ margin: 0, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 4 }}>{b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</Tag>
    }
    case 'quote':
      return <blockquote key={key} style={sQuote}>{b.lines.map((l, j) => <p key={j} style={{ margin: 0 }}>{renderInline(l)}</p>)}</blockquote>
    case 'hr':
      return <hr key={key} style={{ border: 0, borderTop: `1px solid ${C.border}`, margin: '2px 0', width: '100%' }} />
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(stripFrontmatter(text))
  if (blocks.length === 0) return null
  return (
    <div style={{ fontFamily: FONT_SERIF, fontSize: 16.5, lineHeight: 1.62, color: C.read, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {blocks.map((b, i) => renderBlock(b, i))}
    </div>
  )
}
