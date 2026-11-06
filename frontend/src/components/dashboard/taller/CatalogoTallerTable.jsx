import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Button } from 'primereact/button'
import Toast from '../common/AppToast'
import MoneyInput from '../common/MoneyInput'
import BlockerNotice from '../common/BlockerNotice'
import ConfirmDialog from '../common/unsavedChanges/ConfirmDialog'
import TallerDialog from './TallerDialog'
import '../admin/UsersTable/UsersTable.css'
import '../admin/CreateUsuario/CreateUsuario.css'
import './Taller.css'
import { API_URL, authFetch } from '../../../utils/api'
import { parseApiError } from './tallerConstants'

const SEARCH_DELAY_MS = 300

const normalize = (value) =>
  String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

// Tabla de catalogo del taller (Tecnicos, Mano de obra) con el mismo estilo
// que las demas tablas: buscador con debounce, crear, doble clic para editar.
// `config.fields`: [{ key, label, type: 'text'|'money', required, placeholder }]
function CatalogoTallerTable({ token, moduleActions, config }) {
  const toast = useRef(null)
  const canCreate = moduleActions?.puede_crear ?? true
  const canEdit = moduleActions?.puede_actualizar ?? true
  const canDelete = moduleActions?.puede_eliminar ?? true
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [verInactivos, setVerInactivos] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [toDelete, setToDelete] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await authFetch(`${API_URL}${config.endpoint}`, {}, token)
      if (!response.ok) throw new Error(await parseApiError(response, `No se pudo cargar ${config.plural}.`))
      const data = await response.json()
      setRows(Array.isArray(data) ? data : data?.results || [])
      setError('')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [config.endpoint, config.plural, token])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(normalize(search.trim())), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [search])

  const visibles = useMemo(() => rows.filter((row) => {
    if (!verInactivos && !row.activo) return false
    if (!debounced) return true
    return config.fields.some((f) => normalize(row[f.key]).includes(debounced))
  }), [config.fields, debounced, rows, verInactivos])

  const openForm = (row) => {
    if (row ? !canEdit : !canCreate) return
    const initial = { activo: true }
    config.fields.forEach((f) => {
      initial[f.key] = row ? (f.type === 'money' ? Number(row[f.key] || 0) : row[f.key] || '') : (f.type === 'money' ? null : '')
    })
    if (row) initial.activo = row.activo
    setForm(initial)
    setFormError('')
    setEditing(row || 'new')
  }

  const motivo = config.fields.filter((f) => f.required).find((f) => !String(form[f.key] ?? '').trim())
  const submit = async () => {
    if (motivo) return
    setSaving(true)
    setFormError('')
    try {
      const body = { activo: form.activo }
      config.fields.forEach((f) => {
        body[f.key] = f.type === 'money' ? Number(form[f.key] || 0).toFixed(2) : String(form[f.key] || '').trim()
      })
      const isNew = editing === 'new'
      const response = await authFetch(
        `${API_URL}${config.endpoint}${isNew ? '' : `${editing.id}/`}`,
        { method: isNew ? 'POST' : 'PATCH', body: JSON.stringify(body) },
        token
      )
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo guardar.'))
      toast.current?.show({ severity: 'success', summary: config.title, detail: isNew ? 'Creado.' : 'Guardado.', life: 2500 })
      setEditing(null)
      load()
    } catch (err) {
      setFormError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    const row = toDelete
    setSaving(true)
    try {
      const response = await authFetch(`${API_URL}${config.endpoint}${row.id}/`, { method: 'DELETE' }, token)
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo eliminar.'))
      toast.current?.show({
        severity: 'info',
        summary: config.title,
        detail: response.status === 204 ? 'Eliminado.' : 'Ya se usó en órdenes: quedó inactivo en vez de borrarse.',
        life: 3500,
      })
      setToDelete(null)
      load()
    } catch (err) {
      toast.current?.show({ severity: 'error', summary: config.title, detail: err.message, life: 5000 })
    } finally {
      setSaving(false)
    }
  }

  const header = (
    <div className="users-header">
      <div className="users-header__left">
        <div className="search-input-container">
          <input type="text" value={search} onChange={(event) => setSearch(event.target.value)} className="search-input" placeholder="Buscar en tabla" />
          <i className="pi pi-search search-input-icon" />
        </div>
        <button className="rounded-icon-btn" type="button" onClick={load} disabled={loading} title="Recargar">
          <i className="pi pi-refresh" />
        </button>
        <button className={`taller-toggle${verInactivos ? ' is-active' : ''}`} type="button" onClick={() => setVerInactivos((v) => !v)}>
          Ver inactivos
        </button>
      </div>
      <div className="users-header__right">
        <span className="users-header__count">Reg. {visibles.length}</span>
      </div>
    </div>
  )

  return (
    <div className="users-page taller-page">
      <Toast ref={toast} />
      <div className="users-page__top">
        <div className="users-page__actions">
          {canCreate && (
            <Button label="Crear" icon="pi pi-plus" className="users-topbtn users-topbtn--create" onClick={() => openForm(null)} type="button" />
          )}
        </div>
      </div>

      <div className="users-table users-table--card users-table--compact">
        {error && <BlockerNotice title={`No se pudo cargar ${config.plural}`} reason={error} actionLabel="Reintentar" onAction={load} />}
        <DataTable
          value={visibles}
          dataKey="id"
          header={header}
          className={`users-datatable users-datatable--compact${loading ? ' users-datatable--loading-content' : ''}`}
          tableStyle={{ width: '100%' }}
          emptyMessage={rows.length ? 'Ninguno coincide.' : config.empty}
          showGridlines
          size="small"
          scrollable
          scrollHeight="flex"
          paginator
          rows={25}
          rowsPerPageOptions={[10, 25, 50, 100]}
          removableSort
          onRowDoubleClick={(event) => openForm(event.data)}
          rowClassName={(row) => `taller-row${row.activo ? '' : ' taller-row--inactive'}`}
        >
          {config.columns.map((col) => (
            <Column key={col.field} field={col.field} header={col.header} sortable body={col.body} style={col.style} />
          ))}
          <Column
            field="activo"
            header="Estado"
            sortable
            body={(row) => <span className={`taller-chip taller-chip--${row.activo ? 'orden' : 'cerrada'}`}>{row.activo ? 'Activo' : 'Inactivo'}</span>}
            style={{ width: 110 }}
          />
          <Column
            header=""
            body={(row) => (
              <span className="taller-row-actions">
                {canEdit && <button type="button" className="taller-open-btn" onClick={() => openForm(row)}>Editar</button>}
                {canDelete && row.activo && (
                  <button type="button" className="taller-icon-btn taller-icon-btn--no" onClick={() => setToDelete(row)} title="Eliminar (si ya se usó, solo se desactiva)">
                    <i className="pi pi-trash" />
                  </button>
                )}
              </span>
            )}
            style={{ width: 120 }}
          />
        </DataTable>
      </div>

      <TallerDialog
        open={Boolean(editing)}
        busy={saving}
        title={editing === 'new' ? `Nuevo ${config.singular}` : `Editar ${config.singular}`}
        onClose={() => setEditing(null)}
        footer={
          <>
            {motivo && <span className="taller-muted taller-dialog__why">{`Falta: ${motivo.label}.`}</span>}
            <button type="button" className="create-user__action create-user__action--cancel" onClick={() => setEditing(null)} disabled={saving}>Cancelar</button>
            <button type="button" className="create-user__action create-user__action--primary" onClick={submit} disabled={saving || Boolean(motivo)}>
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </>
        }
      >
        <div className="taller-dialog__grid">
          {config.fields.map((f) => (
            <label key={f.key} className={`create-user__field${f.full ? ' taller-field--full' : ''}`}>
              <span>{f.label}</span>
              {f.type === 'money' ? (
                <MoneyInput className="taller-input" value={form[f.key]} onValueChange={(value) => setForm((prev) => ({ ...prev, [f.key]: value }))} />
              ) : (
                <input
                  className="taller-input"
                  value={form[f.key] ?? ''}
                  placeholder={f.placeholder}
                  autoFocus={f === config.fields[0]}
                  onChange={(event) => setForm((prev) => ({ ...prev, [f.key]: event.target.value }))}
                />
              )}
            </label>
          ))}
          {editing !== 'new' && (
            <label className="taller-switch">
              <input type="checkbox" checked={Boolean(form.activo)} onChange={(event) => setForm((prev) => ({ ...prev, activo: event.target.checked }))} />
              <span>{form.activo ? 'Activo' : 'Inactivo'}</span>
            </label>
          )}
        </div>
        {formError && <BlockerNotice title="No se guardó" reason={formError} />}
      </TallerDialog>

      <ConfirmDialog
        open={Boolean(toDelete)}
        busy={saving}
        title={`¿Eliminar ${toDelete?.nombre || ''}?`}
        message="Si ya se usó en alguna orden, queda inactivo para no perder el historial."
        confirmLabel="Eliminar"
        onCancel={() => setToDelete(null)}
        onConfirm={remove}
      />
    </div>
  )
}

export default CatalogoTallerTable
