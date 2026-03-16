import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, Info, Pencil } from 'lucide-react'
import '../CreateUsuario/CreateUsuario.css'
import './UsersDetails.css'
import { API_URL, authFetch } from '../../../../utils/api'
import useModalAnimation from '../../common/useModalAnimation'
const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12
const ACTIONS = [
  { key: 'puede_leer', label: 'Ver' },
  { key: 'puede_crear', label: 'Crear' },
  { key: 'puede_actualizar', label: 'Editar' },
  { key: 'puede_eliminar', label: 'Eliminar' },
]
const INVENTORY_MODULE_KEY = 'inventario'
const BRANCH_SCOPED_MODULE_KEYS = new Set([
  'movimientos_entradas',
  'movimientos_salidas',
  'productos',
  'solicitudes',
])
const normalizeModuleKey = (value) => String(value || '').trim().toLowerCase()

const isActionAllowedForModule = (moduleKey, actionKey) =>
  moduleKey === INVENTORY_MODULE_KEY ? actionKey === 'puede_leer' : true

const getAllowedActionsForModule = (moduleKey) =>
  ACTIONS.filter((action) => isActionAllowedForModule(moduleKey, action.key))

const createPermissionEntry = () => ({
  puede_crear: false,
  puede_leer: false,
  puede_actualizar: false,
  puede_eliminar: false,
})

const EMPTY_PERMISSION_ENTRY = Object.freeze(createPermissionEntry())
const FULL_PERMISSION_ENTRY = Object.freeze({
  puede_crear: true,
  puede_leer: true,
  puede_actualizar: true,
  puede_eliminar: true,
})

const normalizeBranchId = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const buildAllowedPermissionEntry = (moduleKey, sourceEntry = null) => {
  const normalizedEntry = createPermissionEntry()
  const allowedActionKeys = new Set(getAllowedActionsForModule(moduleKey).map((action) => action.key))
  ACTIONS.forEach((action) => {
    if (!allowedActionKeys.has(action.key)) return
    normalizedEntry[action.key] = Boolean(sourceEntry?.[action.key])
  })
  return normalizedEntry
}

const applyPermissionDependencies = (moduleKey, sourceEntry = null) => {
  const allowedActionKeys = new Set(getAllowedActionsForModule(moduleKey).map((action) => action.key))
  const nextEntry = buildAllowedPermissionEntry(moduleKey, sourceEntry)

  if (allowedActionKeys.has('puede_eliminar') && nextEntry.puede_eliminar) {
    if (allowedActionKeys.has('puede_crear')) nextEntry.puede_crear = true
    if (allowedActionKeys.has('puede_actualizar')) nextEntry.puede_actualizar = true
  }

  if (allowedActionKeys.has('puede_leer')) {
    if (nextEntry.puede_crear || nextEntry.puede_actualizar || nextEntry.puede_eliminar) {
      nextEntry.puede_leer = true
    }
    if (!nextEntry.puede_leer) {
      if (allowedActionKeys.has('puede_crear')) nextEntry.puede_crear = false
      if (allowedActionKeys.has('puede_actualizar')) nextEntry.puede_actualizar = false
      if (allowedActionKeys.has('puede_eliminar')) nextEntry.puede_eliminar = false
    }
  }

  return nextEntry
}

const normalizePermissionEntry = (moduleKey, currentEntry, actionKey, nextChecked) => {
  const allowedActionKeys = new Set(getAllowedActionsForModule(moduleKey).map((action) => action.key))
  const nextEntry = applyPermissionDependencies(moduleKey, currentEntry)
  if (!allowedActionKeys.has(actionKey)) return nextEntry
  const normalizedChecked = Boolean(nextChecked)
  nextEntry[actionKey] = normalizedChecked

  if (actionKey === 'puede_leer' && !normalizedChecked) {
    if (allowedActionKeys.has('puede_crear')) nextEntry.puede_crear = false
    if (allowedActionKeys.has('puede_actualizar')) nextEntry.puede_actualizar = false
    if (allowedActionKeys.has('puede_eliminar')) nextEntry.puede_eliminar = false
  }

  return applyPermissionDependencies(moduleKey, nextEntry)
}

const hasAnyAllowedActionEnabled = (moduleKey, entry) =>
  getAllowedActionsForModule(moduleKey).some((action) => Boolean(entry?.[action.key]))

const getBranchPermissionEntry = (matrix, moduleKey, branchId) => {
  const normalizedModuleKey = normalizeModuleKey(moduleKey)
  const normalizedBranchId = normalizeBranchId(branchId)
  if (!normalizedModuleKey || !normalizedBranchId) return EMPTY_PERMISSION_ENTRY

  const moduleBranches = matrix?.[normalizedModuleKey]
  if (!moduleBranches || typeof moduleBranches !== 'object') return EMPTY_PERMISSION_ENTRY
  return moduleBranches[String(normalizedBranchId)] || EMPTY_PERMISSION_ENTRY
}

const buildAdministratorPermissionState = (modules = [], scopedModules = [], branchList = []) => {
  const scopedSet = new Set(
    (Array.isArray(scopedModules) ? scopedModules : [])
      .map((moduleKey) => normalizeModuleKey(moduleKey))
      .filter(Boolean)
  )
  const globalMatrix = {}
  const branchMatrix = {}

  ;(Array.isArray(modules) ? modules : []).forEach((module) => {
    const moduleKey = normalizeModuleKey(module?.key)
    if (!moduleKey) return

    const fullEntry = applyPermissionDependencies(moduleKey, FULL_PERMISSION_ENTRY)
    if (!hasAnyAllowedActionEnabled(moduleKey, fullEntry)) return

    if (scopedSet.has(moduleKey)) {
      const branchEntries = {}
      ;(Array.isArray(branchList) ? branchList : []).forEach((branch) => {
        const branchId = normalizeBranchId(branch?.id)
        if (!branchId) return
        branchEntries[String(branchId)] = { ...fullEntry }
      })
      if (Object.keys(branchEntries).length) branchMatrix[moduleKey] = branchEntries
      return
    }

    globalMatrix[moduleKey] = fullEntry
  })

  return { globalMatrix, branchMatrix }
}

