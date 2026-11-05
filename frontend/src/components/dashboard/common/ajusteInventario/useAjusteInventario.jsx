import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ClipboardEdit } from 'lucide-react'
import { API_URL, authFetch } from '../../../../utils/api'
import { getAppPortalRoot } from '../../../../utils/portalRoot'
import './AjusteMotivoDialog.css'

export const MOTIVOS_AJUSTE = ['No encontré', 'Ajuste de inventario']
const OTRO = '__otro__'

export class AjusteCanceladoError extends Error {
  constructor() {
    super('No se guardaron las cantidades: falta elegir el motivo del ajuste.')
    this.name = 'AjusteCanceladoError'
  }
}

// Cambiar a mano la cantidad de un producto es un ajuste de inventario: se
// guarda con POST /inventario/inventario/ajustar/ y, si el total de alguna
// sucursal sube o baja, el servidor pide el motivo (400 motivo_requerido con
// cuanto mas o menos queda). Aqui se pregunta el motivo y se reenvia.
// Repartir entre ubicaciones de la misma sucursal no pide motivo.
export default function useAjusteInventario(token) {
  const [pending, setPending] = useState(null)
  const [choice, setChoice] = useState(MOTIVOS_AJUSTE[0])
  const [otro, setOtro] = useState('')
  const resolverRef = useRef(null)

  const requestMotivo = useCallback((ajustes) => new Promise((resolve) => {
    resolverRef.current = resolve
    setChoice(MOTIVOS_AJUSTE[0])
    setOtro('')
    setPending(ajustes || [])
  }), [])

  const close = (value) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setPending(null)
    resolve?.(value)
  }

  // Lanza AjusteCanceladoError si el usuario cierra sin elegir motivo.
  const guardarAjuste = useCallback(async (productoId, cambios) => {
    const send = (motivo) => authFetch(
      `${API_URL}/inventario/inventario/ajustar/`,
      { method: 'POST', body: JSON.stringify({ producto_id: productoId, cambios, ...(motivo ? { motivo } : {}) }) },
      token
    )
    let response = await send('')
    let payload = await response.clone().json().catch(() => ({}))
    if (response.status === 400 && payload?.code === 'motivo_requerido') {
      const motivo = await requestMotivo(payload.ajustes)
      if (!motivo) throw new AjusteCanceladoError()
      response = await send(motivo)
      payload = await response.clone().json().catch(() => ({}))
    }
    return { response, payload }
  }, [requestMotivo, token])

  const motivoFinal = choice === OTRO ? otro.trim() : choice

  const dialog = pending && typeof document !== 'undefined' ? createPortal(
    <div className="ajuste-motivo__backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(null) }}>
      <div className="ajuste-motivo" role="dialog" aria-modal="true" aria-labelledby="ajuste-motivo-title">
        <div className="ajuste-motivo__head">
          <ClipboardEdit size={18} aria-hidden="true" />
          <h3 id="ajuste-motivo-title">Ajuste de inventario</h3>
        </div>
        <p className="ajuste-motivo__lead">Cambió la cantidad del producto. ¿Por qué?</p>
        <ul className="ajuste-motivo__list">
          {pending.map((ajuste) => (
            <li key={ajuste.sucursal_id}>
              <span>{ajuste.sucursal || 'Sucursal'}</span>
              <span className="ajuste-motivo__nums">
                {ajuste.cantidad_anterior} → {ajuste.cantidad_nueva}
                <strong className={ajuste.diferencia > 0 ? 'is-up' : 'is-down'}>
                  {ajuste.diferencia > 0 ? `+${ajuste.diferencia}` : `−${Math.abs(ajuste.diferencia)}`}
                </strong>
              </span>
            </li>
          ))}
        </ul>
        <div className="ajuste-motivo__options" role="radiogroup" aria-label="Motivo">
          {[...MOTIVOS_AJUSTE, OTRO].map((value) => (
            <label key={value} className={`ajuste-motivo__option${choice === value ? ' is-active' : ''}`}>
              <input type="radio" name="ajuste-motivo" value={value} checked={choice === value} onChange={() => setChoice(value)} />
              <span>{value === OTRO ? 'Otro' : value}</span>
            </label>
          ))}
        </div>
        {choice === OTRO && (
          <input
            className="ajuste-motivo__input"
            type="text"
            maxLength={200}
            autoFocus
            placeholder="Escribe el motivo"
            value={otro}
            onChange={(event) => setOtro(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && motivoFinal) close(motivoFinal) }}
          />
        )}
        <div className="ajuste-motivo__actions">
          <button type="button" className="ajuste-motivo__btn" onClick={() => close(null)}>Cancelar</button>
          <button
            type="button"
            className="ajuste-motivo__btn ajuste-motivo__btn--primary"
            disabled={!motivoFinal}
            onClick={() => close(motivoFinal)}
          >
            Guardar ajuste
          </button>
        </div>
      </div>
    </div>,
    getAppPortalRoot()
  ) : null

  return { guardarAjuste, ajusteDialog: dialog }
}
