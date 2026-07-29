import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './CreateUsuario.css'
import { API_URL, authFetch } from '../../../../utils/api'
import { getAppPortalRoot } from '../../../../utils/portalRoot'
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
  'sucursales_bodegas',
  'solicitudes',
  'importaciones',
])
const ENTRADAS_MODULE_KEY = 'movimientos_entradas'
const SALIDAS_MODULE_KEY = 'movimientos_salidas'
const IMPORTACIONES_MODULE_KEY = 'importaciones'
const SOLICITUDES_MODULE_KEY = 'solicitudes'
const DEFAULT_FULL_ACCESS_MODULES = [SOLICITUDES_MODULE_KEY, IMPORTACIONES_MODULE_KEY]
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
          const entry = { sucursal_id: normalizedBranchId, ...normalizedEntry }
          const normalizedModKey = normalizeModuleKey(modulo)
          const canCreate = Boolean(normalizedEntry.puede_crear)
          if (normalizedModKey === ENTRADAS_MODULE_KEY) {
            entry.puede_crear_compra_local = canCreate ? Boolean(rawEntry?.puede_crear_compra_local ?? false) : false
            entry.puede_crear_importacion = canCreate ? Boolean(rawEntry?.puede_crear_importacion ?? false) : false
            entry.puede_crear_traslado = canCreate ? Boolean(rawEntry?.puede_crear_traslado ?? false) : false
            entry.puede_crear_devolucion = canCreate ? Boolean(rawEntry?.puede_crear_devolucion ?? false) : false
          }
          if (normalizedModKey === SALIDAS_MODULE_KEY) {
            entry.puede_crear_venta = canCreate ? Boolean(rawEntry?.puede_crear_venta ?? false) : false
            entry.puede_crear_traslado = canCreate ? Boolean(rawEntry?.puede_crear_traslado ?? false) : false
            entry.puede_crear_devolucion = canCreate ? Boolean(rawEntry?.puede_crear_devolucion ?? false) : false
          }
          if (normalizedModKey === IMPORTACIONES_MODULE_KEY) {
            entry.puede_importar = canCreate ? Boolean(rawEntry?.puede_importar ?? false) : false
            entry.puede_marcar_llegada = canCreate ? Boolean(rawEntry?.puede_marcar_llegada ?? false) : false
          }
          return entry
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

const initialForm = {
  nombres: '',
  apellidos: '',
  correo: '',
  telefono: '',
  cargo: '',
  activo: true,
  es_administrador: false,
}

