import { useEffect, useState } from 'react'
import './CreateUserModal.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const initialForm = {
  nombres: '',
  apellidos: '',
  correo: '',
  telefono: '',
  cargo: '',
  activo: true,
  roles: [],
}

function CreateUserModal({ open, onClose, onCreated, token }) {
  const [formData, setFormData] = useState(initialForm)
  const [roles, setRoles] = useState([])
  const [rolesLoading, setRolesLoading] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setError('')
    setFormData(initialForm)
    fetchRoles()
  }, [open])

  const fetchRoles = async () => {
    setRolesLoading(true)
    try {
      const response = await fetch(`${API_URL}/usuarios/roles/`, {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Token ${token}` } : {}),
        },
      })

      if (!response.ok) {
        throw new Error('No se pudieron cargar los roles disponibles.')
      }

      const data = await response.json()
      setRoles(Array.isArray(data) ? data : data.results || [])
    } catch (err) {
      setError(err.message || 'Ocurrió un problema al cargar los roles.')
    } finally {
      setRolesLoading(false)
    }
  }

  const handleChange = (event) => {
    const { name, value, type, checked } = event.target
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  const handleToggleRole = (roleId) => {
    setFormData((prev) => {
      const exists = prev.roles.includes(roleId)
      const roles = exists ? prev.roles.filter((id) => id !== roleId) : [...prev.roles, roleId]
      return { ...prev, roles }
    })
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)
    setError('')

    const payload = {
      ...formData,
      nombres: formData.nombres.trim(),
      apellidos: formData.apellidos.trim(),
      correo: formData.correo.trim().toLowerCase(),
      telefono: formData.telefono.trim(),
      cargo: formData.cargo.trim(),
    }

    if (!payload.nombres || !payload.apellidos || !payload.correo) {
      setLoading(false)
      setError('Completa los campos de nombres, apellidos y correo para continuar.')
      return
    }

    try {
      const response = await fetch(`${API_URL}/usuarios/listado/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Token ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        const detail =
          data?.detail ||
          data?.correo?.[0] ||
          data?.nombres?.[0] ||
          'No se pudo crear el usuario. Verifica la información enviada.'
        throw new Error(detail)
      }

      setFormData(initialForm)
      onCreated?.(data)
    } catch (err) {
      setError(err.message || 'Ocurrió un error al crear el usuario.')
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <div className="create-user__overlay" role="dialog" aria-modal="true">
      <div className="create-user__modal">
        <header className="create-user__header">
          <div>
            <p className="create-user__eyebrow">Nuevo usuario</p>
            <h3>Crear cuenta interna</h3>
            <p className="create-user__subtitle">
              Completa la información requerida para registrar a la persona en el sistema.
            </p>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            Cerrar
          </button>
        </header>

        <form className="create-user__form" onSubmit={handleSubmit}>
          <div className="create-user__grid">
            <label className="create-user__field">
              <span>Nombres</span>
              <input
                name="nombres"
                type="text"
                placeholder="Ana María"
                value={formData.nombres}
                onChange={handleChange}
                required
              />
            </label>

            <label className="create-user__field">
              <span>Apellidos</span>
              <input
                name="apellidos"
                type="text"
                placeholder="Pérez Ruiz"
                value={formData.apellidos}
                onChange={handleChange}
                required
              />
            </label>

            <label className="create-user__field">
              <span>Correo</span>
              <input
                name="correo"
                type="email"
                placeholder="usuario@empresa.com"
                value={formData.correo}
                onChange={handleChange}
                required
              />
            </label>

            <label className="create-user__field">
              <span>Teléfono</span>
              <input
                name="telefono"
                type="tel"
                placeholder="099 999 9999"
                value={formData.telefono}
                onChange={handleChange}
              />
            </label>

            <label className="create-user__field">
              <span>Cargo</span>
              <input
                name="cargo"
                type="text"
                placeholder="Coordinador de inventario"
                value={formData.cargo}
                onChange={handleChange}
              />
            </label>

            <label className="create-user__checkbox">
              <input
                type="checkbox"
                name="activo"
                checked={formData.activo}
                onChange={handleChange}
              />
              <div>
                <span>Cuenta activa</span>
                <p>El usuario podrá iniciar sesión y operar el sistema.</p>
              </div>
            </label>
          </div>

          <div className="create-user__roles">
            <div className="create-user__roles-header">
              <div>
                <span>Roles</span>
                <p>Selecciona uno o más roles para definir los permisos.</p>
              </div>
              {rolesLoading && <small className="muted">Cargando roles...</small>}
            </div>

            <div className="create-user__roles-list">
              {!rolesLoading && !roles.length && (
                <p className="muted">No hay roles configurados todavía.</p>
              )}

              {roles.map((role) => (
                <label key={role.id} className="create-user__chip">
                  <input
                    type="checkbox"
                    checked={formData.roles.includes(role.id)}
                    onChange={() => handleToggleRole(role.id)}
                  />
                  <span>{role.nombre}</span>
                </label>
              ))}
            </div>
          </div>

          {error && <p className="create-user__error">{error}</p>}

          <div className="create-user__footer">
            <button type="button" className="ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" disabled={loading}>
              {loading ? 'Guardando...' : 'Crear usuario'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default CreateUserModal
