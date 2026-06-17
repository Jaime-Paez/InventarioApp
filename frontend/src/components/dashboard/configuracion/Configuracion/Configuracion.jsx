import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Toast } from 'primereact/toast'
import '../../admin/CreateUsuario/CreateUsuario.css'
import './Configuracion.css'
import { API_URL, authFetch } from '../../../../utils/api'
import { emitIvaUpdated } from '../../../../utils/configEvents'

const DEFAULT_IVA = 15

const parsePercent = (value) => {
  const cleaned = String(value ?? '').replace(',', '.').trim()
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}


function Configuracion({ token, user }) {
  const [ivaPercent, setIvaPercent] = useState(String(DEFAULT_IVA))
  const [configId, setConfigId] = useState(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const toast = useRef(null)

  const notify = useCallback((severity, summary, detail) => {
    toast.current?.show({ severity, summary, detail, life: 3000 })
  }, [])

  const fetchConfig = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const response = await authFetch(`${API_URL}/configuracion/sistema/`, {}, token)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.detail || 'No se pudo cargar la configuracion.')

      if (data?.id) setConfigId(data.id)

      const ivaRaw = Number(data?.iva_rate)
      const percent = Number.isFinite(ivaRaw) ? ivaRaw * 100 : DEFAULT_IVA
      setIvaPercent(String(percent))

    } catch (err) {
      notify('warn', 'Aviso', err.message || 'No se pudo cargar la configuracion.')
    } finally {
      setLoading(false)
    }
  }, [notify, token])

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  const saveConfigPatch = useCallback(async (payload, successMessage) => {
    if (!configId) {
      notify('warn', 'Aviso', 'No se encontro la configuracion del sistema.')
      return false
    }

    setSaving(true)
    try {
      const response = await authFetch(
        `${API_URL}/configuracion/sistema/${configId}/`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.detail || 'No se pudo guardar la configuracion.')

      if (data?.id) setConfigId(data.id)

      const ivaRaw = Number(data?.iva_rate)
      if (Number.isFinite(ivaRaw)) {
        const nextIvaPercent = ivaRaw * 100
        setIvaPercent(String(nextIvaPercent))
        emitIvaUpdated(ivaRaw)
      }

      notify('success', 'Guardado', successMessage)
      return true
    } catch (err) {
      notify('warn', 'Aviso', err.message || 'No se pudo guardar la configuracion.')
      return false
    } finally {
      setSaving(false)
    }
  }, [configId, notify, token])

  const handleSaveIva = async () => {
    const percent = parsePercent(ivaPercent)
    if (percent === null) {
      notify('warn', 'Aviso', 'Ingresa un IVA valido.')
      return
    }
    if (percent < 0 || percent > 100) {
      notify('warn', 'Aviso', 'El IVA debe estar entre 0 y 100.')
      return
    }

    await saveConfigPatch(
      { iva_rate: percent / 100 },
      'IVA actualizado correctamente.'
    )
  }

  const percentValue = parsePercent(ivaPercent)
  const decimalValue = percentValue === null ? '-' : (percentValue / 100).toFixed(4)

  return (
    <div className="configuracion__layout">
      <Toast ref={toast} />

      <section className="create-user__section configuracion__section">
        <div className="create-user__section-header">
          <div>
            <h4>IVA del sistema</h4>
            <p className="create-user__hint">
              Este IVA se aplica a las salidas y queda guardado en cada movimiento.
            </p>
          </div>
        </div>

        <div className="create-user__grid create-user__grid--two">
          <label className="create-user__field">
            <span>IVA (%)</span>
            <input
              type="text"
              value={ivaPercent}
              onChange={(event) => setIvaPercent(event.target.value)}
              disabled={loading || saving}
            />
            <small>Ejemplo: 15</small>
          </label>

          <div className="configuracion__preview">
            <span>Valor decimal</span>
            <strong>{decimalValue}</strong>
            <small>Se guarda como {decimalValue} en la base de datos.</small>
          </div>
        </div>

        <div className="configuracion__actions">
          <button
            type="button"
            className="create-user__action create-user__action--primary"
            onClick={handleSaveIva}
            disabled={loading || saving}
          >
            {saving ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </section>
    </div>
  )
}

export default Configuracion
