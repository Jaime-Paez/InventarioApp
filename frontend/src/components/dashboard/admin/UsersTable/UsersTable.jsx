import { useEffect, useMemo, useState } from 'react'
import CreateUserModal from './CreateUserModal'
import './UsersTable.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const ALL_COLUMNS = [
  { key: 'nombres', label: 'Nombre' },
  { key: 'apellidos', label: 'Apellido' },
  { key: 'correo', label: 'Correo' },
  { key: 'telefono', label: 'Teléfono' },
  { key: 'cargo', label: 'Cargo' },
  { key: 'activo', label: 'Estado' },
  { key: 'roles', label: 'Roles' },
]

const formatRoles = (roles = []) =>
  roles.map((rol) => rol.nombre).filter(Boolean).join(', ') || 'Sin roles'

function UsersTable({ token }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [search, setSearch] = useState('')
  const [sortConfig, setSortConfig] = useState({ key: 'apellidos', direction: 'asc' })
  const [selectedRows, setSelectedRows] = useState([])
  const [allSelected, setAllSelected] = useState(false)
  const [showColumnPicker, setShowColumnPicker] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)

  const [selectedColumns, setSelectedColumns] = useState(() => {
    const stored = localStorage.getItem('users-table-columns')
    if (stored) {
      return JSON.parse(stored)
    }
    return ALL_COLUMNS
  })

  useEffect(() => {
    localStorage.setItem('users-table-columns', JSON.stringify(selectedColumns))
  }, [selectedColumns])

  const columnsToRender = useMemo(() => {
    return ALL_COLUMNS.filter((column) =>
      selectedColumns.some((selected) => selected.key === column.key)
    )
  }, [selectedColumns])

  const fetchUsers = async () => {
    setLoading(true)
    setError('')
    setStatusMessage('')
    try {
      const response = await fetch(`${API_URL}/usuarios/listado/`, {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Token ${token}` } : {}),
        },
      })

      if (!response.ok) {
        throw new Error('No se pudo obtener la lista de usuarios.')
      }

      const data = await response.json()
      setUsers(Array.isArray(data) ? data : data.results || [])
    } catch (err) {
      setError(err.message || 'Ocurrió un error al cargar los usuarios.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchUsers()
  }, [token])

  const handleUserCreated = (createdUser) => {
    setShowCreateModal(false)
    setStatusMessage(
      createdUser?.nombres
        ? `Usuario "${createdUser.nombres} ${createdUser.apellidos || ''}" creado correctamente.`
        : 'Usuario creado correctamente.'
    )
    fetchUsers()
  }

  const filteredUsers = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return [...users]

    return users.filter((user) => {
      const roleText = formatRoles(user.roles_detalle || [])
      return [
        user.nombres,
        user.apellidos,
        user.correo,
        user.telefono,
        user.cargo,
        roleText,
      ]
        .filter(Boolean)
        .some((field) => field.toString().toLowerCase().includes(term))
    })
  }, [search, users])

  const handleSort = (key) => {
    setSortConfig((prev) => {
      if (prev.key === key) {
        const nextDirection = prev.direction === 'asc' ? 'desc' : 'asc'
        return { key, direction: nextDirection }
      }
      return { key, direction: 'asc' }
    })
  }

  const toggleRowSelection = (id) => {
    setSelectedRows((prev) => {
      if (prev.includes(id)) {
        setAllSelected(false)
        return prev.filter((item) => item !== id)
      }
      return [...prev, id]
    })
  }

  const toggleAllRows = () => {
    setAllSelected((prev) => {
      const shouldSelectAll = !prev
      if (shouldSelectAll) {
        const ids = filteredUsers.map((user) => user.id)
        setSelectedRows(ids)
      } else {
        setSelectedRows([])
      }
      return shouldSelectAll
    })
  }

  useEffect(() => {
    if (!allSelected) return
    const filteredIds = filteredUsers.map((user) => user.id)
    setSelectedRows(filteredIds)
  }, [allSelected, filteredUsers])

  const sortedUsers = useMemo(() => {
    const data = [...filteredUsers]
    const { key, direction } = sortConfig
    data.sort((a, b) => {
      const valueA = key === 'roles' ? formatRoles(a.roles_detalle || []) : a[key]
      const valueB = key === 'roles' ? formatRoles(b.roles_detalle || []) : b[key]

      if (valueA === undefined || valueA === null) return 1
      if (valueB === undefined || valueB === null) return -1

      return String(valueA).localeCompare(String(valueB), 'es', { sensitivity: 'base' }) *
        (direction === 'asc' ? 1 : -1)
    })
    return data
  }, [filteredUsers, sortConfig])

  const handleColumnToggle = (column) => {
    setSelectedColumns((prev) => {
      const exists = prev.some((item) => item.key === column.key)
      if (exists) {
        return prev.filter((item) => item.key !== column.key)
      }
      return [...prev, column]
    })
  }

  const renderCell = (user, columnKey) => {
    switch (columnKey) {
      case 'activo':
        return user.activo ? 'Activo' : 'Inactivo'
      case 'roles':
        return formatRoles(user.roles_detalle || [])
      default:
        return user[columnKey] || '—'
    }
  }

  const activeSelectionLabel = useMemo(() => {
    if (allSelected) return 'Todos los resultados seleccionados'
    if (!selectedRows.length) return 'Ningún usuario seleccionado'
    if (selectedRows.length === 1) return '1 usuario seleccionado'
    return `${selectedRows.length} usuarios seleccionados`
  }, [allSelected, selectedRows])

  return (
    <div className="users-table">
      <header className="users-table__header">
        <div>
          <p className="users-table__eyebrow">Administración de usuarios</p>
          <h2>Usuarios del sistema</h2>
          <p className="users-table__description">
            Consulta y gestiona a todas las personas que tienen acceso a la plataforma.
          </p>
        </div>

        <div className="users-table__actions">
          <div className="users-table__primary-action">
            <button type="button" onClick={() => setShowCreateModal(true)}>
              + Crear usuario
            </button>
            <p className="users-table__hint">Añade nuevos usuarios con todos sus datos y roles.</p>
          </div>

          <div className="input-with-label">
            <label htmlFor="users-search">Búsqueda rápida</label>
            <input
              id="users-search"
              type="search"
              placeholder="Filtrar por nombre, correo o rol"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="button-row">
            <button type="button" className="ghost" onClick={() => setSearch('')}>
              Limpiar filtros
            </button>
            <button type="button" onClick={fetchUsers} disabled={loading}>
              {loading ? 'Actualizando...' : 'Refrescar'}
            </button>
            <div className="column-picker">
              <button
                type="button"
                className="ghost"
                onClick={() => setShowColumnPicker((value) => !value)}
              >
                Columnas
              </button>
              {showColumnPicker && (
                <div className="column-picker__panel">
                  {ALL_COLUMNS.map((column) => (
                    <label key={column.key}>
                      <input
                        type="checkbox"
                        checked={selectedColumns.some((item) => item.key === column.key)}
                        onChange={() => handleColumnToggle(column)}
                      />
                      {column.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="users-table__meta">
        <div className="selection-info">{activeSelectionLabel}</div>
        <div className="table-meta">
          <span>
            {loading ? 'Cargando usuarios...' : `${sortedUsers.length} resultados`}
          </span>
          {error && <span className="error">{error}</span>}
          {statusMessage && <span className="success">{statusMessage}</span>}
        </div>
      </div>

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th className="checkbox-cell">
                <input type="checkbox" checked={allSelected} onChange={toggleAllRows} />
              </th>
              {columnsToRender.map((column) => (
                <th
                  key={column.key}
                  onClick={() => handleSort(column.key)}
                  className={sortConfig.key === column.key ? sortConfig.direction : ''}
                  scope="col"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedUsers.map((user) => {
              const isSelected = allSelected || selectedRows.includes(user.id)
              return (
                <tr key={user.id} className={isSelected ? 'selected' : ''}>
                  <td className="checkbox-cell">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleRowSelection(user.id)}
                    />
                  </td>
                  {columnsToRender.map((column) => (
                    <td key={column.key}>{renderCell(user, column.key)}</td>
                  ))}
                </tr>
              )
            })}

            {!sortedUsers.length && (
              <tr>
                <td colSpan={columnsToRender.length + 1} className="empty">
                  {loading ? 'Cargando información...' : 'No se encontraron usuarios'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <CreateUserModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleUserCreated}
        token={token}
      />
    </div>
  )
}

export default UsersTable
