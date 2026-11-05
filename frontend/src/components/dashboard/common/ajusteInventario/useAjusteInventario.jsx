import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ClipboardCheck, ClipboardEdit, PencilLine, SearchX } from 'lucide-react'
import { API_URL, authFetch } from '../../../../utils/api'
import { getAppPortalRoot } from '../../../../utils/portalRoot'
import './AjusteMotivoDialog.css'

export const MOTIVOS_AJUSTE = ['No encontré', 'Ajuste de inventario']
const OTRO = '__otro__'

const OPCIONES = [
  { value: MOTIVOS_AJUSTE[0], label: 'No encontré', icon: <SearchX className="ajuste-motivo__icon" size={22} aria-hidden="true" /> },
  { value: MOTIVOS_AJUSTE[1], label: 'Ajuste de inventario', icon: <ClipboardCheck className="ajuste-motivo__icon" size={22} aria-hidden="true" /> },
  { value: OTRO, label: 'Otro', icon: <PencilLine className="ajuste-motivo__icon" size={22} aria-hidden="true" /> },
]

export class AjusteCanceladoError extends Error {
  constructor() {
    super('No se guardaron las cantidades: falta elegir el motivo del ajuste.')
    this.name = 'AjusteCanceladoError'
  }
}

// Cambiar a mano la cantidad de un producto es un ajuste de inventario: se
// guarda con POST /inventario/inventario/ajustar/ y, si el total de alguna
// sucursal sube o baja, el servidor pide el motivo (400 motivo_requerido con
// cuanto mas o menos queda). Repartir entre ubicaciones de la misma sucursal
// no pide motivo.
// El editor pregunta el motivo apenas se cambia la cantidad (pedirMotivo); el
// que se confirma ahi se manda al guardar sin volver a preguntar.
// "No encontré" solo tiene sentido si en todas las sucursales la cantidad bajó.
const soloBaja = (ajustes) => Array.isArray(ajustes) && ajustes.length > 0
  && ajustes.every((ajuste) => Number(ajuste?.diferencia) < 0)

export default function useAjusteInventario(token) {
  const [pending, setPending] = useState(null)
  const [choice, setChoice] = useState(MOTIVOS_AJUSTE[0])
  const [otro, setOtro] = useState('')
  const resolverRef = useRef(null)
  const promiseRef = useRef(null)

  // Si ya hay un dialogo abierto (p. ej. se cambio la cantidad y enseguida se
  // pulso Guardar) se espera esa misma respuesta en vez de abrir otro.
  const pedirMotivo = useCallback((ajustes) => {
    if (promiseRef.current) return promiseRef.current
    promiseRef.current = new Promise((resolve) => {
      resolverRef.current = resolve
      // "No encontré" solo cuando la cantidad baja; si sube, por defecto
      // "Ajuste de inventario".
      setChoice(soloBaja(ajustes) ? MOTIVOS_AJUSTE[0] : MOTIVOS_AJUSTE[1])
      setOtro('')
      setPending(ajustes || [])
    })
    return promiseRef.current
  }, [])

  const close = (value) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    promiseRef.current = null
    setPending(null)
    resolve?.(value)
  }

  // Lanza AjusteCanceladoError si el usuario cierra sin elegir motivo.
  const guardarAjuste = useCallback(async (productoId, cambios, motivoPrevio = '') => {
    const send = (motivo) => authFetch(
      `${API_URL}/inventario/inventario/ajustar/`,
      { method: 'POST', body: JSON.stringify({ producto_id: productoId, cambios, ...(motivo ? { motivo } : {}) }) },
      token
    )
    let response = await send('')
    let payload = await response.clone().json().catch(() => ({}))
    if (response.status === 400 && payload?.code === 'motivo_requerido') {
      const motivo = motivoPrevio || await pedirMotivo(payload.ajustes)
      if (!motivo) throw new AjusteCanceladoError()
      response = await send(motivo)
      payload = await response.clone().json().catch(() => ({}))
    }
    return { response, payload }
  }, [pedirMotivo, token])

  const motivoFinal = choice === OTRO ? otro.trim() : choice
  const opciones = OPCIONES.filter(({ value }) => value !== MOTIVOS_AJUSTE[0] || soloBaja(pending))

  const dialog = pending && typeof document !== 'undefined' ? createPortal(
    <div className="ajuste-motivo__backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(null) }}>
      <div className="ajuste-motivo" role="dialog" aria-modal="true" aria-labelledby="ajuste-motivo-title">
        <div className="ajuste-motivo__head">
          <ClipboardEdit size={18} aria-hidden="true" />
          <h3 id="ajuste-motivo-title">Ajuste de inventario</h3>
        </div>
        <p className="ajuste-motivo__lead">
          Cambió la cantidad del producto. ¿Por qué? Si cancelas, vuelve la cantidad anterior.
        </p>
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
        <div className={`ajuste-motivo__options ajuste-motivo__options--${opciones.length}`} role="radiogroup" aria-label="Motivo">
          {opciones.map(({ value, label, icon }) => (
            <label key={value} className={`ajuste-motivo__option${choice === value ? ' is-active' : ''}`}>
              <input
                className="ajuste-motivo__radio"
                type="radio"
                name="ajuste-motivo"
                value={value}
                checked={choice === value}
                onChange={() => setChoice(value)}
              />
              <span className="ajuste-motivo__check" aria-hidden="true">
                {choice === value && <Check size={12} strokeWidth={3} />}
              </span>
              {icon}
              <span className="ajuste-motivo__label">{label}</span>
            </label>
          ))}
        </div>
        {choice === OTRO && (
          <textarea
            className="ajuste-motivo__input"
            rows={4}
            maxLength={200}
            autoFocus
            placeholder="Escribe el motivo del ajuste"
            value={otro}
            onChange={(event) => setOtro(event.target.value)}
          />
        )}
        {choice === OTRO && !motivoFinal && (
          <small className="ajuste-motivo__hint">Escribe el motivo para poder guardar el ajuste.</small>
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

  return { guardarAjuste, pedirMotivo, ajusteDialog: dialog }
}
