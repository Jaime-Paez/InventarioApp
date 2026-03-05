import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bell, Moon, Search, SunMedium } from 'lucide-react'
import { Toast } from 'primereact/toast'
import './QuickActions.css'
import RecordatoriosPopup from './RecordatoriosPopup'
import {
  REMINDERS_STORAGE_KEY,
  REMINDERS_SYNC_EVENT,
  buildUserIdSet,
  createReminderId,
  emitRemindersSync,
  formatCurrentUserName,
  getReminderDeadlineTimestamp,
  isReminderCreatedByCurrentUser,
  isReminderForCurrentUser,
  isReminderPendingForCurrentUser,
  isSpecialTransferDecisionReminder,
  normalizeId,
  readRemindersFromStorage,
  reminderCompletedByIds,
  sanitizeRecipient,
  sortRemindersForCurrentUser,
  writeRemindersToStorage,
} from '../common/reminders/remindersStorage'

const URGENT_SHIELD_NEAR_FULL_MS = 60 * 60 * 1000
const URGENT_MESSAGE = 'Tienes una solicitud de traslado pendiente.'

function QuickActions({ darkMode, onToggleTheme, token, user, onTransferDecisionAccepted }) {
  const wrapRef = useRef(null)
  const btnRefs = useRef([])
  const reminderButtonRef = useRef(null)
  const moveTimerRef = useRef(null)
  const toast = useRef(null)

  const [blob, setBlob] = useState({ x: 0, y: 0, w: 0, h: 0, visible: false })
  const [isMoving, setIsMoving] = useState(false)
  const [isReminderModalOpen, setIsReminderModalOpen] = useState(false)
  const [reminders, setReminders] = useState(() => readRemindersFromStorage())
  const [clockTick, setClockTick] = useState(() => Date.now())
  const [focusReminderId, setFocusReminderId] = useState('')

  const currentUserIds = useMemo(() => buildUserIdSet(user), [user])
  const currentUserIdValues = useMemo(() => Array.from(currentUserIds), [currentUserIds])
  const currentPrimaryUserId = currentUserIdValues[0] || ''
  const currentUserName = useMemo(() => formatCurrentUserName(user), [user])

  const showErrorToast = useCallback((message) => {
    if (!message) return
    toast.current?.show({
      severity: 'error',
      summary: 'Error',
      detail: message,
      life: 3400,
    })
  }, [])

  const hasPendingReminder = useMemo(
    () => reminders.some((reminder) => isReminderPendingForCurrentUser(reminder, currentUserIds)),
    [reminders, currentUserIds]
  )

  const urgentDecisionReminder = useMemo(() => {
    const pendingSpecial = reminders
      .filter(
        (reminder) =>
          isSpecialTransferDecisionReminder(reminder) &&
          isReminderPendingForCurrentUser(reminder, currentUserIds)
      )
      .sort((a, b) => {
        const deadlineA = getReminderDeadlineTimestamp(a)
        const deadlineB = getReminderDeadlineTimestamp(b)
        if (Number.isFinite(deadlineA) && Number.isFinite(deadlineB)) return deadlineA - deadlineB
        if (Number.isFinite(deadlineA)) return -1
        if (Number.isFinite(deadlineB)) return 1
        return String(a?.createdAt || '').localeCompare(String(b?.createdAt || ''))
      })

    return pendingSpecial[0] || null
  }, [reminders, currentUserIds])

  const urgentDecisionProgress = useMemo(() => {
    if (!urgentDecisionReminder) return 0
    const deadline = getReminderDeadlineTimestamp(urgentDecisionReminder)
    const createdAt = Date.parse(String(urgentDecisionReminder?.createdAt || ''))
    const now = Number(clockTick || Date.now())

    if (!Number.isFinite(createdAt)) {
      if (!Number.isFinite(deadline)) return 0
      return now >= deadline ? 1 : 0
    }

    const elapsed = Math.max(0, now - createdAt)
    const deadlineWindow = Number.isFinite(deadline) ? Math.max(1, deadline - createdAt) : Number.POSITIVE_INFINITY
    const growthWindow = Math.min(URGENT_SHIELD_NEAR_FULL_MS, deadlineWindow)
    const ratio = elapsed / growthWindow
    return Math.max(0, Math.min(1, ratio))
  }, [clockTick, urgentDecisionReminder])

  const urgentShieldStyle = useMemo(() => {
    if (!urgentDecisionReminder || isReminderModalOpen || typeof window === 'undefined') return null
    const button = reminderButtonRef.current
    if (!button) return null

    const rect = button.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2 + 8
    const centerY = rect.top + rect.height / 2 - 6
    const maxCanvas = Math.max(window.innerWidth, window.innerHeight) * 1.35
    const size = Math.max(44, Math.round(44 + maxCanvas * urgentDecisionProgress))

    return {
      width: `${size}px`,
      height: `${size}px`,
      left: `${centerX - size / 2}px`,
      top: `${centerY - size / 2}px`,
      '--urgency': String(urgentDecisionProgress.toFixed(3)),
    }
  }, [isReminderModalOpen, urgentDecisionProgress, urgentDecisionReminder, clockTick])

  const urgentMessageStyle = useMemo(() => {
    if (!urgentShieldStyle) return null
    const shieldSize = Number.parseFloat(urgentShieldStyle.width)
    const shieldLeft = Number.parseFloat(urgentShieldStyle.left)
    const shieldTop = Number.parseFloat(urgentShieldStyle.top)

    if (!Number.isFinite(shieldSize) || !Number.isFinite(shieldLeft) || !Number.isFinite(shieldTop)) {
      return null
    }

    const clamp01 = (value) => Math.max(0, Math.min(1, value))
    const progress = clamp01(urgentDecisionProgress)
    const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth
    const viewportHeight = typeof window === 'undefined' ? 720 : window.innerHeight

    const shieldCenterX = shieldLeft + shieldSize / 2
    const shieldCenterY = shieldTop + shieldSize / 2
    const viewportCenterX = viewportWidth / 2
    const viewportCenterY = viewportHeight / 2
    const vectorX = viewportCenterX - shieldCenterX
    const vectorY = viewportCenterY - shieldCenterY

    const edgePadding = 12
    const radius = shieldSize / 2
    const usableRadius = Math.max(1, radius - edgePadding)

    const minFont = 12
    const maxFont = 64
    let fontSize = Math.round(minFont + (maxFont - minFont) * progress)

    const minWidth = 240
    const maxWidth = Math.min(980, viewportWidth - edgePadding * 2)
    let width = Math.round(minWidth + (maxWidth - minWidth) * progress)
    width = Math.max(180, Math.min(width, maxWidth, Math.max(180, shieldSize - 16)))

    const estimateHeight = (boxWidth, size) => {
      const charsPerLine = Math.max(10, Math.floor(boxWidth / Math.max(1, size * 0.55)))
      const lines = Math.max(1, Math.ceil(URGENT_MESSAGE.length / charsPerLine))
      return Math.max(size * 1.25, lines * size * 1.22)
    }

    let height = estimateHeight(width, fontSize)
    let halfDiagonal = Math.hypot(width / 2, height / 2)

    while (halfDiagonal > usableRadius && fontSize > 9) {
      fontSize -= 1
      height = estimateHeight(width, fontSize)
      halfDiagonal = Math.hypot(width / 2, height / 2)
    }

    if (halfDiagonal > usableRadius) {
      width = Math.max(130, Math.min(width, Math.max(130, usableRadius * 1.35)))
      height = estimateHeight(width, fontSize)
      halfDiagonal = Math.hypot(width / 2, height / 2)
    }

    while (halfDiagonal > usableRadius && fontSize > 6) {
      fontSize -= 1
      height = estimateHeight(width, fontSize)
      halfDiagonal = Math.hypot(width / 2, height / 2)
    }

    const minCenterX = edgePadding + width / 2
    const maxCenterX = viewportWidth - edgePadding - width / 2
    const minCenterY = edgePadding + height / 2
    const maxCenterY = viewportHeight - edgePadding - height / 2

    let maxTViewport = 1
    if (Math.abs(vectorX) > 0.001) {
      const tX = vectorX > 0 ? (maxCenterX - shieldCenterX) / vectorX : (minCenterX - shieldCenterX) / vectorX
      maxTViewport = Math.min(maxTViewport, tX)
    }
    if (Math.abs(vectorY) > 0.001) {
      const tY = vectorY > 0 ? (maxCenterY - shieldCenterY) / vectorY : (minCenterY - shieldCenterY) / vectorY
      maxTViewport = Math.min(maxTViewport, tY)
    }
    maxTViewport = clamp01(maxTViewport)

    let maxTCircle = 1
    const absVx = Math.abs(vectorX)
    const absVy = Math.abs(vectorY)
    const A = absVx * absVx + absVy * absVy
    const B = absVx * width + absVy * height
    const C = (width / 2) ** 2 + (height / 2) ** 2 - usableRadius ** 2

    if (A <= 1e-8) {
      maxTCircle = C <= 0 ? 1 : 0
    } else {
      const discriminant = B * B - 4 * A * C
      if (discriminant < 0) {
        maxTCircle = 0
      } else {
        maxTCircle = (-B + Math.sqrt(discriminant)) / (2 * A)
      }
    }
    maxTCircle = clamp01(maxTCircle)

    const travel = clamp01(Math.min(progress, maxTViewport, maxTCircle))
    const centerX = shieldCenterX + vectorX * travel
    const centerY = shieldCenterY + vectorY * travel

    return {
      left: `${centerX}px`,
      top: `${centerY}px`,
      width: `${width}px`,
      fontSize: `${fontSize}px`,
    }
  }, [urgentDecisionProgress, urgentShieldStyle])

  const personalReminders = useMemo(() => {
    const related = reminders.filter(
      (reminder) =>
        isReminderForCurrentUser(reminder, currentUserIds) ||
        isReminderCreatedByCurrentUser(reminder, currentUserIds, currentUserName)
    )

    return sortRemindersForCurrentUser(related, currentUserIds)
  }, [reminders, currentUserIds, currentUserName])

  const setBtnRef = (index) => (element) => {
    btnRefs.current[index] = element
  }

  const handleReminderButtonRef = useCallback((element) => {
    btnRefs.current[1] = element
    const hadButton = Boolean(reminderButtonRef.current)
    reminderButtonRef.current = element
    if (!hadButton && element) {
      setClockTick(Date.now())
    }
  }, [])

  const measure = (index) => {
    const wrap = wrapRef.current
    const button = btnRefs.current[index]
    if (!wrap || !button) return null

    const wrapRect = wrap.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()

    return {
      x: buttonRect.left - wrapRect.left,
      y: buttonRect.top - wrapRect.top,
      w: buttonRect.width,
      h: buttonRect.height,
    }
  }

  const startMoveFx = () => {
    if (moveTimerRef.current) clearTimeout(moveTimerRef.current)
    setIsMoving(true)
    moveTimerRef.current = setTimeout(() => setIsMoving(false), 420)
  }

  const showAndMove = (index) => {
    const measured = measure(index)
    if (!measured) return

    setBlob((prev) => ({
      ...prev,
      ...measured,
      visible: true,
    }))

    startMoveFx()
  }

  const hideBlob = () => {
    setBlob((prev) => ({ ...prev, visible: false }))
    setIsMoving(false)
  }

  useEffect(() => {
    const handleResize = () => {
      hideBlob()
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    return () => {
      if (moveTimerRef.current) clearTimeout(moveTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const timer = window.setInterval(() => setClockTick(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !urgentDecisionReminder || isReminderModalOpen) return undefined
    const syncLayout = () => setClockTick(Date.now())

    window.addEventListener('resize', syncLayout)
    window.addEventListener('scroll', syncLayout, true)

    return () => {
      window.removeEventListener('resize', syncLayout)
      window.removeEventListener('scroll', syncLayout, true)
    }
  }, [urgentDecisionReminder, isReminderModalOpen])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const syncReminders = (event) => {
      if (event?.type === 'storage' && event.key && event.key !== REMINDERS_STORAGE_KEY) return
      setReminders(readRemindersFromStorage())
    }

    window.addEventListener('storage', syncReminders)
    window.addEventListener(REMINDERS_SYNC_EVENT, syncReminders)

    return () => {
      window.removeEventListener('storage', syncReminders)
      window.removeEventListener(REMINDERS_SYNC_EVENT, syncReminders)
    }
  }, [])

  const applyReminderUpdate = (updater) => {
    setReminders((prev) => {
      const source = Array.isArray(prev) ? prev : []
      const next = typeof updater === 'function' ? updater(source) : updater
      const normalized = writeRemindersToStorage(next)
      emitRemindersSync()
      return normalized
    })
  }

  const handleCreateReminder = ({ date, time, description, recipients, context }) => {
    const normalizedDate = String(date || '').trim()
    const normalizedTime = String(time || '').trim()
    const normalizedDescription = String(description || '').trim()
    const normalizedRecipients = (Array.isArray(recipients) ? recipients : [])
      .map(sanitizeRecipient)
      .filter(Boolean)

    if (!normalizedDate || !normalizedTime || !normalizedDescription || !normalizedRecipients.length) {
      return false
    }

    const contextType = normalizeId(context?.type)
    const contextId = normalizeId(context?.id)
    const normalizedContext =
      contextType && contextId
        ? {
            type: contextType,
            id: contextId,
            label: String(context?.label || '').trim(),
          }
        : null

    applyReminderUpdate((prev) => [
      {
        id: createReminderId(),
        date: normalizedDate,
        time: normalizedTime,
        description: normalizedDescription,
        creator: {
          id: currentPrimaryUserId,
          name: currentUserName,
        },
        recipients: normalizedRecipients,
        context: normalizedContext,
        createdAt: new Date().toISOString(),
        completedBy: [],
      },
      ...prev,
    ])

    return true
  }

  const handleMarkReminderSeen = (reminderId) => {
    const normalizedReminderId = normalizeId(reminderId)
    if (!normalizedReminderId || !currentUserIdValues.length) return

    applyReminderUpdate((prev) =>
      prev.map((reminder) => {
        if (normalizeId(reminder?.id) !== normalizedReminderId) return reminder

        const completedBySet = new Set(reminderCompletedByIds(reminder))
        currentUserIdValues.forEach((id) => completedBySet.add(id))

        return {
          ...reminder,
          completedBy: Array.from(completedBySet),
        }
      })
    )
  }

  const openReminderModal = useCallback(
    (reminderId = '') => {
      const normalizedReminderId = normalizeId(reminderId)
      if (normalizedReminderId) {
        setFocusReminderId(normalizedReminderId)
      }
      setIsReminderModalOpen(true)
    },
    []
  )

  const closeReminderModal = useCallback(() => {
    setIsReminderModalOpen(false)
    setFocusReminderId('')
  }, [])

  const handleUrgentShieldClick = () => {
    const reminderId = normalizeId(urgentDecisionReminder?.id)
    openReminderModal(reminderId)
  }

  return (
    <>
      <Toast ref={toast} />
      {urgentShieldStyle && (
        <button
          type="button"
          className="quick-actions__urgent-shield"
          style={urgentShieldStyle}
          onClick={handleUrgentShieldClick}
          aria-label="Resolver solicitud de traslado pendiente"
        />
      )}
      {urgentMessageStyle && (
        <div className="quick-actions__urgent-message" style={urgentMessageStyle} aria-hidden="true">
          {URGENT_MESSAGE}
        </div>
      )}
      <div
        ref={wrapRef}
        className={`quick-actions ${darkMode ? 'dark' : 'light'}${urgentShieldStyle ? ' has-urgent-shield' : ''}`}
        onMouseLeave={hideBlob}
      >
        <span
          className={[
            'quick-actions__blob',
            blob.visible ? 'is-visible' : '',
            isMoving ? 'is-moving' : '',
          ].join(' ')}
          style={{
            transform: `translate3d(${blob.x}px, ${blob.y}px, 0)`,
            width: `${blob.w}px`,
            height: `${blob.h}px`,
          }}
          aria-hidden="true"
        />

        <button
          ref={setBtnRef(0)}
          type="button"
          className="quick-actions__button"
          aria-label="Buscar"
          onMouseEnter={() => showAndMove(0)}
          onFocus={() => showAndMove(0)}
        >
          <Search />
        </button>

        <button
          ref={handleReminderButtonRef}
          type="button"
          className={`quick-actions__button quick-actions__button--reminders${isReminderModalOpen ? ' is-active' : ''}`}
          aria-label="Recordatorios"
          onClick={() => openReminderModal()}
          onMouseEnter={() => showAndMove(1)}
          onFocus={() => showAndMove(1)}
        >
          <Bell />
          {hasPendingReminder && (
            <span
              className="quick-actions__pending-dot"
              aria-hidden="true"
            />
          )}
        </button>

        <button
          ref={setBtnRef(2)}
          type="button"
          className="quick-actions__button"
          aria-label={darkMode ? 'Activar modo claro' : 'Activar modo oscuro'}
          onClick={onToggleTheme}
          onMouseEnter={() => showAndMove(2)}
          onFocus={() => showAndMove(2)}
        >
          {darkMode ? <SunMedium /> : <Moon />}
        </button>
      </div>

      <RecordatoriosPopup
        open={isReminderModalOpen}
        onClose={closeReminderModal}
        token={token}
        currentUser={user}
        currentUserName={currentUserName}
        currentUserIds={currentUserIdValues}
        reminders={personalReminders}
        onCreateReminder={handleCreateReminder}
        onMarkReminderSeen={handleMarkReminderSeen}
        darkMode={darkMode}
        onError={showErrorToast}
        onApplyRemindersUpdate={applyReminderUpdate}
        focusReminderId={focusReminderId}
        onFocusReminderHandled={() => setFocusReminderId('')}
        onTransferDecisionAccepted={onTransferDecisionAccepted}
      />
    </>
  )
}

export default QuickActions
