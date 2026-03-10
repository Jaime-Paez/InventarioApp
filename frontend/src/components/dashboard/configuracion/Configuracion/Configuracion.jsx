import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Toast } from 'primereact/toast'
import '../../admin/CreateUsuario/CreateUsuario.css'
import './Configuracion.css'
import { API_URL, authFetch } from '../../../../utils/api'
import { emitIvaUpdated } from '../../../../utils/configEvents'

const DEFAULT_IVA = 15
const DEFAULT_RANDOM_INSPECTION_ITEMS_PER_DAY = 5
const MIN_RANDOM_INSPECTION_ITEMS_PER_DAY = 1
const MAX_RANDOM_INSPECTION_ITEMS_PER_DAY = 200

const parsePercent = (value) => {
  const cleaned = String(value ?? '').replace(',', '.').trim()
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

const parsePositiveInteger = (value) => {
  const cleaned = String(value ?? '').trim()
  if (!cleaned) return null
  const parsed = Number.parseInt(cleaned, 10)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeString = (value) => String(value ?? '').trim().toLowerCase()

const hasUsersModuleAccess = (permissions) =>
  (Array.isArray(permissions) ? permissions : []).some((permission) => {
    if (normalizeString(permission?.modulo) !== 'usuarios') return false
    return Boolean(
      permission?.puede_crear ||
        permission?.puede_actualizar ||
        permission?.puede_eliminar
    )
  })

function Configuracion({ token, darkMode, onToggleTheme, user }) {
  const [ivaPercent, setIvaPercent] = useState(String(DEFAULT_IVA))
  const [randomInspectionItemsPerDay, setRandomInspectionItemsPerDay] = useState(
    String(DEFAULT_RANDOM_INSPECTION_ITEMS_PER_DAY)
  )
  const [configId, setConfigId] = useState(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const toast = useRef(null)
  const canToggleTheme = typeof onToggleTheme === 'function'

  const canManageInspectionItems = useMemo(
    () => Boolean(
      user?.is_superuser ||
        user?.is_staff ||
        user?.es_administrador ||
        normalizeString(user?.rol) === 'administrador' ||
        hasUsersModuleAccess(user?.permisos)
    ),
    [user]
  )

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
      if (!response.ok) throw new Error(data?.detail || 'No se pudo cargar la configuracion.')

      if (data?.id) setConfigId(data.id)

      const ivaRaw = Number(data?.iva_rate)
      const percent = Number.isFinite(ivaRaw) ? ivaRaw * 100 : DEFAULT_IVA
      setIvaPercent(String(percent))

      const inspectionItemsRaw = Number(data?.random_inspection_items_per_day)
      const inspectionItems = Number.isFinite(inspectionItemsRaw)
        ? Math.max(
          MIN_RANDOM_INSPECTION_ITEMS_PER_DAY,
          Math.min(MAX_RANDOM_INSPECTION_ITEMS_PER_DAY, Math.floor(inspectionItemsRaw))
        )
        : DEFAULT_RANDOM_INSPECTION_ITEMS_PER_DAY
      setRandomInspectionItemsPerDay(String(inspectionItems))
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

      const inspectionItemsRaw = Number(data?.random_inspection_items_per_day)
      if (Number.isFinite(inspectionItemsRaw)) {
        const normalizedItems = Math.max(
          MIN_RANDOM_INSPECTION_ITEMS_PER_DAY,
          Math.min(MAX_RANDOM_INSPECTION_ITEMS_PER_DAY, Math.floor(inspectionItemsRaw))
        )
        setRandomInspectionItemsPerDay(String(normalizedItems))
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

  const handleSaveInspectionItems = async () => {
    if (!canManageInspectionItems) return

    const itemsPerDay = parsePositiveInteger(randomInspectionItemsPerDay)
    if (itemsPerDay === null) {
      notify('warn', 'Aviso', 'Ingresa una cantidad de productos valida.')
      return
    }

    if (
      itemsPerDay < MIN_RANDOM_INSPECTION_ITEMS_PER_DAY ||
      itemsPerDay > MAX_RANDOM_INSPECTION_ITEMS_PER_DAY
    ) {
      notify(
        'warn',
        'Aviso',
        `La cantidad debe estar entre ${MIN_RANDOM_INSPECTION_ITEMS_PER_DAY} y ${MAX_RANDOM_INSPECTION_ITEMS_PER_DAY}.`
      )
      return
    }

    await saveConfigPatch(
      { random_inspection_items_per_day: itemsPerDay },
      'Cantidad de productos por revision actualizada.'
    )
  }

  const percentValue = parsePercent(ivaPercent)
  const decimalValue = percentValue === null ? '-' : (percentValue / 100).toFixed(4)
  const inspectionItemsPreview = parsePositiveInteger(randomInspectionItemsPerDay)

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

      {canManageInspectionItems && (
        <section className="create-user__section configuracion__section">
          <div className="create-user__section-header">
            <div>
              <h4>Revision de inventario aleatoria</h4>
              <p className="create-user__hint">
                Define cuantos productos debe revisar cada usuario por dia.
              </p>
            </div>
          </div>

          <div className="create-user__grid create-user__grid--two">
            <label className="create-user__field">
              <span>Productos por revision</span>
              <input
                type="number"
                min={MIN_RANDOM_INSPECTION_ITEMS_PER_DAY}
                max={MAX_RANDOM_INSPECTION_ITEMS_PER_DAY}
                step="1"
                value={randomInspectionItemsPerDay}
                onChange={(event) => setRandomInspectionItemsPerDay(event.target.value)}
                disabled={loading || saving}
              />
              <small>
                Rango permitido: {MIN_RANDOM_INSPECTION_ITEMS_PER_DAY} - {MAX_RANDOM_INSPECTION_ITEMS_PER_DAY}
              </small>
            </label>

            <div className="configuracion__preview">
              <span>Cantidad actual</span>
              <strong>{inspectionItemsPreview == null ? '-' : inspectionItemsPreview}</strong>
              <small>
                Se asignan {inspectionItemsPreview == null ? '0' : inspectionItemsPreview} productos por inspeccion diaria.
              </small>
            </div>
          </div>

          <div className="configuracion__actions">
            <button
              type="button"
              className="create-user__action create-user__action--primary"
              onClick={handleSaveInspectionItems}
              disabled={loading || saving}
            >
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </section>
      )}

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