function CreateUsuario({ open, onClose, onCreated, token, onError }) {
  const [formData, setFormData] = useState(initialForm)
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
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [selectedBranchId, setSelectedBranchId] = useState(null)
  const [showPermissionsPopup, setShowPermissionsPopup] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)

  const modalRef = useRef(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })
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

  const fetchPermissionOptions = useCallback(async () => {
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

  useEffect(() => {
    if (!open) return
    setFormData(initialForm)
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
    setActiveTab('general')
    setIsMaximized(false)
    restoreRef.current = null
    fetchPermissionOptions()
    fetchBranches()
  }, [open, fetchPermissionOptions, fetchBranches])

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

  const handleChange = (event) => {
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

  useEffect(() => {
    if (isAdministrator) return
    if (!permissionOptions.length || !branches.length || !branchScopedModules.length) return
    const eligible = DEFAULT_FULL_ACCESS_MODULES.filter((k) => branchScopedModules.includes(k))
    if (!eligible.length) return
    setModuleBranchMatrix((prev) => {
      const next = { ...prev }
      eligible.forEach((modKey) => {
        if (next[modKey]) return
        next[modKey] = {}
        branches.forEach((branch) => {
          const branchId = normalizeBranchId(branch.id)
          if (!branchId) return
          next[modKey][branchId] = {
            puede_crear: true,
            puede_leer: true,
            puede_actualizar: true,
            puede_eliminar: true,
            ...(modKey === IMPORTACIONES_MODULE_KEY
              ? { puede_importar: true, puede_marcar_llegada: true }
              : {}),
          }
        })
      })
      return next
    })
  }, [isAdministrator, permissionOptions, branches, branchScopedModules])

  const togglePermissionForBranch = (moduleKey, actionKey) => {
    if (isAdministrator) return
    const normalizedModuleKey = normalizeModuleKey(moduleKey)
    if (!isActionAllowedForModule(moduleKey, actionKey)) return
    const moduleUsesBranchScope = isActionBranchScoped(moduleKey)

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

  const toggleEntradasSubtype = (subtypeKey) => {
    if (isAdministrator) return
    const normalizedBranchId = normalizeBranchId(selectedBranchId)
    if (!normalizedBranchId) return
    setModuleBranchMatrix((prev) => {
      const moduleScopes = prev[ENTRADAS_MODULE_KEY]
      if (!moduleScopes || typeof moduleScopes !== 'object') return prev
      const branchKey = String(normalizedBranchId)
      const current = moduleScopes[branchKey]
      if (!current || !current.puede_crear) return prev
      return {
        ...prev,
        [ENTRADAS_MODULE_KEY]: {
          ...moduleScopes,
          [branchKey]: { ...current, [subtypeKey]: !current[subtypeKey] },
        },
      }
    })
  }

  const toggleSalidasSubtype = (subtypeKey) => {
    if (isAdministrator) return
    const normalizedBranchId = normalizeBranchId(selectedBranchId)
    if (!normalizedBranchId) return
    setModuleBranchMatrix((prev) => {
      const moduleScopes = prev[SALIDAS_MODULE_KEY]
      if (!moduleScopes || typeof moduleScopes !== 'object') return prev
      const branchKey = String(normalizedBranchId)
      const current = moduleScopes[branchKey]
      if (!current || !current.puede_crear) return prev
      return {
        ...prev,
        [SALIDAS_MODULE_KEY]: {
          ...moduleScopes,
          [branchKey]: { ...current, [subtypeKey]: !current[subtypeKey] },
        },
      }
    })
  }

  const toggleImportacionesSubtype = (subtypeKey) => {
    if (isAdministrator) return
    const normalizedBranchId = normalizeBranchId(selectedBranchId)
    if (!normalizedBranchId) return
    setModuleBranchMatrix((prev) => {
      const moduleScopes = prev[IMPORTACIONES_MODULE_KEY]
      if (!moduleScopes || typeof moduleScopes !== 'object') return prev
      const branchKey = String(normalizedBranchId)
      const current = moduleScopes[branchKey]
      if (!current || !current.puede_crear) return prev
      return {
        ...prev,
        [IMPORTACIONES_MODULE_KEY]: {
          ...moduleScopes,
          [branchKey]: { ...current, [subtypeKey]: !current[subtypeKey] },
        },
      }
    })
  }

  const setColumnPermission = (actionKey, checked, modules = permissionOptions) => {
    if (isAdministrator) return
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
    const baseDisabled = loading || permissionsLoading || branchesLoading

    return (
      <div key={entryKey} className="permissions-matrix__row">
        <div className="permissions-matrix__cell permissions-matrix__cell--label">
          {module.label}
        </div>
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
  const effectivePermissionsMatrix = useMemo(
    () => buildEffectivePermissionsMatrix(permissionsMatrix, moduleBranchMatrix, branchScopedModules),
    [permissionsMatrix, moduleBranchMatrix, branchScopedModules]
  )

  const handleSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)

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

    if (!payload.nombres || !payload.apellidos || !payload.correo) {
      setLoading(false)
      notifyError('Completa los campos de nombres, apellidos y correo para continuar.')
      return
    }

    if (!password || password.length < 8) {
      setLoading(false)
      notifyError('Define una contraseña de al menos 8 caracteres para el usuario.')
      return
    }

    if (password !== confirmPassword) {
      setLoading(false)
      notifyError('La confirmación de contraseña no coincide.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/usuarios/listado/`,
        {
          method: 'POST',
          body: JSON.stringify({ ...payload, password }),
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
          'No se pudo crear el usuario. Verifica la información enviada.'
        throw new Error(detail)
      }

      setFormData(initialForm)
      setPassword('')
      setConfirmPassword('')
      setPasswordCopied(false)
      setShowPassword(false)
      setShowConfirmPassword(false)
      setPermissionsMatrix({})
      setModuleBranchMatrix({})
      onCreated?.({ ...data, password })
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al crear el usuario.')
    } finally {
      setLoading(false)
    }
  }

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
      notifyError('No se pudo copiar la contraseña. Intenta nuevamente.')
    }
  }
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
            <h3>Crear cuenta interna</h3>
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
              onClick={onClose}
              aria-label="Cerrar"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <form className="create-user__form create-user__form--create" noValidate onSubmitCapture={(event) => event.currentTarget.classList.add('create-user__form--submitted')} onSubmit={handleSubmit}>
          <div className="create-user__tabs" role="tablist" aria-label="Secciones del usuario">
            <button
              type="button"
              className={`create-user__tab${activeTab === 'general' ? ' create-user__tab--active' : ''}`}
              onClick={() => {
                setActiveTab('general')
                setShowPermissionsPopup(false)
                setSelectedBranchId(null)
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
                setSelectedBranchId(null)
              }}
              role="tab"
              aria-selected={activeTab === 'accesos'}
            >
              Sucursales y permisos
            </button>
          </div>

          <div className={`create-user__body${activeTab === 'accesos' ? ' create-user__body--permissions' : ''}`}>
            {activeTab === 'general' && (
              <>
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Datos del usuario</p>
                      <h4>Información personal y de contacto</h4>
                    </div>
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field">
                      <span>Nombre</span>
                      <input
                        name="nombres"
                        type="text"
                        placeholder="Nombre"
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
                        placeholder="Apellidos"
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
                        placeholder="Correo"
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
                        placeholder="Teléfono"
                        value={formData.telefono}
                        onChange={handleChange}
                      />
                    </label>

                    <label className="create-user__field create-user__field--full">
                      <span>Cargo</span>
                      <input
                        name="cargo"
                        type="text"
                        placeholder="Cargo"
                        value={formData.cargo}
                        onChange={handleChange}
                      />
                    </label>
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Acceso y permisos</p>
                      <h4>Credenciales y activación</h4>
                    </div>
                  </div>

                  <div className="create-user__access-grid">
                    <div className="create-user__access-left">
                      <label className="create-user__field create-user__field--password">
                        <div className="create-user__field-label">
                          <span>Contraseña</span>
                          <div className="create-user__password-actions">
                            <button type="button" className="create-user__ghost" onClick={generatePassword}>
                              Generar
                            </button>
                            <button type="button" className="create-user__ghost" onClick={copyPassword}>
                              {passwordCopied ? 'Copiada' : 'Copiar'}
                            </button>
                          </div>
                        </div>
                        <div className="create-user__password-input">
                          <input
                            name="password"
                            type={showPassword ? 'text' : 'password'}
                            placeholder="Contraseña"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            required
                          />
                          <button
                            type="button"
                            className="create-user__password-toggle"
                            onClick={() => setShowPassword((prev) => !prev)}
                            aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                          >
                            <i className={`pi ${showPassword ? 'pi-eye-slash' : 'pi-eye'}`} aria-hidden="true" />
                          </button>
                        </div>
                      </label>

                      <label className="create-user__field create-user__field--password-confirm">
                        <div className="create-user__field-label">
                          <span>Confirmar contraseña</span>
                        </div>
                        <div className="create-user__password-input">
                          <input
                            name="confirmPassword"
                            type={showConfirmPassword ? 'text' : 'password'}
                            placeholder="Repite la contraseña"
                            value={confirmPassword}
                            onChange={(event) => setConfirmPassword(event.target.value)}
                            required
                          />
                          <button
                            type="button"
                            className="create-user__password-toggle"
                            onClick={() => setShowConfirmPassword((prev) => !prev)}
                            aria-label={showConfirmPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                          >
                            <i className={`pi ${showConfirmPassword ? 'pi-eye-slash' : 'pi-eye'}`} aria-hidden="true" />
                          </button>
                        </div>
                      </label>
                    </div>

                    <div className="create-user__access-right">
                      <label className="create-user__checkbox">
                        <input type="checkbox" name="activo" checked={formData.activo} onChange={handleChange} />
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
                        />
                        <div>
                          <span>Administrador</span>
                          <p>Tendra acceso total y no recibira alertas urgentes de traslado.</p>
                        </div>
                      </label>
                    </div>
                  </div>
                </section>
              </>
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
                          const headerDisabled = loading || permissionsLoading || branchesLoading || isAdministrator || columnState.disabled
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
                    <small className="muted">{branchesLoading ? 'Cargando sucursales...' : 'No hay sucursales registradas.'}</small>
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
                          disabled={loading || branchesLoading || !branchPermissionOptions.length}
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
            <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="create-user__action create-user__action--primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Crear usuario'}
            </button>
          </div>
        </form>

        {showPermissionsPopup && selectedBranch && typeof document !== 'undefined' && createPortal(
          <div
            className="create-user__permissions-popup-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={`Permisos de ${selectedBranch.nombre}`}
            onClick={() => { setShowPermissionsPopup(false); setSelectedBranchId(null) }}
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
                  onClick={() => { setShowPermissionsPopup(false); setSelectedBranchId(null) }}
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
                      const headerDisabled = loading || permissionsLoading || branchesLoading || isAdministrator || columnState.disabled
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

                  {branchPermissionOptions.map((module) => renderPermissionRow(module))}
                </div>

                {(() => {
                  const normalizedBranchId = normalizeBranchId(selectedBranchId)
                  const hasEntradas = branchPermissionOptions.some((m) => normalizeModuleKey(m?.key) === ENTRADAS_MODULE_KEY)
                  const hasSalidas = branchPermissionOptions.some((m) => normalizeModuleKey(m?.key) === SALIDAS_MODULE_KEY)
                  const hasImportaciones = branchPermissionOptions.some((m) => normalizeModuleKey(m?.key) === IMPORTACIONES_MODULE_KEY)
                  if (!hasEntradas && !hasSalidas && !hasImportaciones) return null

                  const entradasEntry = getBranchPermissionEntry(moduleBranchMatrix, ENTRADAS_MODULE_KEY, normalizedBranchId)
                  const salidasEntry = getBranchPermissionEntry(moduleBranchMatrix, SALIDAS_MODULE_KEY, normalizedBranchId)
                  const importacionesEntry = getBranchPermissionEntry(moduleBranchMatrix, IMPORTACIONES_MODULE_KEY, normalizedBranchId)
                  const entradasCanCreate = isAdministrator || Boolean(entradasEntry?.puede_crear)
                  const salidasCanCreate = isAdministrator || Boolean(salidasEntry?.puede_crear)
                  const importacionesCanCreate = isAdministrator || Boolean(importacionesEntry?.puede_crear)
                  const baseDisabled = loading || permissionsLoading || branchesLoading || isAdministrator

                  const entradasSubtypes = [
                    { key: 'puede_crear_compra_local', label: 'Compras locales' },
                    { key: 'puede_crear_traslado', label: 'Traslados' },
                    { key: 'puede_crear_devolucion', label: 'Devoluciones' },
                  ]
                  const salidasSubtypes = [
                    { key: 'puede_crear_venta', label: 'Ventas' },
                    { key: 'puede_crear_traslado', label: 'Traslados' },
                    { key: 'puede_crear_devolucion', label: 'Garantía' },
                  ]
                  const importacionesSubtypes = [
                    { key: 'puede_importar', label: 'Enviar a en camino' },
                    { key: 'puede_marcar_llegada', label: 'Marcar llegada' },
                  ]

                  return (
                    <div className="create-user__subtypes-row">
                      {hasEntradas && (
                        <div className="create-user__entrada-subtypes">
                          <p className="create-user__entrada-subtypes-label">Tipos de entrada permitidos para crear</p>
                          <div className="create-user__entrada-subtypes-options">
                            {entradasSubtypes.map(({ key, label }) => {
                              const checked = isAdministrator ? true : Boolean(entradasEntry?.[key] ?? false)
                              const disabled = baseDisabled || !entradasCanCreate
                              return (
                                <label key={key} className={`create-user__subtype-option${disabled ? ' create-user__subtype-option--disabled' : ''}`}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleEntradasSubtype(key)}
                                    disabled={disabled}
                                  />
                                  <span>{label}</span>
                                </label>
                              )
                            })}
                          </div>
                        </div>
                      )}
                      {hasSalidas && (
                        <div className="create-user__entrada-subtypes">
                          <p className="create-user__entrada-subtypes-label">Tipos de salida permitidos para crear</p>
                          <div className="create-user__entrada-subtypes-options">
                            {salidasSubtypes.map(({ key, label }) => {
                              const checked = isAdministrator ? true : Boolean(salidasEntry?.[key] ?? false)
                              const disabled = baseDisabled || !salidasCanCreate
                              return (
                                <label key={key} className={`create-user__subtype-option${disabled ? ' create-user__subtype-option--disabled' : ''}`}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleSalidasSubtype(key)}
                                    disabled={disabled}
                                  />
                                  <span>{label}</span>
                                </label>
                              )
                            })}
                          </div>
                        </div>
                      )}
                      {hasImportaciones && (
                        <div className="create-user__entrada-subtypes">
                          <p className="create-user__entrada-subtypes-label">Acciones de importación permitidas</p>
                          <div className="create-user__entrada-subtypes-options">
                            {importacionesSubtypes.map(({ key, label }) => {
                              const checked = isAdministrator ? true : Boolean(importacionesEntry?.[key] ?? false)
                              const disabled = baseDisabled || !importacionesCanCreate
                              return (
                                <label key={key} className={`create-user__subtype-option${disabled ? ' create-user__subtype-option--disabled' : ''}`}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleImportacionesSubtype(key)}
                                    disabled={disabled}
                                  />
                                  <span>{label}</span>
                                </label>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>
            </div>
          </div>,
          getAppPortalRoot()
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

export default CreateUsuario




