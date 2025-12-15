import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordCopied, setPasswordCopied] = useState(false)
  const [roles, setRoles] = useState([])
  const [rolesLoading, setRolesLoading] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const modalRef = useRef(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })

  const fetchRoles = useCallback(async () => {
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
  }, [token])

  useEffect(() => {
    if (!open) return
    setError('')
    setFormData(initialForm)
    setPassword('')
    setConfirmPassword('')
    setPasswordCopied(false)
    fetchRoles()
  }, [open, fetchRoles])

  useLayoutEffect(() => {
    if (!open || !modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    const centeredX = (window.innerWidth - rect.width) / 2
    const centeredY = (window.innerHeight - rect.height) / 2
    setPosition({ x: Math.max(centeredX, 12), y: Math.max(centeredY, 12) })
  }, [open])

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

    if (!password || password.length < 8) {
      setLoading(false)
      setError('Define una contraseña de al menos 8 caracteres para el usuario.')
      return
    }

    if (password !== confirmPassword) {
      setLoading(false)
      setError('La confirmación de contraseña no coincide.')
      return
    }

    try {
      const registerResponse = await fetch(`${API_URL}/auth/register/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Token ${token}` } : {}),
        },
        body: JSON.stringify({
          first_name: payload.nombres,
          last_name: payload.apellidos,
          email: payload.correo,
          password,
        }),
      })

      const registerData = await registerResponse.json().catch(() => ({}))
      if (!registerResponse.ok) {
        const detail =
          registerData?.detail ||
          registerData?.email?.[0] ||
          registerData?.password?.[0] ||
          'No se pudo crear la cuenta de acceso. Verifica la información enviada.'
        throw new Error(detail)
      }

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
      setPassword('')
      setConfirmPassword('')
      setPasswordCopied(false)
      onCreated?.({ ...data, password })
    } catch (err) {
      setError(err.message || 'Ocurrió un error al crear el usuario.')
    } finally {
      setLoading(false)
    }
  }

  const handleMouseDown = (event) => {
    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    dragData.current = {
      active: true,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
  }

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!dragData.current.active) return
      event.preventDefault()
      const newX = event.clientX - dragData.current.offsetX
      const newY = event.clientY - dragData.current.offsetY
      const maxX = window.innerWidth - (modalRef.current?.offsetWidth || 0) - 12
      const maxY = window.innerHeight - (modalRef.current?.offsetHeight || 0) - 12
      setPosition({
        x: Math.min(Math.max(newX, 12), Math.max(maxX, 12)),
        y: Math.min(Math.max(newY, 12), Math.max(maxY, 12)),
      })
    }

    const handleMouseUp = () => {
      dragData.current.active = false
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const generatePassword = () => {
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789!@$%#?'
    let result = ''
    for (let i = 0; i < 12; i += 1) {
      result += charset.charAt(Math.floor(Math.random() * charset.length))
    }
    setPassword(result)
    setConfirmPassword(result)
    setPasswordCopied(false)
  }

  const copyPassword = async () => {
    if (!password) return
    try {
      await navigator.clipboard.writeText(password)
      setPasswordCopied(true)
      setTimeout(() => setPasswordCopied(false), 2500)
    } catch {
      setError('No se pudo copiar la contraseña. Intenta nuevamente.')
    }
  }

  if (!open) return null

  return (
    <div className="create-user__overlay" role="dialog" aria-modal="true">
      <div
        className="create-user__modal"
        ref={modalRef}
        style={{ top: position.y, left: position.x }}
      >
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div>
            <p className="create-user__eyebrow">Nuevo usuario</p>
            <h3>Crear cuenta interna</h3>
            <p className="create-user__subtitle">
              Completa la información requerida para registrar a la persona en el sistema.
            </p>
          </div>
          <button
            type="button"
            className="ghost"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClose}
          >
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

            <label className="create-user__field create-user__field--password">
              <div className="create-user__field-label">
                <span>Contraseña</span>
                <div className="create-user__password-actions">
                  <button type="button" className="ghost" onClick={generatePassword}>
                    Generar
                  </button>
                  <button type="button" className="ghost" onClick={copyPassword}>
                    {passwordCopied ? 'Copiada' : 'Copiar'}
                  </button>
                </div>
              </div>
              <input
                name="password"
                type="text"
                placeholder="Contraseña temporal"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <small>Se enviará esta clave para que el usuario pueda iniciar sesión.</small>
            </label>

            <label className="create-user__field">
              <span>Confirmar contraseña</span>
              <input
                name="confirmPassword"
                type="text"
                placeholder="Repite la contraseña"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
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
