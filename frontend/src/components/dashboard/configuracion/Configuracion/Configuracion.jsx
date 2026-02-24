import { useCallback, useEffect, useRef, useState } from 'react'
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

function Configuracion({ token, darkMode, onToggleTheme }) {
  const [ivaPercent, setIvaPercent] = useState(String(DEFAULT_IVA))
  const [configId, setConfigId] = useState(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const toast = useRef(null)
  const canToggleTheme = typeof onToggleTheme === 'function'

  const setTheme = (target) => {
    if (!canToggleTheme) return
    const wantsDark = target === 'dark'
    if (wantsDark !== Boolean(darkMode)) onToggleTheme()
  }

  const notify = useCallback((severity, summary, detail) => {
    toast.current?.show({ severity, summary, detail, life: 3000 })
  }, [])

  const fetchConfig = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const response = await authFetch(`${API_URL}/configuracion/sistema/`, {}, token)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.detail || 'No se pudo cargar la configuración.')
      if (data?.id) setConfigId(data.id)
      const raw = Number(data?.iva_rate)
      const percent = Number.isFinite(raw) ? raw * 100 : DEFAULT_IVA
      setIvaPercent(String(percent))
    } catch (err) {
      notify('warn', 'Aviso', err.message || 'No se pudo cargar la configuración.')
    } finally {
      setLoading(false)
    }
  }, [notify, token])

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  const handleSave = async () => {
    const percent = parsePercent(ivaPercent)
    if (percent === null) {
      notify('warn', 'Aviso', 'Ingresa un IVA válido.')
      return
    }
    if (percent < 0 || percent > 100) {
      notify('warn', 'Aviso', 'El IVA debe estar entre 0 y 100.')
      return
    }

    setSaving(true)
    if (!configId) {
      notify('warn', 'Aviso', 'No se encontró la configuración del sistema.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/configuracion/sistema/${configId}/`,
        {
          method: 'PUT',
          body: JSON.stringify({ iva_rate: percent / 100 }),
        },
        token
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.detail || 'No se pudo guardar la configuración.')
      setIvaPercent(String(percent))
      emitIvaUpdated(percent / 100)
      notify('success', 'Guardado', 'IVA actualizado correctamente.')
    } catch (err) {
      notify('warn', 'Aviso', err.message || 'No se pudo guardar la configuración.')
    } finally {
      setSaving(false)
    }
  }

  const percentValue = parsePercent(ivaPercent)
  const decimalValue = percentValue === null ? '—' : (percentValue / 100).toFixed(4)

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
            onClick={handleSave}
            disabled={loading || saving}
          >
            {saving ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </section>

      <section className="create-user__section configuracion__section">
        <div className="create-user__section-header">
          <div>
            <h4>Apariencia</h4>
            <p className="create-user__hint">
              Define el modo visual del panel. Se guarda en este navegador.
            </p>
          </div>
        </div>

        <div className="create-user__grid create-user__grid--two">
          <div className="configuracion__preview">
            <span>Modo actual</span>
            <strong>{darkMode ? 'Oscuro' : 'Claro'}</strong>
            <small>{darkMode ? 'Contraste alto y fondo oscuro.' : 'Fondo claro y lectura limpia.'}</small>
          </div>

          <div className="configuracion__theme-toggle" role="group" aria-label="Modo de color">
            <button
              type="button"
              className={`configuracion__theme-option ${!darkMode ? 'active' : ''}`}
              onClick={() => setTheme('light')}
              disabled={!canToggleTheme}
            >
              Claro
            </button>
            <button
              type="button"
              className={`configuracion__theme-option ${darkMode ? 'active' : ''}`}
              onClick={() => setTheme('dark')}
              disabled={!canToggleTheme}
            >
              Oscuro
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

export default Configuracion
