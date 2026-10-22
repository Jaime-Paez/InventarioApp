import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { API_URL, authFetch } from '../../../utils/api'
import { formatDate } from '../../../utils/dateFormat'
import BlockerNotice from '../common/BlockerNotice'
import './LlegadaDialog.css'

// Paso 1 de la recepcion: solo se confirma que el envio llego, viendo lo que
// debia llegar. No suma stock: en "Por guardar" se verifica cuanto llego de
// cada producto y se suma al guardarlo en su ubicacion.
function LlegadaDialog({ shipment, token, darkMode, onClose, onConfirmed }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const isImportacion = shipment?._source === 'importacion'
  const items = useMemo(
    () => (Array.isArray(shipment?.detalles) ? shipment.detalles : []).map((row) => ({
      id: String(row?.producto_id ?? row?.detalle_id ?? ''),
      codigo: String(row?.producto_codigo || '').trim(),
      nombre: String(row?.producto_nombre || '').trim(),
      cantidad: Number(row?.cantidad_enviada ?? row?.cantidad ?? 0) || 0,
    })),
    [shipment]
  )
  const totalUnits = items.reduce((sum, item) => sum + item.cantidad, 0)

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape' && !saving) onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const confirm = async () => {
    if (!token || saving) return
    setSaving(true)
    setError('')
    try {
      const id = encodeURIComponent(String(isImportacion ? (shipment?.envio_id || shipment?.id) : shipment?.id))
      const url = isImportacion
        ? `${API_URL}/importaciones/importaciones/envios/${id}/confirmar-llegada/`
        : `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${id}/confirmar-llegada/`
      const response = await authFetch(url, { method: 'POST' }, token)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo confirmar la llegada.')
      onConfirmed?.(shipment)
    } catch (requestError) {
      setError(requestError?.message || 'No se pudo confirmar la llegada.')
    } finally {
      setSaving(false)
    }
  }

  const doc = String(shipment?.no_documento || shipment?.id || '').trim()
  const desde = isImportacion ? 'Importacion' : String(shipment?.sucursal_proveedora || '').trim()
  const hacia = String(shipment?.sucursal_solicitante || '').trim()

  return createPortal(
    <div
      className={`llegada-dialog${darkMode ? ' llegada-dialog--dark' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Confirmar llegada"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose?.() }}
    >
      <div className="llegada-dialog__card">
        <header className="llegada-dialog__header">
          <div>
            <h3>{`${isImportacion ? 'Importación' : 'Traslado'}: #${doc}`}</h3>
            <p>
              {[desde && `Desde ${desde}`, hacia && `hacia ${hacia}`, shipment?.fecha && `enviado el ${formatDate(shipment.fecha)}`]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <button type="button" className="llegada-dialog__close" onClick={onClose} disabled={saving} aria-label="Cerrar">
            <X size={18} />
          </button>
        </header>

        <p className="llegada-dialog__intro">
          Esto es lo que debía llegar. Confirma que el envío llegó: <strong>todavía no se suma al inventario</strong>.
          Después, en <strong>Por guardar</strong>, verificas cuánto llegó de cada producto y lo guardas en su
          ubicación (ahí se suma). Mientras tanto se ve entre paréntesis en el inventario.
        </p>

        {String(shipment?.nota_envio || '').trim() && (
          <p className="llegada-dialog__note"><strong>Nota del envío:</strong> {String(shipment.nota_envio).trim()}</p>
        )}

        <div className="llegada-dialog__table-wrap">
          <table className="llegada-dialog__table">
            <thead>
              <tr>
                <th>Producto</th>
                <th>Descripción</th>
                <th className="llegada-dialog__qty">Debía llegar</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id || item.codigo}>
                  <td><strong>{item.codigo || '-'}</strong></td>
                  <td>{item.nombre || '-'}</td>
                  <td className="llegada-dialog__qty">{item.cantidad}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {error && <BlockerNotice compact title={error} />}

        <footer className="llegada-dialog__footer">
          <span>{`${items.length} producto(s) · ${totalUnits} unidad(es)`}</span>
          <div className="llegada-dialog__actions">
            <button type="button" className="llegada-dialog__btn" onClick={onClose} disabled={saving}>
              Cancelar
            </button>
            <button type="button" className="llegada-dialog__btn llegada-dialog__btn--primary" onClick={() => void confirm()} disabled={saving || !items.length}>
              {saving ? 'Confirmando...' : 'Confirmar llegada'}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body
  )
}

export default LlegadaDialog
