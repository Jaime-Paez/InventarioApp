import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, Loader2, Pencil, RefreshCw, Send, Settings, Wrench, X } from 'lucide-react'
import { Toast } from 'primereact/toast'
import { API_URL, authFetch } from '../../../../utils/api'
import '../CreateUsuario/CreateUsuario.css'
import './RandomInspectionAdminTable.css'

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const normalizeId = (value) => (value == null ? '' : String(value).trim())

const formatDateTime = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return '-'
  const timestamp = Date.parse(raw)
  if (!Number.isFinite(timestamp)) return raw
  try {
    return new Intl.DateTimeFormat('es-EC', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp))
  } catch {
    return raw
  }
}

const formatPercent = (value) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '0.0%'
  return `${numeric.toFixed(1)}%`
}

const formatReviewState = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'coincide') return 'Coincide'
  if (normalized === 'no_coincide') return 'No coincide'
  if (normalized === 'pendiente') return 'Pendiente'
  return '-'
}

const formatVerificationState = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'sin_novedad') return 'Sin novedad'
  if (normalized === 'pendiente') return 'Pendiente'
  if (normalized === 'aprobada') return 'Aprobada'
  if (normalized === 'rechazada') return 'Rechazada'
  return '-'
}

const ASSIGNMENTS_MODAL_MIN_WIDTH = 720
const ASSIGNMENTS_MODAL_MIN_HEIGHT = 520
const ASSIGNMENTS_VIEWPORT_PADDING = 12

