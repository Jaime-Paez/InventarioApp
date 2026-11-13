import { useEffect, useState } from 'react'

// Salida de una pildora del dock: cuando ya no queda nada pendiente, la
// pildora sigue montada un momento para que el contador pase a 0 y luego
// sale hacia arriba (clase "is-leaving"); despues se desmonta y las demas se
// deslizan a cerrar el hueco (useDockEntrance).
export const PILL_EXIT_MS = 820

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export default function usePillExit(active) {
  const [phase, setPhase] = useState(active ? 'shown' : 'hidden')

  useEffect(() => {
    if (active) {
      setPhase('shown')
      return undefined
    }
    setPhase((prev) => (prev === 'hidden' ? 'hidden' : 'leaving'))
    const timer = window.setTimeout(() => setPhase('hidden'), prefersReducedMotion() ? 0 : PILL_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [active])

  return {
    present: active || phase !== 'hidden',
    leaving: !active && phase === 'leaving',
  }
}