const buildEffectivePermissionsMatrix = (globalMatrix, branchMatrix, scopedModules = []) => {
  const nextMatrix = { ...globalMatrix }

  ;(Array.isArray(scopedModules) ? scopedModules : []).forEach((moduleKey) => {
    const normalizedModuleKey = normalizeModuleKey(moduleKey)
    if (!normalizedModuleKey) return

    const mergedEntry = createPermissionEntry()
    const moduleBranches = branchMatrix?.[normalizedModuleKey]
    Object.values(moduleBranches || {}).forEach((branchEntry) => {
      const normalizedBranchEntry = applyPermissionDependencies(normalizedModuleKey, branchEntry)
      getAllowedActionsForModule(normalizedModuleKey).forEach((action) => {
        if (normalizedBranchEntry[action.key]) mergedEntry[action.key] = true
      })
    })

    const normalizedMergedEntry = applyPermissionDependencies(normalizedModuleKey, mergedEntry)
    if (hasAnyAllowedActionEnabled(normalizedModuleKey, normalizedMergedEntry)) {
      nextMatrix[normalizedModuleKey] = normalizedMergedEntry
    } else {
      delete nextMatrix[normalizedModuleKey]
    }
  })

  return nextMatrix
}

const normalizeIdentityValue = (value) => String(value || '').trim().toLowerCase()

const buildMatrixFromList = (permisos = []) => {
  const matrix = {}
  permisos.forEach((permiso) => {
    if (!permiso?.modulo) return
    const modulo = normalizeModuleKey(permiso.modulo)
    if (!modulo) return
    matrix[modulo] = applyPermissionDependencies(modulo, {
      puede_crear: isActionAllowedForModule(modulo, 'puede_crear') ? Boolean(permiso.puede_crear) : false,
      puede_leer: isActionAllowedForModule(modulo, 'puede_leer') ? Boolean(permiso.puede_leer) : false,
      puede_actualizar: isActionAllowedForModule(modulo, 'puede_actualizar') ? Boolean(permiso.puede_actualizar) : false,
      puede_eliminar: isActionAllowedForModule(modulo, 'puede_eliminar') ? Boolean(permiso.puede_eliminar) : false,
    })
  })
  return matrix
}

const serializeMatrix = (matrix) =>
  Object.entries(matrix)
    .map(([modulo, value]) => {
      const allowedActions = getAllowedActionsForModule(modulo)
      const payload = {
        modulo,
        submodulo: '',
        puede_crear: isActionAllowedForModule(modulo, 'puede_crear') ? Boolean(value?.puede_crear) : false,
        puede_leer: isActionAllowedForModule(modulo, 'puede_leer') ? Boolean(value?.puede_leer) : false,
        puede_actualizar: isActionAllowedForModule(modulo, 'puede_actualizar') ? Boolean(value?.puede_actualizar) : false,
        puede_eliminar: isActionAllowedForModule(modulo, 'puede_eliminar') ? Boolean(value?.puede_eliminar) : false,
      }
      const hasAction = allowedActions.some((action) => payload[action.key])
      return hasAction ? payload : null
    })
    .filter(Boolean)

const buildModuleBranchMatrixFromList = (scopes = [], basePermissions = {}) => {
  const matrix = {}
  scopes.forEach((scope) => {
    if (!scope?.modulo) return
    const modulo = normalizeModuleKey(scope.modulo)
    if (!modulo) return

    const nextModuleScopes = {}
    const actionByBranch = Array.isArray(scope?.acciones_por_sucursal) ? scope.acciones_por_sucursal : []

    actionByBranch.forEach((branchScope) => {
      const branchId = normalizeBranchId(branchScope?.sucursal_id ?? branchScope?.id)
      if (!branchId) return
      const normalizedEntry = applyPermissionDependencies(modulo, branchScope)
      if (!hasAnyAllowedActionEnabled(modulo, normalizedEntry)) return
      nextModuleScopes[String(branchId)] = normalizedEntry
    })

    if (!Object.keys(nextModuleScopes).length) {
      const fallbackEntry = applyPermissionDependencies(
        modulo,
        basePermissions?.[modulo] || EMPTY_PERMISSION_ENTRY
      )
      if (hasAnyAllowedActionEnabled(modulo, fallbackEntry)) {
        const ids = Array.isArray(scope?.sucursales_ids) ? scope.sucursales_ids : []
        Array.from(new Set(ids.map((id) => Number(id)).filter(Number.isFinite))).forEach((branchId) => {
          nextModuleScopes[String(branchId)] = { ...fallbackEntry }
        })
      }
    }

    if (Object.keys(nextModuleScopes).length) matrix[modulo] = nextModuleScopes
  })
  return matrix
}

