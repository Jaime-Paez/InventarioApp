import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, Moon, Search, SunMedium } from 'lucide-react'
import './QuickActions.css'
import RecordatoriosPopup from './RecordatoriosPopup'
import {
  REMINDERS_STORAGE_KEY,
  REMINDERS_SYNC_EVENT,
  buildUserIdSet,
  createReminderId,
  emitRemindersSync,
  formatCurrentUserName,
  isReminderCreatedByCurrentUser,
  isReminderForCurrentUser,
  isReminderPendingForCurrentUser,
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
  const moveTimerRef = useRef(null)

  const [blob, setBlob] = useState({ x: 0, y: 0, w: 0, h: 0, visible: false })
  const [isMoving, setIsMoving] = useState(false)
  const [isReminderModalOpen, setIsReminderModalOpen] = useState(false)
  const [reminders, setReminders] = useState(() => readRemindersFromStorage())

  const currentUserIds = useMemo(() => buildUserIdSet(user), [user])
  const currentUserIdValues = useMemo(() => Array.from(currentUserIds), [currentUserIds])
  const currentPrimaryUserId = currentUserIdValues[0] || ''
  const currentUserName = useMemo(() => formatCurrentUserName(user), [user])

  const hasPendingReminder = useMemo(
    () => reminders.some((reminder) => isReminderPendingForCurrentUser(reminder, currentUserIds)),
    [reminders, currentUserIds]
  )

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

  return (
    <>
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
          ref={setBtnRef(1)}
          type="button"
          className={`quick-actions__button quick-actions__button--reminders${isReminderModalOpen ? ' is-active' : ''}`}
          aria-label="Recordatorios"
          onClick={() => setIsReminderModalOpen(true)}
          onMouseEnter={() => showAndMove(1)}
          onFocus={() => showAndMove(1)}
        >
          <Bell />
          {hasPendingReminder && <span className="quick-actions__pending-dot" aria-hidden="true" />}
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
        onClose={() => setIsReminderModalOpen(false)}
        token={token}
        currentUser={user}
        currentUserName={currentUserName}
        currentUserIds={currentUserIdValues}
        reminders={personalReminders}
        onCreateReminder={handleCreateReminder}
        onMarkReminderSeen={handleMarkReminderSeen}
        darkMode={darkMode}
      />
    </>
  )
}

export default QuickActions
