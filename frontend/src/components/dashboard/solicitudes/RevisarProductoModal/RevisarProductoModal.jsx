import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import useModalAnimation from '../../common/useModalAnimation'
import { API_URL, authFetch } from '../../../../utils/api'

const emptyRef = () => ({ uid: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, casaComercialId: '', casaComercialNombre: '', referencia: '' })

function RevisarProductoModal({ open, solicitudId, productoNombre, token, onRevisado, onClose }) {
  const { shouldRender, isClosing } = useModalAnimation(open)
  const [filas, setFilas] = useState([emptyRef()])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [casasOptions, setCasasOptions] = useState([])
  const [casasLoading, setCasasLoading] = useState(false)
  const [openDropdownUid, setOpenDropdownUid] = useState(null)
  const [casaQuery, setCasaQuery] = useState('')
  const dropdownRef = useRef(null)
  const searchTimerRef = useRef(null)

  useEffect(() => {
    if (open) {
      setFilas([emptyRef()])
      setError('')
      setOpenDropdownUid(null)
      setCasaQuery('')
      setCasasOptions([])
    }
  }, [open])

  const searchCasas = useCallback(async (query) => {
    const term = String(query ?? '').trim()
    if (!term || !token) { setCasasOptions([]); return }
    setCasasLoading(true)
    try {
      const res = await authFetch(`${API_URL}/casa-comercial/casas-comerciales/?search=${encodeURIComponent(term)}&page_size=10`, {}, token)
      if (!res.ok) throw new Error()
      const data = await res.json().catch(() => ({}))
      const list = Array.isArray(data) ? data : data?.results || []
      setCasasOptions(list)
    } catch {
      setCasasOptions([])
    } finally {
      setCasasLoading(false)
    }
  }, [token])

  const handleCasaQueryChange = (uid, value) => {
    setCasaQuery(value)
    setOpenDropdownUid(uid)
    setFilas((prev) => prev.map((f) => f.uid === uid ? { ...f, casaComercialId: '', casaComercialNombre: value } : f))
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => searchCasas(value), 240)
  }

  const handleCasaSelect = (uid, casa) => {
    setFilas((prev) => prev.map((f) => f.uid === uid ? { ...f, casaComercialId: String(casa.id), casaComercialNombre: casa.nombre } : f))
    setOpenDropdownUid(null)
    setCasaQuery('')
    setCasasOptions([])
  }

  const handleReferenciaChange = (uid, value) => {
    setFilas((prev) => prev.map((f) => f.uid === uid ? { ...f, referencia: value } : f))
  }

  const handleAddFila = () => setFilas((prev) => [...prev, emptyRef()])

  const handleRemoveFila = (uid) => {
    setFilas((prev) => {
      const next = prev.filter((f) => f.uid !== uid)
      return next.length ? next : [emptyRef()]
    })
  }

  const handleGuardar = async () => {
    const validFilas = filas.filter((f) => f.casaComercialId || String(f.casaComercialNombre || '').trim() || String(f.referencia || '').trim())
    if (!validFilas.length) {
      setError('Agrega al menos una referencia.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const referencias = validFilas.map((f) => ({
        casa_comercial_id: f.casaComercialId ? Number(f.casaComercialId) : null,
        referencia: String(f.referencia || '').trim(),
      }))
      const res = await authFetch(
        `${API_URL}/solicitudes/solicitudes/${solicitudId}/revisar/`,
        { method: 'POST', body: JSON.stringify({ referencias }), headers: { 'Content-Type': 'application/json' } },
        token
      )
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        throw new Error(payload?.detail || payload?.referencias || 'No se pudo revisar el producto.')
      }
      const data = await res.json().catch(() => ({}))
      onRevisado?.(data)
    } catch (err) {
      setError(String(err?.message || 'Ocurrió un error al guardar.'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!openDropdownUid) return
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpenDropdownUid(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [openDropdownUid])

  if (!shouldRender) return null

  const modal = (
    <div
      className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`}
      role="dialog"
      aria-modal="true"
      style={{ padding: 12 }}
    >
      <div
        className={`create-user__modal${isClosing ? ' create-user__modal--closing' : ''}`}
        style={{
          width: 620,
          height: 'auto',
          minHeight: 0,
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: 'calc(100vh - 24px)',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          overflow: 'auto',
        }}
      >
        <header className="create-user__header">
          <div className="create-user__header-text">
            <h3>Revisar producto</h3>
          </div>
          <div className="create-user__header-actions">
            <button
              type="button"
              className="create-user__icon-button"
              onClick={onClose}
              disabled={loading}
              aria-label="Cerrar"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div style={{ padding: '16px 24px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {productoNombre && (
            <p style={{ margin: 0, fontSize: '0.9rem' }}>
              Producto: <strong>{productoNombre}</strong>
            </p>
          )}

          <div>
            <div
              className="create-user__locations-row create-user__locations-row--head"
              style={{ gridTemplateColumns: '1fr 1fr 36px', marginBottom: 4 }}
            >
              <span>Casa comercial</span>
              <span>Referencia</span>
              <span />
            </div>

            {filas.map((fila) => (
              <div
                key={fila.uid}
                className="create-user__locations-row"
                style={{ gridTemplateColumns: '1fr 1fr 36px', alignItems: 'center', gap: 6, padding: '6px 8px' }}
              >
                <div style={{ position: 'relative' }} ref={openDropdownUid === fila.uid ? dropdownRef : null}>
                  <input
                    type="text"
                    value={openDropdownUid === fila.uid ? casaQuery : fila.casaComercialNombre}
                    placeholder="Buscar casa comercial..."
                    disabled={loading}
                    onChange={(e) => handleCasaQueryChange(fila.uid, e.target.value)}
                    onFocus={() => {
                      setCasaQuery(fila.casaComercialNombre)
                      setOpenDropdownUid(fila.uid)
                      if (fila.casaComercialNombre) searchCasas(fila.casaComercialNombre)
                    }}
                    style={{ width: '100%', boxSizing: 'border-box' }}
                  />
                  {openDropdownUid === fila.uid && (casasLoading || casasOptions.length > 0) && (
                    <div
                      style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        right: 0,
                        zIndex: 200,
                        background: 'var(--modal-color, #fff)',
                        border: '1px solid var(--color-border, #ccc)',
                        borderRadius: 6,
                        boxShadow: 'var(--shadow-panel)',
                        maxHeight: 180,
                        overflowY: 'auto',
                      }}
                    >
                      {casasLoading && (
                        <div style={{ padding: '8px 12px', fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                          Buscando...
                        </div>
                      )}
                      {!casasLoading && casasOptions.map((casa) => (
                        <button
                          key={casa.id}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => handleCasaSelect(fila.uid, casa)}
                          style={{
                            display: 'block',
                            width: '100%',
                            textAlign: 'left',
                            padding: '7px 12px',
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: '0.875rem',
                          }}
                        >
                          <strong>{casa.codigo}</strong>&nbsp;{casa.nombre}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <input
                  type="text"
                  value={fila.referencia}
                  placeholder="Referencia..."
                  disabled={loading}
                  onChange={(e) => handleReferenciaChange(fila.uid, e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box' }}
                />

                <button
                  type="button"
                  className="create-user__locations-remove"
                  onClick={() => handleRemoveFila(fila.uid)}
                  disabled={loading || filas.length === 1}
                  title="Eliminar fila"
                >
                  ×
                </button>
              </div>
            ))}

            <button
              type="button"
              className="create-user__ghost"
              onClick={handleAddFila}
              disabled={loading}
              style={{ marginTop: 8, fontSize: '0.85rem' }}
            >
              + Agregar referencia
            </button>
          </div>

          {error && (
            <p style={{ margin: 0, color: 'var(--color-error, #e53e3e)', fontSize: '0.875rem' }}>
              {error}
            </p>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="create-user__action create-user__action--cancel"
              onClick={onClose}
              disabled={loading}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="create-user__action"
              onClick={handleGuardar}
              disabled={loading}
            >
              {loading ? 'Guardando...' : 'Guardar revisión'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal
}

export default RevisarProductoModal
