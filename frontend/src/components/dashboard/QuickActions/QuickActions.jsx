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

function QuickActions({ darkMode, onToggleTheme, token, user }) {
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

    if (!Number.isFinite(deadline)) return 0
    if (!Number.isFinite(createdAt) || createdAt >= deadline) {
      return now >= deadline ? 1 : 0
    }

    const ratio = (now - createdAt) / (deadline - createdAt)
    return Math.max(0, Math.min(1, ratio))
  }, [clockTick, urgentDecisionReminder])

  const urgentDotSize = useMemo(
    () => 7 + Math.round(urgentDecisionProgress * 20),
    [urgentDecisionProgress]
  )

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
      <div
        ref={wrapRef}
        className={`quick-actions ${darkMode ? 'dark' : 'light'}`}
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
              className={`quick-actions__pending-dot${urgentDecisionReminder ? ' is-urgent' : ''}`}
              style={urgentDecisionReminder ? { width: urgentDotSize, height: urgentDotSize } : undefined}
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
      />
    </>
  )
}

export default QuickActions
