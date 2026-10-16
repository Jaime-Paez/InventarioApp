import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { API_URL, authFetch } from '../../../utils/api'
import CascadeDropdown from '../common/CascadeDropdown'
import '../common/BlockerNotice.css'
import './EntradaAjustePreview.css'

// Al editar las cantidades de una entrada ya recibida: avisa cuanto se
// sumara o restara del inventario por producto y de que ubicacion, y deja
// elegir la ubicacion. El calculo lo hace el backend (previsualizar-ajuste),
// con la misma regla que aplica al guardar.

const optionLabel = (option) => option.nombre

function EntradaAjustePreview({ token, entradaId, details, overrides, onOverridesChange, onPlanChange }) {
  const [plan, setPlan] = useState(null)
  const [loading, setLoading] = useState(false)
  const requestRef = useRef(0)

  const body = useMemo(() => ({
    detalles: (details || [])
      .filter((detail) => detail?.productoId)
      .map((detail) => ({ producto_id: Number(detail.productoId), cantidad: Number.parseInt(detail.cantidad, 10) || 0 })),
    ajustes_ubicacion: Object.entries(overrides || {}).map(([productoId, subdivisionId]) => ({
      producto_id: Number(productoId),
      subdivision_id: Number(subdivisionId),
    })),
  }), [details, overrides])
  const bodyKey = JSON.stringify(body)

  useEffect(() => {
    if (!token || !entradaId) return undefined
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setLoading(true)
    const timer = window.setTimeout(async () => {
      try {
        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/${entradaId}/previsualizar-ajuste/`,
          { method: 'POST', body: bodyKey },
          token
        )
        const payload = await response.json().catch(() => null)
        if (requestId !== requestRef.current) return
        const next = response.ok && payload?.aplica ? payload : null
        setPlan(next)
        onPlanChange?.(next)
      } catch {
        if (requestId === requestRef.current) {
          setPlan(null)
          onPlanChange?.(null)
        }
      } finally {
        if (requestId === requestRef.current) setLoading(false)
      }
    }, 400)
    return () => window.clearTimeout(timer)
  }, [token, entradaId, bodyKey, onPlanChange])

  const cambios = plan?.cambios || []
  if (!cambios.length) return null
  const branchLocations = plan?.ubicaciones_sucursal || []
  const hasErrors = cambios.some((item) => item.error)

  return (
    <div className={`blocker-notice entrada-ajuste${loading ? ' is-loading' : ''}`} role="status">
      <AlertTriangle size={18} aria-hidden="true" />
      <div className="entrada-ajuste__body">
        <strong>{`Al guardar se ajustará el inventario de ${plan.sucursal}`}</strong>
        <p>Solo se aplica la diferencia de cada producto; el resto del inventario no cambia.</p>
        <ul className="entrada-ajuste__list">
          {cambios.map((item) => {
            const sumar = item.delta > 0
            const units = Math.abs(item.delta)
            const product = [item.codigo, item.nombre].filter(Boolean).join(' · ')
            const options = sumar
              ? [
                  ...item.ubicaciones.map((loc) => ({ id: loc.subdivision_id, nombre: `${loc.label} (tiene ${loc.cantidad})` })),
                  ...branchLocations
                    .filter((loc) => !item.ubicaciones.some((own) => own.subdivision_id === loc.subdivision_id))
                    .map((loc) => ({ id: loc.subdivision_id, nombre: loc.label })),
                ]
              : item.ubicaciones
                .filter((loc) => loc.cantidad > 0)
                .map((loc) => ({ id: loc.subdivision_id, nombre: `${loc.label} (hay ${loc.cantidad})` }))
            return (
              <li key={item.producto_id} className={item.error ? 'has-error' : undefined}>
                <div className="entrada-ajuste__line">
                  <span className={`entrada-ajuste__delta ${sumar ? 'is-plus' : 'is-minus'}`}>
                    {sumar ? `+${units}` : `−${units}`}
                  </span>
                  <span>
                    {`Se ${sumar ? 'sumarán' : 'restarán'} ${units} de `}
                    <b>{product}</b>
                    {` (de ${item.antes} a ${item.despues})`}
                    {item.ubicacion && !item.error && ` ${sumar ? 'en' : 'de'} ${item.ubicacion}`}
                  </span>
                </div>
                {item.error && <p className="entrada-ajuste__error">{item.error}</p>}
                {options.length > 1 || (sumar && !item.subdivision_id) ? (
                  <div className="entrada-ajuste__choose">
                    <span>{sumar ? '¿Dónde guardar?' : '¿De dónde restar?'}</span>
                    <CascadeDropdown
                      placeholder={item.repartir ? 'Varias ubicaciones' : 'Elige la ubicación'}
                      searchPlaceholder="Buscar ubicación"
                      options={options}
                      valueId={overrides?.[item.producto_id] || item.subdivision_id || ''}
                      getOptionLabel={optionLabel}
                      emptyMessage="Esta sucursal no tiene ubicaciones registradas."
                      onSelect={(option) => onOverridesChange?.({ ...(overrides || {}), [item.producto_id]: option.id })}
                    />
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
        {hasErrors && (
          <p className="entrada-ajuste__error">Corrige lo marcado para poder guardar.</p>
        )}
      </div>
    </div>
  )
}

export default EntradaAjustePreview
