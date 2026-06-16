import type { Density } from './types'
import { C } from '../theme'

const DENSITIES: Density[] = ['compact', 'balanced', 'detailed']

export function DensityControl({ density, onChange }: { density: Density; onChange: (next: Density) => void }) {
  return (
    <div style={{ display: 'inline-flex', border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }} aria-label="Transcript density">
      {DENSITIES.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onChange(d)}
          aria-pressed={density === d}
          style={{
            background: density === d ? C.raise : 'transparent',
            border: 'none',
            borderRight: d === 'detailed' ? 'none' : `1px solid ${C.border}`,
            color: density === d ? C.text : C.muted,
            cursor: 'pointer',
            fontSize: 11.5,
            padding: '5px 8px',
            textTransform: 'capitalize',
          }}
        >
          {d}
        </button>
      ))}
    </div>
  )
}