function RandomInspectionAdminTable({ token, moduleActions }) {
  const toast = useRef(null)
  const canRead = moduleActions?.puede_leer ?? true
  const canUpdate = moduleActions?.puede_actualizar ?? true
  const isDarkTheme = typeof document !== 'undefined'
    && document.querySelector('.app-shell')?.classList.contains('theme-dark')

  const [summaryRows, setSummaryRows] = useState([])
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [selectedBranchId, setSelectedBranchId] = useState('')

  const [itemsRows, setItemsRows] = useState([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsFilter, setItemsFilter] = useState('pendiente')

  const [editingItem, setEditingItem] = useState(null)
  const [confirmedQty, setConfirmedQty] = useState('')
  const [verificationNote, setVerificationNote] = useState('')
  const [submitLoading, setSubmitLoading] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [showAssignmentsDialog, setShowAssignmentsDialog] = useState(false)
  const [assignmentRows, setAssignmentRows] = useState([])
  const [assignmentBranches, setAssignmentBranches] = useState([])
  const [assignmentsLoading, setAssignmentsLoading] = useState(false)
  const [assignmentSearch, setAssignmentSearch] = useState('')
  const [localAssignmentMap, setLocalAssignmentMap] = useState({})
  const [assignmentsSaving, setAssignmentsSaving] = useState(false)
  const [isEditingAssignments, setIsEditingAssignments] = useState(false)
  const [configData, setConfigData] = useState({ hora_recordatorio: '', cantidad_productos: '' })
  const [configLoading, setConfigLoading] = useState(false)
  const [showSendNowDialog, setShowSendNowDialog] = useState(false)
  const [sendNowLoading, setSendNowLoading] = useState(false)
  const [assignmentsModalPosition, setAssignmentsModalPosition] = useState({ x: 0, y: 0 })
  const [assignmentsModalSize, setAssignmentsModalSize] = useState({
    width: ASSIGNMENTS_MODAL_MIN_WIDTH,
    height: ASSIGNMENTS_MODAL_MIN_HEIGHT,
  })
  const [assignmentsModalMaximized, setAssignmentsModalMaximized] = useState(false)

  const assignmentsModalRef = useRef(null)
  const assignmentsDragRef = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const assignmentsResizeRef = useRef({
    active: false,
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0,
  })
  const assignmentsRestoreRef = useRef(null)
  const assignmentsSizeRef = useRef(assignmentsModalSize)
  const assignmentsPositionRef = useRef(assignmentsModalPosition)

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
  const getAssignmentsViewportMetrics = useCallback(() => {
    const availableWidth = Math.max(0, window.innerWidth - ASSIGNMENTS_VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - ASSIGNMENTS_VIEWPORT_PADDING * 2)
    return {
      availableWidth,
      availableHeight,
      minWidth: Math.min(ASSIGNMENTS_MODAL_MIN_WIDTH, availableWidth),
      minHeight: Math.min(ASSIGNMENTS_MODAL_MIN_HEIGHT, availableHeight),
    }
  }, [])

  const notifyError = useCallback((detail) => {
    if (!detail) return
    toast.current?.show({
      severity: 'error',
      summary: 'Error',
      detail,
      life: 3500,
    })
  }, [])

  const notifySuccess = useCallback((detail) => {
    if (!detail) return
    toast.current?.show({
      severity: 'success',
      summary: 'Listo',
      detail,
      life: 2600,
    })
  }, [])

  const loadConfig = useCallback(async () => {
    if (!token || !canUpdate) return
    setConfigLoading(true)
    try {
      const response = await authFetch(`${API_URL}/recordatorios/inspeccion-aleatoria/configuracion/`, {}, token)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo cargar la configuracion.')
      setConfigData({
        hora_recordatorio: payload?.hora_recordatorio ?? '',
        cantidad_productos: payload?.cantidad_productos != null ? String(payload.cantidad_productos) : '',
      })
    } catch (error) {
      notifyError(error?.message || 'No se pudo cargar la configuracion.')
    } finally {
      setConfigLoading(false)
    }
  }, [token, canUpdate, notifyError])

  const sendNow = useCallback(async () => {
    if (!token) return
    setSendNowLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/enviar-ahora/`,
        { method: 'POST' },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo enviar el recordatorio.')
      notifySuccess('Recordatorio enviado correctamente.')
      setShowSendNowDialog(false)
    } catch (error) {
      notifyError(error?.message || 'No se pudo enviar el recordatorio.')
    } finally {
      setSendNowLoading(false)
    }
  }, [token, notifyError, notifySuccess])

  const loadAssignments = useCallback(async () => {
    if (!token || !canUpdate) {
      setAssignmentRows([])
      setAssignmentBranches([])
      return []
    }

    setAssignmentsLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/usuarios/listado/inspeccion-aleatoria-asignaciones/`,
        {},
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudieron cargar los usuarios asignables.')
      }
      const rows = parseApiList(payload)
      const branches = Array.isArray(payload?.sucursales) ? payload.sucursales : []
      setAssignmentRows(rows)
      setAssignmentBranches(branches)
      const map = {}
      rows.forEach((row) => {
        const id = normalizeId(row?.id)
        if (id) {
          map[id] = Array.isArray(row?.inspeccion_aleatoria_sucursales)
            ? row.inspeccion_aleatoria_sucursales.map((v) => normalizeId(v))
            : []
        }
      })
      setLocalAssignmentMap(map)
      return rows
    } catch (error) {
      setAssignmentRows([])
      setAssignmentBranches([])
      notifyError(error?.message || 'No se pudieron cargar los usuarios asignables.')
      return []
    } finally {
      setAssignmentsLoading(false)
    }
  }, [canUpdate, notifyError, token])

  const loadSummary = useCallback(async () => {
    if (!token || !canRead) {
      setSummaryRows([])
      setSelectedBranchId('')
      return []
    }

    setSummaryLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/admin/resumen/`,
        {},
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudo cargar el resumen por sucursal.')
      }
      const rows = parseApiList(payload)
      setSummaryRows(rows)
      setSelectedBranchId((current) => {
        const currentId = normalizeId(current)
        if (currentId && rows.some((row) => normalizeId(row?.sucursal_id) === currentId)) {
          return currentId
        }
        return normalizeId(rows?.[0]?.sucursal_id)
      })
      return rows
    } catch (error) {
      setSummaryRows([])
      setSelectedBranchId('')
      notifyError(error?.message || 'No se pudo cargar el resumen por sucursal.')
      return []
    } finally {
      setSummaryLoading(false)
    }
  }, [canRead, notifyError, token])

  const loadItems = useCallback(async () => {
    const branchId = normalizeId(selectedBranchId)
    if (!token || !canRead || !branchId) {
      setItemsRows([])
      return []
    }

    setItemsLoading(true)
    try {
      const endpoint = new URL(`${API_URL}/recordatorios/inspeccion-aleatoria/admin/items/`)
      endpoint.searchParams.set('sucursal_id', branchId)
      endpoint.searchParams.set('estado', itemsFilter)
      endpoint.searchParams.set('limit', '300')

      const response = await authFetch(endpoint.toString(), {}, token)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudieron cargar las diferencias.')
      }
      const rows = parseApiList(payload)
      setItemsRows(rows)
      return rows
    } catch (error) {
      setItemsRows([])
      notifyError(error?.message || 'No se pudieron cargar las diferencias.')
      return []
    } finally {
      setItemsLoading(false)
    }
  }, [canRead, itemsFilter, notifyError, selectedBranchId, token])

  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  useEffect(() => {
    void loadItems()
  }, [loadItems])

  useEffect(() => {
    assignmentsSizeRef.current = assignmentsModalSize
  }, [assignmentsModalSize])

  useEffect(() => {
    assignmentsPositionRef.current = assignmentsModalPosition
  }, [assignmentsModalPosition])

  useLayoutEffect(() => {
    if (!showAssignmentsDialog) return

    const { availableWidth, availableHeight } = getAssignmentsViewportMetrics()
    const width = Math.min(ASSIGNMENTS_MODAL_MIN_WIDTH, availableWidth)
    const height = Math.min(ASSIGNMENTS_MODAL_MIN_HEIGHT, availableHeight)
    const centeredX = Math.max((window.innerWidth - width) / 2, ASSIGNMENTS_VIEWPORT_PADDING)
    const centeredY = Math.max((window.innerHeight - height) / 2, ASSIGNMENTS_VIEWPORT_PADDING)

    setAssignmentsModalMaximized(false)
    assignmentsRestoreRef.current = null
    setAssignmentsModalSize({ width, height })
    setAssignmentsModalPosition({ x: centeredX, y: centeredY })
  }, [getAssignmentsViewportMetrics, showAssignmentsDialog])

  useEffect(() => {
    if (!showAssignmentsDialog) return undefined

    const handleMouseMove = (event) => {
      if (!assignmentsDragRef.current.active) return
      event.preventDefault()
      const newX = event.clientX - assignmentsDragRef.current.offsetX
      const newY = event.clientY - assignmentsDragRef.current.offsetY
      const maxX = window.innerWidth - assignmentsSizeRef.current.width - ASSIGNMENTS_VIEWPORT_PADDING
      const maxY = window.innerHeight - assignmentsSizeRef.current.height - ASSIGNMENTS_VIEWPORT_PADDING
      setAssignmentsModalPosition({
        x: Math.min(Math.max(newX, ASSIGNMENTS_VIEWPORT_PADDING), Math.max(maxX, ASSIGNMENTS_VIEWPORT_PADDING)),
        y: Math.min(Math.max(newY, ASSIGNMENTS_VIEWPORT_PADDING), Math.max(maxY, ASSIGNMENTS_VIEWPORT_PADDING)),
      })
    }

    const handleMouseUp = () => {
      assignmentsDragRef.current.active = false
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [showAssignmentsDialog])

  useEffect(() => {
    if (!showAssignmentsDialog) return undefined

    const handleWindowResize = () => {
      const { minWidth, minHeight, availableWidth, availableHeight } = getAssignmentsViewportMetrics()

      if (assignmentsModalMaximized) {
        setAssignmentsModalSize({ width: availableWidth, height: availableHeight })
        setAssignmentsModalPosition({ x: ASSIGNMENTS_VIEWPORT_PADDING, y: ASSIGNMENTS_VIEWPORT_PADDING })
        return
      }

      setAssignmentsModalSize((prev) => {
        const width = clamp(prev.width, minWidth, availableWidth)
        const height = clamp(prev.height, minHeight, availableHeight)

        setAssignmentsModalPosition((prevPosition) => ({
          x: Math.min(
            Math.max(prevPosition.x, ASSIGNMENTS_VIEWPORT_PADDING),
            Math.max(window.innerWidth - width - ASSIGNMENTS_VIEWPORT_PADDING, ASSIGNMENTS_VIEWPORT_PADDING)
          ),
          y: Math.min(
            Math.max(prevPosition.y, ASSIGNMENTS_VIEWPORT_PADDING),
            Math.max(window.innerHeight - height - ASSIGNMENTS_VIEWPORT_PADDING, ASSIGNMENTS_VIEWPORT_PADDING)
          ),
        }))

        return { width, height }
      })
    }

    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [assignmentsModalMaximized, getAssignmentsViewportMetrics, showAssignmentsDialog])

  const selectedBranch = useMemo(() => (
    summaryRows.find((row) => normalizeId(row?.sucursal_id) === normalizeId(selectedBranchId)) || null
  ), [selectedBranchId, summaryRows])

  const filteredAssignmentRows = useMemo(() => {
    const search = String(assignmentSearch || '').trim().toLowerCase()
    if (!search) return assignmentRows
    return assignmentRows.filter((row) => {
      const fullName = String(row?.nombre_completo || '').trim().toLowerCase()
      const email = String(row?.correo || '').trim().toLowerCase()
      return fullName.includes(search) || email.includes(search)
    })
  }, [assignmentRows, assignmentSearch])

  const closeEditDialog = useCallback(() => {
    setEditingItem(null)
    setConfirmedQty('')
    setVerificationNote('')
    setSubmitError('')
    setSubmitLoading(false)
  }, [])

  const openEditDialog = useCallback((row) => {
    setEditingItem(row || null)
    const fallback = row?.cantidad_reportada ?? row?.cantidad_esperada ?? 0
    setConfirmedQty(String(Math.max(0, Number.parseInt(String(fallback || 0), 10) || 0)))
    setVerificationNote('')
    setSubmitError('')
    setSubmitLoading(false)
  }, [])

  const closeAssignmentsDialog = useCallback(() => {
    setShowAssignmentsDialog(false)
    setAssignmentSearch('')
    setIsEditingAssignments(false)
  }, [])

  const openAssignmentsDialog = useCallback(() => {
    setShowAssignmentsDialog(true)
    void loadAssignments()
    void loadConfig()
  }, [loadAssignments, loadConfig])

  const handleAssignmentsHeaderMouseDown = useCallback((event) => {
    if (assignmentsModalMaximized) {
      const restore = assignmentsRestoreRef.current
      const fallbackSize = assignmentsSizeRef.current
      const restoredSize = restore?.size || fallbackSize
      const restoredPosition = restore?.position || {
        x: Math.max((window.innerWidth - restoredSize.width) / 2, ASSIGNMENTS_VIEWPORT_PADDING),
        y: Math.max((window.innerHeight - restoredSize.height) / 2, ASSIGNMENTS_VIEWPORT_PADDING),
      }

      assignmentsSizeRef.current = restoredSize
      assignmentsPositionRef.current = restoredPosition
      setAssignmentsModalSize(restoredSize)
      setAssignmentsModalPosition(restoredPosition)
      setAssignmentsModalMaximized(false)

      const offsetX = Math.min(
        Math.max(event.clientX - restoredPosition.x, 24),
        Math.max(restoredSize.width - 24, 24)
      )
      const offsetY = Math.min(
        Math.max(event.clientY - restoredPosition.y, 12),
        56
      )
      assignmentsDragRef.current = {
        active: true,
        offsetX,
        offsetY,
      }
      return
    }

    if (!assignmentsModalRef.current) return
    const rect = assignmentsModalRef.current.getBoundingClientRect()
    assignmentsDragRef.current = {
      active: true,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
  }, [assignmentsModalMaximized])

  const handleAssignmentsResizeMouseDown = useCallback((event) => {
    if (assignmentsModalMaximized) return
    event.preventDefault()
    event.stopPropagation()
    const { minWidth, minHeight } = getAssignmentsViewportMetrics()
    assignmentsResizeRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: assignmentsSizeRef.current.width,
      startHeight: assignmentsSizeRef.current.height,
    }

    const handleResizeMove = (moveEvent) => {
      if (!assignmentsResizeRef.current.active) return
      const deltaX = moveEvent.clientX - assignmentsResizeRef.current.startX
      const deltaY = moveEvent.clientY - assignmentsResizeRef.current.startY
      const maxWidth = Math.max(
        minWidth,
        window.innerWidth - assignmentsPositionRef.current.x - ASSIGNMENTS_VIEWPORT_PADDING
      )
      const maxHeight = Math.max(
        minHeight,
        window.innerHeight - assignmentsPositionRef.current.y - ASSIGNMENTS_VIEWPORT_PADDING
      )
      const width = clamp(assignmentsResizeRef.current.startWidth + deltaX, minWidth, maxWidth)
      const height = clamp(assignmentsResizeRef.current.startHeight + deltaY, minHeight, maxHeight)
      setAssignmentsModalSize({ width, height })
    }

    const handleResizeUp = () => {
      assignmentsResizeRef.current.active = false
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }

    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
  }, [assignmentsModalMaximized, getAssignmentsViewportMetrics])

  const toggleAssignmentsMaximize = useCallback(() => {
    if (assignmentsModalMaximized) {
      const restore = assignmentsRestoreRef.current
      if (restore?.size && restore?.position) {
        setAssignmentsModalSize(restore.size)
        setAssignmentsModalPosition(restore.position)
      }
      setAssignmentsModalMaximized(false)
      return
    }

    assignmentsRestoreRef.current = {
      size: assignmentsSizeRef.current,
      position: assignmentsPositionRef.current,
    }

    const { availableWidth, availableHeight } = getAssignmentsViewportMetrics()
    setAssignmentsModalSize({
      width: availableWidth,
      height: availableHeight,
    })
    setAssignmentsModalPosition({
      x: ASSIGNMENTS_VIEWPORT_PADDING,
      y: ASSIGNMENTS_VIEWPORT_PADDING,
    })
    setAssignmentsModalMaximized(true)
  }, [assignmentsModalMaximized, getAssignmentsViewportMetrics])

  const handleToggleEdit = useCallback(() => {
    if (assignmentsLoading || assignmentsSaving) return
    if (isEditingAssignments) {
      const map = {}
      assignmentRows.forEach((row) => {
        const id = normalizeId(row?.id)
        if (id) {
          map[id] = Array.isArray(row?.inspeccion_aleatoria_sucursales)
            ? row.inspeccion_aleatoria_sucursales.map((v) => normalizeId(v))
            : []
        }
      })
      setLocalAssignmentMap(map)
      setIsEditingAssignments(false)
    } else {
      setIsEditingAssignments(true)
    }
  }, [assignmentsLoading, assignmentsSaving, isEditingAssignments, assignmentRows])

  const handleCheckboxChange = useCallback((rowId, branchId) => {
    setLocalAssignmentMap((prev) => {
      const current = prev[rowId] || []
      const has = current.includes(branchId)
      return {
        ...prev,
        [rowId]: has ? current.filter((id) => id !== branchId) : [...current, branchId],
      }
    })
  }, [])

  const saveAssignments = useCallback(async () => {
    if (!token || !canUpdate) return

    const changes = []
    assignmentRows.forEach((row) => {
      const rowId = normalizeId(row?.id)
      if (!rowId) return
      const original = Array.isArray(row?.inspeccion_aleatoria_sucursales)
        ? row.inspeccion_aleatoria_sucursales.map((v) => normalizeId(v))
        : []
      const local = localAssignmentMap[rowId] || []
      assignmentBranches.forEach((branch) => {
        const branchId = normalizeId(branch?.id)
        if (!branchId) return
        const was = original.includes(branchId)
        const is = local.includes(branchId)
        if (was !== is) changes.push({ rowId, branchId, habilitado: is })
      })
    })

    setAssignmentsSaving(true)
    try {
      const configResponse = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/configuracion/`,
        { method: 'PATCH', body: JSON.stringify(configData) },
        token
      )
      if (!configResponse.ok) {
        const p = await configResponse.json().catch(() => ({}))
        throw new Error(String(p?.detail || '').trim() || 'No se pudo guardar la configuracion.')
      }

      if (changes.length) {
        const results = await Promise.allSettled(
          changes.map((change) =>
            authFetch(
              `${API_URL}/usuarios/listado/${encodeURIComponent(change.rowId)}/inspeccion-aleatoria-asignacion/`,
              {
                method: 'PATCH',
                body: JSON.stringify({ sucursal_id: change.branchId, habilitado: change.habilitado }),
              },
              token
            ).then(async (res) => {
              const payload = await res.json().catch(() => ({}))
              if (!res.ok) throw new Error(String(payload?.detail || '').trim() || 'Error al actualizar.')
              return payload
            })
          )
        )
        const failed = results.filter((r) => r.status === 'rejected')
        if (failed.length) {
          notifyError(`${failed.length} cambio(s) de revisores no se pudieron guardar.`)
        }
      }

      notifySuccess('Cambios guardados correctamente.')
      setIsEditingAssignments(false)
      await Promise.all([loadAssignments(), loadConfig()])
    } catch (error) {
      notifyError(error?.message || 'No se pudieron guardar los cambios.')
    } finally {
      setAssignmentsSaving(false)
    }
  }, [token, canUpdate, assignmentRows, assignmentBranches, localAssignmentMap, configData, loadAssignments, loadConfig, notifyError, notifySuccess])

  const submitVerification = useCallback(async () => {
    if (!token || !editingItem) return

    const nextQty = Number.parseInt(String(confirmedQty || '').trim(), 10)
    if (!Number.isFinite(nextQty) || nextQty < 0) {
      setSubmitError('Debes ingresar una cantidad valida mayor o igual a cero.')
      return
    }

    setSubmitError('')
    setSubmitLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/items/${encodeURIComponent(
          normalizeId(editingItem?.id)
        )}/verificar/`,
        {
          method: 'POST',
          body: JSON.stringify({
            accion: 'aprobar',
            cantidad_confirmada: nextQty,
            nota: String(verificationNote || '').trim(),
          }),
        },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudo guardar la verificacion.')
      }

      notifySuccess('Cantidad confirmada y ajuste aplicado.')
      closeEditDialog()
      await Promise.all([loadSummary(), loadItems()])
    } catch (error) {
      setSubmitError(error?.message || 'No se pudo guardar la verificacion.')
    } finally {
      setSubmitLoading(false)
    }
  }, [closeEditDialog, confirmedQty, editingItem, loadItems, loadSummary, notifySuccess, token, verificationNote])

  const sendNowSummary = useMemo(() => {
    return assignmentBranches.map((branch) => {
      const branchId = normalizeId(branch?.id)
      const reviewers = assignmentRows.filter((row) => {
        const ids = Array.isArray(row?.inspeccion_aleatoria_sucursales)
          ? row.inspeccion_aleatoria_sucursales.map((v) => normalizeId(v))
          : []
        return ids.includes(branchId)
      })
      return { id: branchId, nombre: String(branch?.nombre || '').trim(), reviewers }
    }).filter((b) => b.reviewers.length > 0)
  }, [assignmentBranches, assignmentRows])

  if (!canRead) {
    return (
      <section className="inspection-admin">
        <p className="inspection-admin__empty">No tienes permisos para acceder a esta seccion.</p>
      </section>
    )
  }

  return (
    <section className="inspection-admin">
      <Toast ref={toast} />

      <header className="inspection-admin__head">
        <div>
          <p>Consulta cobertura de inspecciones y corrige cantidades reales reportadas.</p>
        </div>
        <div className="inspection-admin__head-actions">
          {canUpdate && (
            <button
              type="button"
              className="inspection-admin__manage"
              onClick={() => {
                void loadAssignments()
                void loadConfig()
                setShowSendNowDialog(true)
              }}
              disabled={sendNowLoading}
            >
              <Send size={14} />
              Enviar revision ahora
            </button>
          )}
          {canUpdate && (
            <button
              type="button"
              className="inspection-admin__manage"
              onClick={openAssignmentsDialog}
              disabled={assignmentsLoading}
            >
              <Settings size={14} />
              Configuracion
            </button>
          )}
          <button
            type="button"
            className="inspection-admin__refresh"
            onClick={() => {
              void loadSummary()
              void loadItems()
            }}
            disabled={summaryLoading || itemsLoading}
            aria-label="Actualizar resumen de inspecciones"
          >
            <RefreshCw size={14} />
            Actualizar
          </button>
        </div>
      </header>

      <div className="inspection-admin__block">
        <h4>Sucursales</h4>
        <div className="inspection-admin__table-wrap">
          <table className="inspection-admin__table inspection-admin__table--summary">
            <thead>
              <tr>
                <th>Sucursal</th>
                <th>Productos inventario</th>
                <th>Productos revisados</th>
                <th>Cobertura</th>
                <th>Diferencias</th>
                <th>Pendientes verificacion</th>
                <th>Ultima revision</th>
              </tr>
            </thead>
            <tbody>
              {!summaryRows.length ? (
                <tr className="inspection-admin__empty-row">
                  <td colSpan={7} />
                </tr>
              ) : summaryRows.map((row) => {
                const rowId = normalizeId(row?.sucursal_id)
                const selected = rowId && rowId === normalizeId(selectedBranchId)
                return (
                  <tr
                    key={`inspection-branch-${rowId}`}
                    className={`inspection-admin__summary-row${selected ? ' is-selected' : ''}`}
                    onClick={() => setSelectedBranchId(rowId)}
                  >
                    <td>{String(row?.sucursal_nombre || `Sucursal ${row?.sucursal_id || '-'}`).trim()}</td>
                    <td>{Number.parseInt(String(row?.total_productos_inventario || 0), 10) || 0}</td>
                    <td>{Number.parseInt(String(row?.productos_revisados || 0), 10) || 0}</td>
                    <td>{formatPercent(row?.cobertura_porcentaje)}</td>
                    <td>{Number.parseInt(String(row?.diferencias_reportadas || 0), 10) || 0}</td>
                    <td>{Number.parseInt(String(row?.pendientes_verificacion || 0), 10) || 0}</td>
                    <td>{formatDateTime(row?.ultima_revision)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {summaryLoading && (
            <p className="inspection-admin__loading">
              <Loader2 size={14} />
              Cargando resumen...
            </p>
          )}
        </div>
      </div>

      <div className="inspection-admin__block">
        <div className="inspection-admin__subhead">
          <h4>
            Diferencias reportadas
            {selectedBranch ? ` - ${String(selectedBranch?.sucursal_nombre || '').trim()}` : ''}
          </h4>
          <select
            value={itemsFilter}
            onChange={(event) => setItemsFilter(String(event.target.value || 'pendiente'))}
            disabled={itemsLoading}
          >
            <option value="pendiente">Pendientes</option>
            <option value="diferencias">Con diferencia</option>
            <option value="verificado">Verificadas</option>
            <option value="todos">Todas</option>
          </select>
        </div>

        <div className="inspection-admin__table-wrap">
          <table className="inspection-admin__table inspection-admin__table--items">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Producto</th>
                <th>Esperada</th>
                <th>Reportada</th>
                <th>Confirmada</th>
                <th>Revision</th>
                <th>Verificacion</th>
                <th>Inspeccion de</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {!itemsRows.length ? (
                <tr className="inspection-admin__empty-row">
                  <td colSpan={9} />
                </tr>
              ) : itemsRows.map((row) => {
                const canFix = (
                  canUpdate &&
                  String(row?.estado_revision || '').trim().toLowerCase() === 'no_coincide' &&
                  String(row?.verificacion_estado || '').trim().toLowerCase() === 'pendiente'
                )
                return (
                  <tr key={`inspection-item-${normalizeId(row?.id)}`}>
                    <td>{formatDateTime(row?.revisado_en || row?.fecha_programada)}</td>
                    <td>
                      <div className="inspection-admin__product-cell">
                        <strong>{String(row?.producto_codigo || '').trim() || `#${row?.producto_id || '-'}`}</strong>
                        <span>{String(row?.producto_nombre || 'Producto').trim()}</span>
                      </div>
                    </td>
                    <td>{Number.parseInt(String(row?.cantidad_esperada || 0), 10) || 0}</td>
                    <td>{row?.cantidad_reportada == null ? '-' : Number.parseInt(String(row?.cantidad_reportada || 0), 10) || 0}</td>
                    <td>{row?.cantidad_confirmada == null ? '-' : Number.parseInt(String(row?.cantidad_confirmada || 0), 10) || 0}</td>
                    <td>{formatReviewState(row?.estado_revision)}</td>
                    <td>{formatVerificationState(row?.verificacion_estado)}</td>
                    <td>{String(row?.inspeccion_usuario_nombre || '-').trim() || '-'}</td>
                    <td>
                      {canFix ? (
                        <button
                          type="button"
                          className="inspection-admin__action"
                          onClick={() => openEditDialog(row)}
                        >
                          <Wrench size={13} />
                          Ajustar cantidad
                        </button>
                      ) : (
                        <span className="inspection-admin__action-placeholder">Sin accion</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {itemsLoading && (
            <p className="inspection-admin__loading">
              <Loader2 size={14} />
              Cargando diferencias...
            </p>
          )}
        </div>
      </div>

      {editingItem && (
        <div className="inspection-admin__dialog-overlay" onMouseDown={closeEditDialog}>
          <div
            className="inspection-admin__dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Ajustar cantidad real"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="inspection-admin__dialog-head">
              <div>
                <h4>Ajustar cantidad real</h4>
                <p>
                  {String(editingItem?.producto_codigo || '').trim() || '#'} - {String(editingItem?.producto_nombre || '').trim()}
                </p>
              </div>
              <button
                type="button"
                className="inspection-admin__dialog-close"
                onClick={closeEditDialog}
                disabled={submitLoading}
                aria-label="Cerrar"
              >
                <X size={16} />
              </button>
            </header>

            <div className="inspection-admin__dialog-body">
              <div className="inspection-admin__dialog-grid">
                <label>
                  <span>Cantidad esperada</span>
                  <input type="number" value={Number.parseInt(String(editingItem?.cantidad_esperada || 0), 10) || 0} disabled />
                </label>
                <label>
                  <span>Cantidad reportada</span>
                  <input
                    type="number"
                    value={editingItem?.cantidad_reportada == null ? 0 : Number.parseInt(String(editingItem?.cantidad_reportada || 0), 10) || 0}
                    disabled
                  />
                </label>
              </div>

              <label>
                <span>Cantidad real confirmada</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={confirmedQty}
                  onChange={(event) => setConfirmedQty(String(event.target.value || '0'))}
                  disabled={submitLoading}
                />
              </label>

              <label>
                <span>Nota (opcional)</span>
                <textarea
                  rows={3}
                  value={verificationNote}
                  onChange={(event) => setVerificationNote(String(event.target.value || ''))}
                  placeholder="Observacion de verificacion"
                  disabled={submitLoading}
                />
              </label>

              {submitError && <p className="inspection-admin__dialog-error">{submitError}</p>}
            </div>

            <footer className="inspection-admin__dialog-actions">
              <button
                type="button"
                className="inspection-admin__btn inspection-admin__btn--ghost"
                onClick={closeEditDialog}
                disabled={submitLoading}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="inspection-admin__btn inspection-admin__btn--primary"
                onClick={() => void submitVerification()}
                disabled={submitLoading}
              >
                {submitLoading ? 'Guardando...' : 'Guardar cantidad'}
              </button>
            </footer>
          </div>
        </div>
      )}

      {showSendNowDialog && (
        <div className="inspection-admin__dialog-overlay" onMouseDown={() => !sendNowLoading && setShowSendNowDialog(false)}>
          <div
            className="inspection-admin__dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Enviar revision ahora"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className="inspection-admin__dialog-head">
              <div>
                <h4>Enviar revision ahora</h4>
                <p>Resumen del recordatorio que se enviara de inmediato.</p>
              </div>
              <button
                type="button"
                className="inspection-admin__dialog-close"
                onClick={() => setShowSendNowDialog(false)}
                disabled={sendNowLoading}
                aria-label="Cerrar"
              >
                <X size={16} />
              </button>
            </header>

            <div className="inspection-admin__dialog-body">
              <div className="inspection-admin__sendnow-summary">
                <div className="inspection-admin__sendnow-row">
                  <span className="inspection-admin__sendnow-label">Productos por inspeccion</span>
                  <strong className="inspection-admin__sendnow-value">
                    {configData.cantidad_productos || '—'}
                  </strong>
                </div>
                <div className="inspection-admin__sendnow-row">
                  <span className="inspection-admin__sendnow-label">Hora de recordatorio</span>
                  <strong className="inspection-admin__sendnow-value">
                    {configData.hora_recordatorio || '—'}
                  </strong>
                </div>
              </div>

              {sendNowSummary.length === 0 ? (
                <p className="inspection-admin__sendnow-empty">
                  No hay revisores asignados. Configura los revisores antes de enviar.
                </p>
              ) : (
                <div className="inspection-admin__sendnow-branches">
                  <p className="inspection-admin__sendnow-branches-title">Revisores que recibiran el recordatorio:</p>
                  {sendNowSummary.map((branch) => (
                    <div key={`sendnow-branch-${branch.id}`} className="inspection-admin__sendnow-branch">
                      <span className="inspection-admin__sendnow-branch-name">{branch.nombre}</span>
                      <ul className="inspection-admin__sendnow-users">
                        {branch.reviewers.map((u) => (
                          <li key={`sendnow-user-${normalizeId(u?.id)}`}>
                            {String(u?.nombre_completo || u?.correo || `Usuario ${u?.id}`).trim()}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <footer className="inspection-admin__dialog-actions">
              <button
                type="button"
                className="inspection-admin__btn inspection-admin__btn--ghost"
                onClick={() => setShowSendNowDialog(false)}
                disabled={sendNowLoading}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="inspection-admin__btn inspection-admin__btn--primary"
                onClick={() => void sendNow()}
                disabled={sendNowLoading || sendNowSummary.length === 0}
              >
                {sendNowLoading ? 'Enviando...' : 'Enviar ahora'}
              </button>
            </footer>
          </div>
        </div>
      )}

      {showAssignmentsDialog && typeof document !== 'undefined' && createPortal(
        <div
          className={`create-user__overlay inspection-admin__reviewers-overlay${isDarkTheme ? ' inspection-admin__reviewers-overlay--dark' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label="Configuracion de inspeccion aleatoria"
        >
          <div
            ref={assignmentsModalRef}
            className="create-user__modal"
            style={{
              top: assignmentsModalPosition.y,
              left: assignmentsModalPosition.x,
              width: assignmentsModalSize.width,
              height: assignmentsModalSize.height,
            }}
          >
            <header className="create-user__header" onMouseDown={handleAssignmentsHeaderMouseDown}>
              <div className="create-user__header-text">
                <h3>Configuracion</h3>
              </div>
              <div className="create-user__header-actions">
                <button
                  type="button"
                  className="create-user__icon-button create-user__icon-button--maximize"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={toggleAssignmentsMaximize}
                  aria-label={assignmentsModalMaximized ? 'Restaurar' : 'Maximizar'}
                >
                  <i className={assignmentsModalMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="create-user__icon-button"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={closeAssignmentsDialog}
                  aria-label="Cerrar"
                >
                  <i className="pi pi-times" aria-hidden="true" />
                </button>
              </div>
            </header>

            <div className="create-user__form">
              <div className="create-user__tabs" role="tablist" aria-label="Secciones de configuracion">
                <button
                  type="button"
                  className="create-user__tab create-user__tab--active"
                  role="tab"
                  aria-selected="true"
                >
                  Configuracion
                </button>
              </div>

              <div className="create-user__body create-user__body--permissions">
                <section className="create-user__section create-user__section--permissions">
                  <div className="create-user__section-header">
                    <div>
                      <h4>Parametros generales</h4>
                    </div>
                  </div>

                  <div className="inspection-admin__config-fields">
                    <label className="create-user__field">
                      <span>Productos a revisar por inspeccion</span>
                      <input
                        type="number"
                        min="1"
                        max="200"
                        step="1"
                        value={configData.cantidad_productos}
                        onChange={(e) => setConfigData((prev) => ({ ...prev, cantidad_productos: e.target.value }))}
                        placeholder="Ej: 5"
                        disabled={!isEditingAssignments || configLoading || assignmentsSaving}
                      />
                    </label>
                    <label className="create-user__field">
                      <span>Hora de envio del recordatorio</span>
                      <input
                        type="time"
                        value={configData.hora_recordatorio}
                        onChange={(e) => setConfigData((prev) => ({ ...prev, hora_recordatorio: e.target.value }))}
                        disabled={!isEditingAssignments || configLoading || assignmentsSaving}
                      />
                    </label>
                  </div>

                  <div className="create-user__section-header" style={{ marginTop: '16px' }}>
                    <div>
                      <h4>Revisores por sucursal</h4>
                      <p className="create-user__hint">
                        Escoge por sucursal que usuarios deben hacer la revision diaria. Al asignar una sucursal, tambien se sincroniza Ver inventario.
                      </p>
                    </div>
                  </div>

                  <div className="inspection-admin__reviewers-toolbar">
                    <label className="create-user__field inspection-admin__reviewers-search">
                      <span>Buscar usuario</span>
                      <input
                        type="text"
                        value={assignmentSearch}
                        onChange={(event) => setAssignmentSearch(String(event.target.value || ''))}
                        placeholder="Buscar por nombre o correo"
                      />
                    </label>
                  </div>

                  <div className="inspection-admin__reviewers-table-card">
                    <div className="inspection-admin__table-wrap inspection-admin__table-wrap--modal">
                      <table className="inspection-admin__table inspection-admin__table--assignments">
                        <thead>
                          <tr>
                            <th>Usuario</th>
                            {assignmentBranches.map((branch) => (
                              <th key={`inspection-assignment-branch-${normalizeId(branch?.id)}`}>
                                {String(branch?.nombre || `Sucursal ${branch?.id || '-'}`).trim()}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {!filteredAssignmentRows.length ? (
                            <tr className="inspection-admin__empty-row">
                              <td colSpan={Math.max(1 + assignmentBranches.length, 2)} />
                            </tr>
                          ) : filteredAssignmentRows.map((row) => {
                            const rowId = normalizeId(row?.id)
                            return (
                              <tr key={`inspection-assignment-${rowId}`}>
                                <td>
                                  <div className="inspection-admin__product-cell">
                                    <strong>{String(row?.nombre_completo || `Usuario ${row?.id || '-'}`).trim()}</strong>
                                    <span className="inspection-admin__product-cell__email">{String(row?.correo || '-').trim()}</span>
                                    <span className="inspection-admin__product-cell__type">{row?.es_administrador ? 'Administrador' : 'Usuario interno'}</span>
                                  </div>
                                </td>
                                {assignmentBranches.map((branch) => {
                                  const branchId = normalizeId(branch?.id)
                                  return (
                                    <td key={`inspection-assignment-${rowId}-branch-${branchId}`}>
                                      <label className="inspection-admin__assignment-toggle">
                                        <input
                                          type="checkbox"
                                          checked={(localAssignmentMap[rowId] || []).includes(branchId)}
                                          onChange={() => handleCheckboxChange(rowId, branchId)}
                                          disabled={!isEditingAssignments || assignmentsSaving || assignmentsLoading}
                                        />
                                      </label>
                                    </td>
                                  )
                                })}
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>

                      {assignmentsLoading && (
                        <p className="inspection-admin__loading">
                          <Loader2 size={14} />
                          Cargando usuarios...
                        </p>
                      )}
                    </div>
                  </div>
                </section>
              </div>

              <div className="create-user__footer">
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="create-user__action create-user__action--cancel"
                    onClick={closeAssignmentsDialog}
                  >
                    Cerrar
                  </button>
                  {canUpdate && (
                    <button
                      type="button"
                      className={`create-user__action inspection-admin__edit-toggle${isEditingAssignments ? ' inspection-admin__edit-toggle--active' : ''}`}
                      onClick={handleToggleEdit}
                      disabled={assignmentsLoading || assignmentsSaving}
                    >
                      {isEditingAssignments ? (
                        <>
                          <span className="inspection-admin__toggle-icon" aria-hidden="true"><Eye size={15} /></span>
                          <span>Solo lectura</span>
                        </>
                      ) : (
                        <>
                          <span className="inspection-admin__toggle-icon" aria-hidden="true"><Pencil size={15} /></span>
                          <span>Editar</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
                {isEditingAssignments && (
                  <button
                    type="button"
                    className="create-user__action create-user__action--primary"
                    onClick={() => void saveAssignments()}
                    disabled={assignmentsLoading || assignmentsSaving}
                  >
                    {assignmentsSaving ? 'Guardando...' : 'Actualizar'}
                  </button>
                )}
              </div>
            </div>

            <button
              type="button"
              aria-label="Cambiar tamaño de ventana"
              className="create-user__resize-handle"
              onMouseDown={handleAssignmentsResizeMouseDown}
            />
          </div>
        </div>,
        document.body
      )}
    </section>
  )
}

export default RandomInspectionAdminTable
