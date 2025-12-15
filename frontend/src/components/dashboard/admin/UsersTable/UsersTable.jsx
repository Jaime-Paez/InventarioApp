import { useEffect, useMemo, useState } from 'react'
import CreateUserModal from './CreateUserModal'
import './UsersTable.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const ALL_COLUMNS = [
  { key: 'codigo', label: 'Código' },
  { key: 'nombre', label: 'Nombre' },
  { key: 'pais', label: 'País' },
  { key: 'descripcion', label: 'Descripción' },
  { key: 'telefono', label: 'Teléfono' },
  { key: 'correo', label: 'Correo' },
]

const formatFullName = (user) =>
  [user?.nombres, user?.apellidos].filter(Boolean).join(' ').trim() || '—'

function UsersTable({ token }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [search, setSearch] = useState('')
  const [sortConfig, setSortConfig] = useState({ key: 'codigo', direction: 'asc' })
  const [selectedRows, setSelectedRows] = useState([])
  const [allSelected, setAllSelected] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)

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
    const fullName = formatFullName(createdUser)
    const passwordNote = createdUser?.password
      ? ` Clave temporal: ${createdUser.password}`
      : ''

    setStatusMessage(`${fullName} creado correctamente.${passwordNote}`)
    fetchUsers()
  }

  const filteredUsers = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return [...users]

    return users.filter((user) => {
      const name = formatFullName(user)
      const fields = [
        user.codigo || user.id,
        name,
        user.pais,
        user.descripcion || user.cargo,
        user.telefono,
        user.correo,
      ]
        .filter(Boolean)
        .map((field) => field.toString().toLowerCase())

      return fields.some((field) => field.includes(term))
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
      const mapValue = (user) => {
        switch (key) {
          case 'codigo':
            return user.codigo || user.id
          case 'nombre':
            return formatFullName(user)
          case 'pais':
            return user.pais
          case 'descripcion':
            return user.descripcion || user.cargo
          default:
            return user[key]
        }
      }

      const valueA = mapValue(a)
      const valueB = mapValue(b)

      if (valueA === undefined || valueA === null) return 1
      if (valueB === undefined || valueB === null) return -1

      return (
        String(valueA).localeCompare(String(valueB), 'es', { sensitivity: 'base' }) *
        (direction === 'asc' ? 1 : -1)
      )
    })
    return data
  }, [filteredUsers, sortConfig])

  const renderCell = (user, columnKey) => {
    switch (columnKey) {
      case 'codigo':
        return user.codigo || user.id || '—'
      case 'nombre':
        return formatFullName(user)
      case 'pais':
        return user.pais || '—'
      case 'descripcion':
        return user.descripcion || user.cargo || '—'
      case 'telefono':
        return user.telefono || '—'
      case 'correo':
        return user.correo || '—'
      default:
        return '—'
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
      <div className="users-table__toolbar">
        <div className="users-table__search">
          <span aria-hidden>🔍</span>
          <input
            id="users-search"
            type="search"
            placeholder="Buscar"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="users-table__toolbar-actions" aria-label="Acciones de tabla">
          <span className="toolbar-dot toolbar-dot--red" aria-hidden />
          <span className="toolbar-dot toolbar-dot--amber" aria-hidden />
          <span className="toolbar-dot toolbar-dot--green" aria-hidden />
          <button type="button" className="toolbar-button" onClick={fetchUsers} disabled={loading}>
            ⟳
          </button>
          <button type="button" className="toolbar-button primary" onClick={() => setShowCreateModal(true)}>
            +
          </button>
        </div>
      </div>

      <div className="users-table__meta">
        <div className="selection-info">{activeSelectionLabel}</div>
        <div className="table-meta">
          <span>{loading ? 'Cargando usuarios...' : `${sortedUsers.length} resultados`}</span>
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
              {ALL_COLUMNS.map((column) => (
                <th
                  key={column.key}
                  onClick={() => handleSort(column.key)}
                  className={sortConfig.key === column.key ? sortConfig.direction : ''}
                  scope="col"
                >
                  <span>{column.label}</span>
                  <span className="sort-icons" aria-hidden>
                    <span className="caret up" />
                    <span className="caret down" />
                  </span>
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
                  {ALL_COLUMNS.map((column) => (
                    <td key={column.key}>{renderCell(user, column.key)}</td>
                  ))}
                </tr>
              )
            })}

            {!sortedUsers.length && (
              <tr>
                <td colSpan={ALL_COLUMNS.length + 1} className="empty">
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