const serializeModuleBranchMatrix = (matrix, allowedModules = []) => {
  const allowedSet = Array.isArray(allowedModules) && allowedModules.length > 0
    ? new Set(allowedModules.map((moduleKey) => normalizeModuleKey(moduleKey)).filter(Boolean))
    : null

  return Object.entries(matrix)
    .filter(([modulo]) => !allowedSet || allowedSet.has(normalizeModuleKey(modulo)))
    .map(([modulo, branchScopes]) => {
      const acciones_por_sucursal = Object.entries(branchScopes || {})
        .map(([branchId, rawEntry]) => {
          const normalizedBranchId = normalizeBranchId(branchId)
          if (!normalizedBranchId) return null
          const normalizedEntry = applyPermissionDependencies(modulo, rawEntry)
          if (!hasAnyAllowedActionEnabled(modulo, normalizedEntry)) return null
          return {
            sucursal_id: normalizedBranchId,
            ...normalizedEntry,
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.sucursal_id - b.sucursal_id)

      if (!acciones_por_sucursal.length) return null
      return {
        modulo,
        sucursales_ids: acciones_por_sucursal.map((entry) => entry.sucursal_id),
        acciones_por_sucursal,
      }
    })
    .filter(Boolean)
}

const emptyForm = {
  nombres: '',
  apellidos: '',
  correo: '',
  telefono: '',
  cargo: '',
  activo: false,
  es_administrador: false,
  permisos_personalizados: [],
  sucursales: [],
  sucursales_por_modulo: [],
  roles: [],
}

function UsersDetails({
  open,
  userId,
  token,
  onClose,
  onUpdated,
  onDeleted,
  onError,
  allowEdit = true,
  allowDelete = true,
}) {
  const [formData, setFormData] = useState(emptyForm)
  const [originalData, setOriginalData] = useState(emptyForm)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordCopied, setPasswordCopied] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [permissionOptions, setPermissionOptions] = useState([])
  const [permissionsMatrix, setPermissionsMatrix] = useState({})
  const [moduleBranchMatrix, setModuleBranchMatrix] = useState({})
  const [branchScopedModules, setBranchScopedModules] = useState([])
  const [permissionsLoading, setPermissionsLoading] = useState(false)
  const [branches, setBranches] = useState([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [loadingData, setLoadingData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [selectedBranchId, setSelectedBranchId] = useState(null)
  const [showPermissionsPopup, setShowPermissionsPopup] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const sizeRef = useRef(size)
  const positionRef = useRef(position)
  const restoreRef = useRef(null)

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
  const getViewportMetrics = () => {
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    return {
      availableWidth,
      availableHeight,
      minWidth: Math.min(MIN_WIDTH, availableWidth),
      minHeight: Math.min(MIN_HEIGHT, availableHeight),
    }
  }
  const notifyError = useCallback(
    (message) => {
      if (!message) return
      if (onError) {
        onError(message)
        return
      }
      console.error(message)
    },
    [onError]
  )
  const isAdministrator = Boolean(formData.es_administrador)

  const normalizeUser = (data) => ({
    nombres: data?.nombres ?? '',
    apellidos: data?.apellidos ?? '',
    correo: data?.correo ?? '',
    telefono: data?.telefono ?? '',
    cargo: data?.cargo ?? '',
    activo: Boolean(data?.activo),
    es_administrador: Boolean(data?.es_administrador),
    permisos_personalizados: Array.isArray(data?.permisos_personalizados)
      ? data.permisos_personalizados
      : [],
    sucursales: Array.isArray(data?.sucursales) ? data.sucursales : [],
    sucursales_por_modulo: Array.isArray(data?.sucursales_por_modulo)
      ? data.sucursales_por_modulo
      : [],
  })

  const handleChange = (event) => {
    if (!isEditing) return
    const { name, value, type, checked } = event.target
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  const isActionBranchScoped = useCallback(
    (moduleKey) => {
      const normalizedModuleKey = normalizeModuleKey(moduleKey)
      return branchScopedModules.includes(normalizedModuleKey)
    },
    [branchScopedModules]
  )

  useEffect(() => {
    if (!isAdministrator) return
    const { globalMatrix, branchMatrix } = buildAdministratorPermissionState(
      permissionOptions,
      branchScopedModules,
      branches
    )
    setPermissionsMatrix(globalMatrix)
    setModuleBranchMatrix(branchMatrix)
    setSelectedBranchId((prev) => {
      const normalizedPrev = normalizeBranchId(prev)
      if (normalizedPrev && branches.some((branch) => normalizeBranchId(branch?.id) === normalizedPrev)) {
        return normalizedPrev
      }
      return normalizeBranchId(branches?.[0]?.id)
    })
  }, [isAdministrator, permissionOptions, branchScopedModules, branches])

  const togglePermissionForBranch = (moduleKey, actionKey) => {
    if (isAdministrator) return
    const normalizedModuleKey = normalizeModuleKey(moduleKey)
    if (!isActionAllowedForModule(moduleKey, actionKey)) return
    const moduleUsesBranchScope = isActionBranchScoped(moduleKey)
    if (!isEditing) return

    if (!moduleUsesBranchScope) {
      setPermissionsMatrix((prevPermissions) => {
        const current = prevPermissions[normalizedModuleKey] || EMPTY_PERMISSION_ENTRY
        const updatedEntry = normalizePermissionEntry(moduleKey, current, actionKey, !current[actionKey])
        if (!hasAnyAllowedActionEnabled(moduleKey, updatedEntry)) {
          const { [normalizedModuleKey]: _ignored, ...restPermissions } = prevPermissions
          return restPermissions
        }
        return {
          ...prevPermissions,
          [normalizedModuleKey]: updatedEntry,
        }
      })
      return
    }

    const normalizedBranchId = normalizeBranchId(selectedBranchId)
    if (!normalizedBranchId) return

    setModuleBranchMatrix((prevScopes) => {
      const moduleScopes = prevScopes[normalizedModuleKey]
      const nextModuleScopes = moduleScopes && typeof moduleScopes === 'object'
        ? { ...moduleScopes }
        : {}

      const branchKey = String(normalizedBranchId)
      const current = nextModuleScopes[branchKey] || EMPTY_PERMISSION_ENTRY
      const updatedEntry = normalizePermissionEntry(moduleKey, current, actionKey, !current[actionKey])

      if (hasAnyAllowedActionEnabled(moduleKey, updatedEntry)) {
        nextModuleScopes[branchKey] = updatedEntry
      } else {
        delete nextModuleScopes[branchKey]
      }

      if (!Object.keys(nextModuleScopes).length) {
        if (!(normalizedModuleKey in prevScopes)) return prevScopes
        const { [normalizedModuleKey]: _ignored, ...rest } = prevScopes
        return rest
      }

      return { ...prevScopes, [normalizedModuleKey]: nextModuleScopes }
    })
  }

  const setColumnPermission = (actionKey, checked, modules = permissionOptions) => {
    if (isAdministrator) return
    if (!isEditing) return

    let nextPermissions = { ...permissionsMatrix }
    let nextModuleBranchMatrix = { ...moduleBranchMatrix }
    let changed = false
    const normalizedBranchId = normalizeBranchId(selectedBranchId)

    modules.forEach((module) => {
      const moduleKey = normalizeModuleKey(module?.key)
      if (!isActionAllowedForModule(moduleKey, actionKey)) return

      const moduleUsesBranchScope = isActionBranchScoped(moduleKey)
      if (moduleUsesBranchScope && !normalizedBranchId) return

      if (!moduleUsesBranchScope) {
        const current = nextPermissions[moduleKey] || EMPTY_PERMISSION_ENTRY
        const currentlyChecked = Boolean(current[actionKey])
        if (currentlyChecked === checked) return

        const updatedEntry = normalizePermissionEntry(moduleKey, current, actionKey, checked)
        if (hasAnyAllowedActionEnabled(moduleKey, updatedEntry)) nextPermissions[moduleKey] = updatedEntry
        else delete nextPermissions[moduleKey]
        changed = true
        return
      }

      const moduleScopes = nextModuleBranchMatrix[moduleKey]
      const nextModuleScopes = moduleScopes && typeof moduleScopes === 'object'
        ? { ...moduleScopes }
        : {}

      const branchKey = String(normalizedBranchId)
      const current = nextModuleScopes[branchKey] || EMPTY_PERMISSION_ENTRY
      const currentlyChecked = current[actionKey]
      if (currentlyChecked === checked) return

      const updatedEntry = normalizePermissionEntry(moduleKey, current, actionKey, checked)
      if (hasAnyAllowedActionEnabled(moduleKey, updatedEntry)) {
        nextModuleScopes[branchKey] = updatedEntry
      } else {
        delete nextModuleScopes[branchKey]
      }

      if (Object.keys(nextModuleScopes).length) nextModuleBranchMatrix[moduleKey] = nextModuleScopes
      else delete nextModuleBranchMatrix[moduleKey]
      changed = true
    })

    if (!changed) return
    setPermissionsMatrix(nextPermissions)
    setModuleBranchMatrix(nextModuleBranchMatrix)
  }

  const getColumnSelectionState = (actionKey, modules = permissionOptions) => {
    if (isAdministrator) {
      const total = (Array.isArray(modules) ? modules : []).reduce((acc, module) => {
        const moduleKey = normalizeModuleKey(module?.key)
        if (!isActionAllowedForModule(moduleKey, actionKey)) return acc
        const moduleUsesBranchScope = isActionBranchScoped(moduleKey)
        const normalizedBranchId = normalizeBranchId(selectedBranchId)
        if (moduleUsesBranchScope && !normalizedBranchId) return acc
        return acc + 1
      }, 0)
      return {
        disabled: total === 0,
        checked: total > 0,
        indeterminate: false,
      }
    }

    let total = 0
    let selected = 0

    modules.forEach((module) => {
      const moduleKey = normalizeModuleKey(module?.key)
      if (!isActionAllowedForModule(moduleKey, actionKey)) return

      const moduleUsesBranchScope = isActionBranchScoped(moduleKey)
      const normalizedBranchId = normalizeBranchId(selectedBranchId)
      if (moduleUsesBranchScope && !normalizedBranchId) return

      total += 1
      const current = moduleUsesBranchScope
        ? getBranchPermissionEntry(moduleBranchMatrix, moduleKey, normalizedBranchId)
        : (permissionsMatrix[moduleKey] || EMPTY_PERMISSION_ENTRY)
      if (current[actionKey]) selected += 1
    })

    return {
      disabled: total === 0,
      checked: total > 0 && selected === total,
      indeterminate: selected > 0 && selected < total,
    }
  }

  const renderPermissionRow = (module) => {
    const entryKey = normalizeModuleKey(module?.key)
    const baseDisabled = !isEditing || loadingData || saving || deleteLoading || permissionsLoading || branchesLoading

    return (
      <div
        key={entryKey}
        className="permissions-matrix__row"
      >
        <div className="permissions-matrix__cell permissions-matrix__cell--label">{module.label}</div>
        {ACTIONS.map((action) => {
          if (!isActionAllowedForModule(entryKey, action.key)) {
            return (
              <div
                key={action.key}
                className="permissions-matrix__cell permissions-matrix__cell--action"
                aria-hidden="true"
              />
            )
          }

          const actionUsesBranchScope = isActionBranchScoped(entryKey)
          const normalizedBranchId = normalizeBranchId(selectedBranchId)
          const current = actionUsesBranchScope
            ? getBranchPermissionEntry(moduleBranchMatrix, entryKey, normalizedBranchId)
            : (permissionsMatrix[entryKey] || EMPTY_PERMISSION_ENTRY)
          const forcedCurrent = isAdministrator
            ? applyPermissionDependencies(entryKey, FULL_PERMISSION_ENTRY)
            : current
          const isDisabled = baseDisabled || isAdministrator || (actionUsesBranchScope && !normalizedBranchId)

          return (
            <label key={action.key} className="permissions-matrix__cell permissions-matrix__cell--action">
              <input
                type="checkbox"
                checked={Boolean(forcedCurrent?.[action.key])}
                onChange={() => togglePermissionForBranch(entryKey, action.key)}
                disabled={isDisabled}
              />
            </label>
          )
        })}
      </div>
    )
  }

  const loadPermissionOptions = useCallback(async () => {
    setPermissionsLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/usuarios/permisos/opciones/`,
        {},
        token
      )

      if (!response.ok) throw new Error('No se pudieron cargar los permisos disponibles.')

      const data = await response.json().catch(() => ({}))
      const modulos = (Array.isArray(data?.modulos) ? data.modulos : [])
        .map((module) => ({
          ...module,
          key: normalizeModuleKey(module?.key),
        }))
        .filter((module) => module.key && module.key !== 'configuracion')
      const scopedModules = Array.isArray(data?.modulos_con_sucursales) ? data.modulos_con_sucursales : []
      setPermissionOptions(modulos)
      setBranchScopedModules(
        scopedModules
          .map((module) => normalizeModuleKey(module?.key))
          .filter((key) => key && BRANCH_SCOPED_MODULE_KEYS.has(key))
      )
    } catch (err) {
      notifyError(err.message || 'Ocurrió un problema al cargar los permisos.')
    } finally {
      setPermissionsLoading(false)
    }
  }, [notifyError, token])

  const fetchBranches = useCallback(async () => {
    setBranchesLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/inventario/sucursales/?modulo=usuarios`,
        {},
        token
      )

      if (!response.ok) throw new Error('No se pudieron cargar las sucursales.')

      const data = await response.json().catch(() => [])
      const items = Array.isArray(data) ? data : data?.results || []
      setBranches(items)
      setSelectedBranchId((prev) => {
        if (prev && items.some((branch) => branch.id === prev)) return prev
        return items[0]?.id ?? null
      })
    } catch (err) {
      notifyError(err.message || 'Ocurrió un problema al cargar las sucursales.')
    } finally {
      setBranchesLoading(false)
    }
  }, [notifyError, token])

  const fetchUser = useCallback(async () => {
    if (!userId) return
    setLoadingData(true)
    try {
      const response = await authFetch(
        `${API_URL}/usuarios/listado/${userId}/`,
        {},
        token
      )
      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        const detail = data?.detail || 'No se pudo cargar la información del usuario.'
        throw new Error(detail)
      }

      const normalized = normalizeUser(data)
      setFormData(normalized)
      setOriginalData(normalized)
      const nextPermissions = buildMatrixFromList(normalized.permisos_personalizados)
      setPermissionsMatrix(nextPermissions)
      setModuleBranchMatrix(buildModuleBranchMatrixFromList(normalized.sucursales_por_modulo, nextPermissions))
      setIsEditing(false)
      setPassword('')
      setConfirmPassword('')
      setPasswordCopied(false)
      setShowPassword(false)
      setShowConfirmPassword(false)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al obtener la información del usuario.')
    } finally {
      setLoadingData(false)
    }
  }, [notifyError, token, userId])

  useEffect(() => {
    if (!open) return
    setIsEditing(false)
    setFormData(emptyForm)
    setOriginalData(emptyForm)
    setPassword('')
    setConfirmPassword('')
    setPasswordCopied(false)
    setShowPassword(false)
    setShowConfirmPassword(false)
    setPermissionsMatrix({})
    setModuleBranchMatrix({})
    setBranchScopedModules([])
    setBranches([])
    setSelectedBranchId(null)
    setShowPermissionsPopup(false)
    setSubmitAttempted(false)
    setActiveTab('general')
    setIsMaximized(false)
    restoreRef.current = null
    fetchUser()
    loadPermissionOptions()
    fetchBranches()
  }, [open, fetchUser, loadPermissionOptions, fetchBranches])

  useEffect(() => {
    if (!open) {
      setLoadingData(true)
    }
  }, [open])

  useEffect(() => {
    if (allowEdit || !isEditing) return
    setIsEditing(false)
  }, [allowEdit, isEditing])

  useEffect(() => {
    if (allowDelete || !showDeleteDialog) return
    setShowDeleteDialog(false)
  }, [allowDelete, showDeleteDialog])

  useLayoutEffect(() => {
    if (!open) return
    const { availableWidth, availableHeight } = getViewportMetrics()
    const nextWidth = Math.min(MIN_WIDTH, availableWidth)
    const nextHeight = Math.min(MIN_HEIGHT, availableHeight)
    setSize({ width: nextWidth, height: nextHeight })

    const centeredX = (window.innerWidth - nextWidth) / 2
    const centeredY = (window.innerHeight - nextHeight) / 2
    setPosition({ x: Math.max(centeredX, VIEWPORT_PADDING), y: Math.max(centeredY, VIEWPORT_PADDING) })
  }, [open])

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  useEffect(() => {
    positionRef.current = position
  }, [position])

  const handleMouseDown = (event) => {
    if (isMaximized) {
      const restore = restoreRef.current
      const fallbackSize = sizeRef.current
      const restoredSize = restore?.size || fallbackSize
      const restoredPosition = restore?.position || {
        x: Math.max((window.innerWidth - restoredSize.width) / 2, VIEWPORT_PADDING),
        y: Math.max((window.innerHeight - restoredSize.height) / 2, VIEWPORT_PADDING),
      }

      sizeRef.current = restoredSize
      positionRef.current = restoredPosition
      setSize(restoredSize)
      setPosition(restoredPosition)
      setIsMaximized(false)

      const offsetX = Math.min(
        Math.max(event.clientX - restoredPosition.x, 24),
        Math.max(restoredSize.width - 24, 24)
      )
      const offsetY = Math.min(
        Math.max(event.clientY - restoredPosition.y, 12),
        56
      )
      dragData.current = {
        active: true,
        offsetX,
        offsetY,
      }
      return
    }

    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    dragData.current = {
      active: true,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
  }

  const handleResizeMouseDown = (event) => {
    if (isMaximized) return
    event.preventDefault()
    event.stopPropagation()
    const { minWidth, minHeight } = getViewportMetrics()
    resizeData.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: sizeRef.current.width,
      startHeight: sizeRef.current.height,
    }

    const handleResizeMove = (moveEvent) => {
      if (!resizeData.current.active) return
      const deltaX = moveEvent.clientX - resizeData.current.startX
      const deltaY = moveEvent.clientY - resizeData.current.startY
      const maxWidth = Math.max(minWidth, window.innerWidth - positionRef.current.x - VIEWPORT_PADDING)
      const maxHeight = Math.max(minHeight, window.innerHeight - positionRef.current.y - VIEWPORT_PADDING)
      const width = clamp(resizeData.current.startWidth + deltaX, minWidth, maxWidth)
      const height = clamp(resizeData.current.startHeight + deltaY, minHeight, maxHeight)
      setSize({ width, height })
    }

    const handleResizeUp = () => {
      resizeData.current.active = false
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }

    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
  }

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!dragData.current.active) return
      event.preventDefault()
      const newX = event.clientX - dragData.current.offsetX
      const newY = event.clientY - dragData.current.offsetY
      const maxX = window.innerWidth - sizeRef.current.width - VIEWPORT_PADDING
      const maxY = window.innerHeight - sizeRef.current.height - VIEWPORT_PADDING
      setPosition({
        x: Math.min(Math.max(newX, VIEWPORT_PADDING), Math.max(maxX, VIEWPORT_PADDING)),
        y: Math.min(Math.max(newY, VIEWPORT_PADDING), Math.max(maxY, VIEWPORT_PADDING)),
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

  useEffect(() => {
    const handleWindowResize = () => {
      const { minWidth, minHeight, availableWidth, availableHeight } = getViewportMetrics()

      if (isMaximized) {
        setSize({ width: availableWidth, height: availableHeight })
        setPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
        return
      }

      setSize((prev) => {
        const width = clamp(prev.width, minWidth, availableWidth)
        const height = clamp(prev.height, minHeight, availableHeight)

        setPosition((prevPosition) => ({
          x: Math.min(Math.max(prevPosition.x, VIEWPORT_PADDING), Math.max(window.innerWidth - width - VIEWPORT_PADDING, VIEWPORT_PADDING)),
          y: Math.min(Math.max(prevPosition.y, VIEWPORT_PADDING), Math.max(window.innerHeight - height - VIEWPORT_PADDING, VIEWPORT_PADDING)),
        }))

        return { width, height }
      })
    }

    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [isMaximized])

  const toggleMaximize = () => {
    if (isMaximized) {
      const restore = restoreRef.current
      if (restore) {
        setSize(restore.size)
        setPosition(restore.position)
      }
      setIsMaximized(false)
      return
    }

    restoreRef.current = {
      size: sizeRef.current,
      position: positionRef.current,
    }
    const { availableWidth, availableHeight } = getViewportMetrics()
    setSize({ width: availableWidth, height: availableHeight })
    setPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
    setIsMaximized(true)
  }

  const handleToggleEdit = () => {
    if (!allowEdit) return
    if (loadingData || saving || deleteLoading) return
    setIsEditing((prev) => {
      const next = !prev
      if (!next) {
        setFormData(originalData)
        const resetPermissions = buildMatrixFromList(originalData.permisos_personalizados)
        setPermissionsMatrix(resetPermissions)
        setModuleBranchMatrix(buildModuleBranchMatrixFromList(originalData.sucursales_por_modulo, resetPermissions))
        setSubmitAttempted(false)
        setPassword('')
        setConfirmPassword('')
        setPasswordCopied(false)
        setShowPassword(false)
        setShowConfirmPassword(false)
        setShowPermissionsPopup(false)
      } else {
        setPassword('')
        setConfirmPassword('')
        setPasswordCopied(false)
        setShowPassword(false)
        setShowConfirmPassword(false)
        setShowPermissionsPopup(false)
      }
      return next
    })
  }

  const generatePassword = () => {
    if (!isEditing || loadingData || saving || deleteLoading) return
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789!@$%#?'
    let result = ''
    for (let i = 0; i < 12; i += 1) {
      result += charset.charAt(Math.floor(Math.random() * charset.length))
    }
    setPassword(result)
    setConfirmPassword(result)
    setPasswordCopied(false)
    setShowPassword(false)
    setShowConfirmPassword(false)
    setShowPermissionsPopup(false)
  }

  const copyPassword = async () => {
    if (!password) return
    try {
      await navigator.clipboard.writeText(password)
      setPasswordCopied(true)
      setTimeout(() => setPasswordCopied(false), 2500)
    } catch {
      notifyError('No se pudo copiar la contraseña. Intenta nuevamente.')
    }
  }

  const effectivePermissionsMatrix = useMemo(
    () => buildEffectivePermissionsMatrix(permissionsMatrix, moduleBranchMatrix, branchScopedModules),
    [permissionsMatrix, moduleBranchMatrix, branchScopedModules]
  )

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!isEditing || loadingData) return
    setSubmitAttempted(true)
    setSaving(true)

    const payload = {
      nombres: formData.nombres.trim(),
      apellidos: formData.apellidos.trim(),
      correo: formData.correo.trim().toLowerCase(),
      telefono: formData.telefono.trim(),
      cargo: formData.cargo.trim(),
      activo: Boolean(formData.activo),
      es_administrador: Boolean(formData.es_administrador),
      permisos_personalizados: serializeMatrix(effectivePermissionsMatrix),
      sucursales_por_modulo: serializeModuleBranchMatrix(moduleBranchMatrix, branchScopedModules),
    }

    if (password || confirmPassword) {
      if (password.length < 8) {
        setSaving(false)
        notifyError('La nueva contraseña debe tener al menos 8 caracteres.')
        return
      }

      if (password !== confirmPassword) {
        setSaving(false)
        notifyError('La confirmación de la nueva contraseña no coincide.')
        return
      }

      payload.password = password
    }

    if (!payload.nombres || !payload.apellidos || !payload.correo) {
      setSaving(false)
      notifyError('Completa los campos de nombres, apellidos y correo para continuar.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/usuarios/listado/${userId}/`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail =
          data?.detail ||
          data?.correo?.[0] ||
          data?.password?.[0] ||
          data?.nombres?.[0] ||
          data?.roles?.[0] ||
          data?.sucursales_por_modulo?.[0] ||
          data?.permisos_personalizados?.[0] ||
          'No se pudo actualizar el usuario. Verifica la información enviada.'
        throw new Error(detail)
      }

      const normalized = normalizeUser(data)
      setFormData(normalized)
      setOriginalData(normalized)
      const nextPermissions = buildMatrixFromList(normalized.permisos_personalizados)
      setPermissionsMatrix(nextPermissions)
      setModuleBranchMatrix(buildModuleBranchMatrixFromList(normalized.sucursales_por_modulo, nextPermissions))
      setSubmitAttempted(false)
      setIsEditing(false)
      setPassword('')
      setConfirmPassword('')
      setPasswordCopied(false)
      setShowPassword(false)
      setShowConfirmPassword(false)
      setShowPermissionsPopup(false)
      onUpdated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al actualizar el usuario.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!allowDelete) return
    if (isProtectedAdministratorUser) {
      notifyError('No se puede eliminar el usuario Administrador.')
      return
    }
    if (!isEditing || deleteLoading || !userId) return
    setShowDeleteDialog(false)
    setDeleteLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/usuarios/listado/${userId}/`,
        {
          method: 'DELETE',
        },
        token
      )

      if (!response.ok && response.status !== 204) {
        const data = await response.json().catch(() => ({}))
        const detail = data?.detail || 'No se pudo eliminar el usuario.'
        throw new Error(detail)
      }

      onDeleted?.(userId)
      onClose?.()
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al eliminar el usuario.')
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleClose = () => {
    onClose?.()
    setIsEditing(false)
    setSubmitAttempted(false)
    setShowDeleteDialog(false)
    setPassword('')
    setConfirmPassword('')
    setPasswordCopied(false)
    setShowPassword(false)
    setShowConfirmPassword(false)
  }
  const protectedUserName =
    normalizeIdentityValue(originalData.nombres) === 'administrador' &&
    normalizeIdentityValue(originalData.apellidos) === 'administrador'
  const protectedUserEmail = normalizeIdentityValue(originalData.correo) === 'administrador@mail.com'
  const isProtectedAdministratorUser = protectedUserName || protectedUserEmail
  const selectedBranch = branches.find((branch) => branch.id === selectedBranchId) || null
  const globalPermissionOptions = useMemo(
    () => permissionOptions.filter((module) => !branchScopedModules.includes(normalizeModuleKey(module?.key))),
    [permissionOptions, branchScopedModules]
  )
  const branchPermissionOptions = useMemo(
    () => permissionOptions.filter((module) => branchScopedModules.includes(normalizeModuleKey(module?.key))),
    [permissionOptions, branchScopedModules]
  )
  const { shouldRender, isClosing } = useModalAnimation(open)

  if (!shouldRender) return null

  return (
    <div className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`} role="dialog" aria-modal="true">
      <div
        className={`create-user__modal${isClosing ? ' create-user__modal--closing' : ''}`}
        ref={modalRef}
        style={{ top: position.y, left: position.x, width: size.width, height: size.height }}
      >
      <header className="create-user__header" onMouseDown={handleMouseDown}>
        <div className="create-user__header-text">
          {/* Mostramos el ID y el nombre completo del estado originalData */}
          <h3>
            {userId && originalData.nombres
              ? `${userId} : ${originalData.nombres} ${originalData.apellidos}`
              : 'Cargando usuario...'}
          </h3>
        </div>
        <div className="create-user__header-actions">
          <button
            type="button"
            className="create-user__icon-button create-user__icon-button--maximize"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={toggleMaximize}
            aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
          >
            <i className={isMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="create-user__icon-button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={handleClose}
            aria-label="Cerrar"
          >
            <i className="pi pi-times" aria-hidden="true" />
          </button>
        </div>
      </header>

      <form className={`create-user__form${submitAttempted && isEditing ? ' create-user__form--submitted' : ''}`} noValidate onSubmitCapture={(event) => event.currentTarget.classList.add('create-user__form--submitted')} onSubmit={handleSubmit}>
        {loadingData && (
          <div className="create-user__loading-overlay" role="status" aria-live="polite">
            <i className="pi pi-spin pi-spinner" aria-hidden="true" />
            <span>Cargando datos...</span>
          </div>
        )}
        <div className="create-user__tabs" role="tablist" aria-label="Secciones del usuario">
          <button
            type="button"
            className={`create-user__tab${activeTab === 'general' ? ' create-user__tab--active' : ''}`}
            onClick={() => {
              setActiveTab('general')
              setShowPermissionsPopup(false)
            }}
            role="tab"
            aria-selected={activeTab === 'general'}
          >
            General
          </button>
          <button
            type="button"
            className={`create-user__tab${activeTab === 'accesos' ? ' create-user__tab--active' : ''}`}
            onClick={() => {
              setActiveTab('accesos')
              setShowPermissionsPopup(false)
            }}
            role="tab"
            aria-selected={activeTab === 'accesos'}
          >
            Sucursales y permisos
          </button>
        </div>

        <div className={`create-user__body${activeTab === 'accesos' ? ' create-user__body--permissions' : ''}`}>
          {activeTab === 'general' && (
            <section className="create-user__section">
              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Perfil</p>
                  <h4>Información del usuario</h4>
                </div>
                {loadingData && <small className="muted">Cargando datos...</small>}
              </div>

              <div className="create-user__grid create-user__grid--two">
                <label className="create-user__field">
                  <span>Nombres</span>
                  <input
                    name="nombres"
                    type="text"
                    placeholder="Ana María"
                    value={formData.nombres}
                    onChange={handleChange}
                    disabled={!isEditing || loadingData || saving}
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
                    disabled={!isEditing || loadingData || saving}
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
                    disabled={!isEditing || loadingData || saving}
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
                    disabled={!isEditing || loadingData || saving}
                  />
                </label>

                <label className="create-user__field create-user__field--full">
                  <span>Cargo</span>
                  <input
                    name="cargo"
                    type="text"
                    placeholder="Coordinador de inventario"
                    value={formData.cargo}
                    onChange={handleChange}
                    disabled={!isEditing || loadingData || saving}
                  />
                </label>
              </div>

              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Perfil</p>
                  <h4>Activación y contraseña</h4>
                </div>
                {loadingData && <small className="muted">Cargando datos...</small>}
              </div>

              <div className="create-user__access-grid">
                <div className="create-user__access-left">
                  <label className="create-user__field create-user__field--password">
                    <div className="create-user__field-label">
                      <span>Nueva contraseña</span>
                      <div className="create-user__password-actions">
                        <button
                          type="button"
                          className="create-user__ghost"
                          onClick={generatePassword}
                          disabled={!isEditing || loadingData || saving || deleteLoading}
                        >
                          Generar
                        </button>
                        <button
                          type="button"
                          className="create-user__ghost"
                          onClick={copyPassword}
                          disabled={!isEditing || loadingData || saving || deleteLoading || !password}
                        >
                          {passwordCopied ? 'Copiada' : 'Copiar'}
                        </button>
                      </div>
                    </div>
                    <div className="create-user__password-input">
                      <input
                        name="password"
                        type={showPassword ? 'text' : 'password'}
                        placeholder="Deja vacía para mantener la actual"
                        value={password}
                        onChange={(event) => {
                          if (!isEditing) return
                          setPassword(event.target.value)
                          setPasswordCopied(false)
                        }}
                        disabled={!isEditing || loadingData || saving || deleteLoading}
                      />
                      <button
                        type="button"
                        className="create-user__password-toggle"
                        onClick={() => setShowPassword((prev) => !prev)}
                        disabled={!isEditing || loadingData || saving || deleteLoading}
                        aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                      >
                        <i className={`pi ${showPassword ? 'pi-eye-slash' : 'pi-eye'}`} aria-hidden="true" />
                      </button>
                    </div>
                  </label>

                  <label className="create-user__field create-user__field--password-confirm">
                    <div className="create-user__field-label">
                      <span>Confirmar nueva contraseña</span>
                    </div>
                    <div className="create-user__password-input">
                      <input
                        name="confirmPassword"
                        type={showConfirmPassword ? 'text' : 'password'}
                        placeholder="Repite la nueva contraseña"
                        value={confirmPassword}
                        onChange={(event) => {
                          if (!isEditing) return
                          setConfirmPassword(event.target.value)
                        }}
                        disabled={!isEditing || loadingData || saving || deleteLoading}
                      />
                      <button
                        type="button"
                        className="create-user__password-toggle"
                        onClick={() => setShowConfirmPassword((prev) => !prev)}
                        disabled={!isEditing || loadingData || saving || deleteLoading}
                        aria-label={showConfirmPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                      >
                        <i className={`pi ${showConfirmPassword ? 'pi-eye-slash' : 'pi-eye'}`} aria-hidden="true" />
                      </button>
                    </div>
                  </label>
                </div>

                <div className="create-user__access-right">
                  <label className="create-user__checkbox">
                    <input type="checkbox" name="activo" checked={formData.activo} onChange={handleChange} disabled={!isEditing || loadingData || saving} />
                    <div>
                      <span>Cuenta activa</span>
                      <p>El usuario podrá iniciar sesión y operar el sistema.</p>
                    </div>
                  </label>
                  <label className="create-user__checkbox">
                    <input
                      type="checkbox"
                      name="es_administrador"
                      checked={Boolean(formData.es_administrador)}
                      onChange={handleChange}
                      disabled={!isEditing || loadingData || saving}
                    />
                    <div>
                      <span>Administrador</span>
                      <p>Tendra acceso total y no recibira alertas urgentes de traslado.</p>
                    </div>
                  </label>
                </div>
              </div>

            </section>
          )}

          {activeTab === 'accesos' && (
            <section className="create-user__section">
              {Boolean(globalPermissionOptions.length) && (
                <div className="create-user__permissions-panel user-details__permissions-panel-global">
                  <div className="create-user__permissions-panel-head">
                    <div>
                      <p className="create-user__eyebrow">Permisos globales</p>
                      <h4>Acceso general (sin sucursal)</h4>
                    </div>
                  </div>

                  <div className="permissions-matrix__table" role="grid">
                    <div className="permissions-matrix__row permissions-matrix__row--head">
                      <div className="permissions-matrix__cell permissions-matrix__cell--label">Módulo</div>
                      {ACTIONS.map((action) => {
                        const columnState = getColumnSelectionState(action.key, globalPermissionOptions)
                        const headerDisabled = !isEditing || loadingData || saving || deleteLoading || permissionsLoading || branchesLoading || isAdministrator || columnState.disabled
                        return (
                          <div key={action.key} className="permissions-matrix__cell permissions-matrix__cell--action permissions-matrix__head-action">
                            <span>{action.label}</span>
                            <input
                              type="checkbox"
                              checked={columnState.checked}
                              ref={(node) => {
                                if (node) node.indeterminate = columnState.indeterminate
                              }}
                              onChange={(event) => setColumnPermission(action.key, event.target.checked, globalPermissionOptions)}
                              disabled={headerDisabled}
                              aria-label={`Seleccionar toda la columna ${action.label}`}
                            />
                          </div>
                        )
                      })}
                    </div>

                    {globalPermissionOptions.map((module) => renderPermissionRow(module))}
                  </div>
                </div>
              )}

              {(branchesLoading || !branches.length) && (
                <div className="create-user__section-header">
                  <small className="muted">
                    {branchesLoading ? 'Cargando sucursales...' : 'No hay sucursales registradas.'}
                  </small>
                </div>
              )}

              <div className="create-user__branch-list create-user__branch-list--full">
                {branches.map((branch) => {
                  const isSelected = branch.id === selectedBranchId
                  return (
                    <div key={branch.id} className={`create-user__branch-item${isSelected ? ' create-user__branch-item--active' : ''}`}>
                      <div className="create-user__branch-meta">
                        <strong>{branch.nombre}</strong>
                        {branch.direccion ? <small>{branch.direccion}</small> : null}
                      </div>
                      <button
                        type="button"
                        className="create-user__ghost create-user__branch-select"
                        onClick={() => {
                          setSelectedBranchId(branch.id)
                          setShowPermissionsPopup(true)
                        }}
                        disabled={!isEditing || loadingData || saving || deleteLoading || branchesLoading || !branchPermissionOptions.length}
                      >
                        Ver permisos
                      </button>
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>

          <div className="create-user__footer">
            <div className="user-details__footer-left">
              <button type="button" className="create-user__action create-user__action--cancel" onClick={handleClose}>
                Cancelar
              </button>
              {allowEdit && (
                <button
                  type="button"
                  className={`create-user__action create-user__action--edit user-details__edit-toggle${isEditing ? ' user-details__edit-toggle--active' : ''}`}
                  onClick={handleToggleEdit}
                  disabled={loadingData || saving || deleteLoading}
                >
                  {isEditing ? (
                    <>
                      <span className="user-details__toggle-icon" aria-hidden="true">
                        <Eye size={16} />
                      </span>
                      <span>Solo lectura</span>
                    </>
                  ) : (
                    <>
                      <span className="user-details__toggle-icon" aria-hidden="true">
                        <Pencil size={16} />
                      </span>
                      <span>Editar</span>
                    </>
                  )}
                </button>
              )}
            </div>

            <div className="user-details__footer-right">
              {isEditing && allowDelete && (
                <>
                  <button
                    type="button"
                    className="create-user__action user-details__delete"
                    onClick={() => setShowDeleteDialog(true)}
                    disabled={deleteLoading || saving || loadingData || isProtectedAdministratorUser}
                    title={isProtectedAdministratorUser ? 'El usuario Administrador no se puede eliminar.' : undefined}
                  >
                    {deleteLoading ? 'Eliminando...' : 'Eliminar'}
                  </button>

                  <button
                    type="submit"
                    className="create-user__action create-user__action--primary"
                    disabled={saving || loadingData}
                  >
                    {saving ? 'Guardando...' : 'Guardar'}
                  </button>
                </>
              )}
            </div>
          </div>
      </form>

      {showPermissionsPopup && selectedBranch && typeof document !== 'undefined' && createPortal(
        <div
          className="create-user__permissions-popup-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Permisos de ${selectedBranch.nombre}`}
          onClick={() => setShowPermissionsPopup(false)}
        >
          <div className="create-user__permissions-popup" onClick={(event) => event.stopPropagation()}>
            <div className="create-user__permissions-popup-head">
              <div>
                <p className="create-user__eyebrow">Permisos por sucursal</p>
                <h4>{selectedBranch.nombre}</h4>
              </div>
              <button
                type="button"
                className="create-user__icon-button"
                onClick={() => setShowPermissionsPopup(false)}
                aria-label="Cerrar permisos"
              >
                <i className="pi pi-times" aria-hidden="true" />
              </button>
            </div>

            {(permissionsLoading || !branchPermissionOptions.length) && (
              <small className="muted">
                {permissionsLoading ? 'Cargando permisos...' : 'No hay módulos por sucursal configurados.'}
              </small>
            )}

            <div className="create-user__permissions-popup-body">
              <div className="permissions-matrix__table" role="grid">
                <div className="permissions-matrix__row permissions-matrix__row--head">
                  <div className="permissions-matrix__cell permissions-matrix__cell--label">Módulo</div>
                  {ACTIONS.map((action) => {
                    const columnState = getColumnSelectionState(action.key, branchPermissionOptions)
                    const headerDisabled = !isEditing || loadingData || saving || deleteLoading || permissionsLoading || branchesLoading || isAdministrator || columnState.disabled
                    return (
                      <div key={action.key} className="permissions-matrix__cell permissions-matrix__cell--action permissions-matrix__head-action">
                        <span>{action.label}</span>
                        <input
                          type="checkbox"
                          checked={columnState.checked}
                          ref={(node) => {
                            if (node) node.indeterminate = columnState.indeterminate
                          }}
                          onChange={(event) => setColumnPermission(action.key, event.target.checked, branchPermissionOptions)}
                          disabled={headerDisabled}
                          aria-label={`Seleccionar toda la columna ${action.label}`}
                        />
                      </div>
                    )
                  })}
                </div>

                {branchPermissionOptions.map((module) => (
                  renderPermissionRow(module)
                ))}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {allowDelete && showDeleteDialog && (
        <div className="user-details__confirm-overlay" role="alertdialog" aria-modal="true" aria-label="Confirmar eliminación">
          <div className="user-details__confirm-dialog">
            <div className="user-details__confirm-icon" aria-hidden="true">
              <Info size={22} />
            </div>
            <div className="user-details__confirm-content">
              <h4>¿Estás seguro?</h4>
              <p>Esta acción es irreversible</p>
            </div>
            <div className="user-details__confirm-actions">
              <button
                type="button"
                className="create-user__ghost create-user__cancel"
                onClick={() => setShowDeleteDialog(false)}
              >
                No
              </button>
              <button
                type="button"
                className="user-details__confirm-danger"
                onClick={handleDelete}
                disabled={deleteLoading}
              >
                Sí
              </button>
            </div>
          </div>
        </div>
      )}

      {allowDelete && showDeleteDialog && (
        <div className="user-details__confirm-overlay" role="alertdialog" aria-modal="true" aria-label="Confirmar eliminación">
          <div className="user-details__confirm-dialog">
            <div className="user-details__confirm-icon" aria-hidden="true">
              <Info size={22} />
            </div>
            <div className="user-details__confirm-content">
              <h4>¿Estás seguro?</h4>
              <p>Esta acción es irreversible</p>
            </div>
            <div className="user-details__confirm-actions">
              <button
                type="button"
                className="create-user__action create-user__action--cancel"
                onClick={() => setShowDeleteDialog(false)}
              >
                No
              </button>
              <button
                type="button"
                className="create-user__action user-details__confirm-danger"
                onClick={handleDelete}
                disabled={deleteLoading}
              >
                Sí
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        aria-label="Cambiar tamaño de ventana"
        className="create-user__resize-handle"
          onMouseDown={handleResizeMouseDown}
        />
      </div>
    </div>
  )
}

export default UsersDetails




