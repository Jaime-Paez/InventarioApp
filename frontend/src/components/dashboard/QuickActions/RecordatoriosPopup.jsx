import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Plus, X } from 'lucide-react'
import useModalAnimation from '../common/useModalAnimation'
import { API_URL, authFetch } from '../../../utils/api'
import {
  buildReminderStatusForUser,
  extractUserId,
  formatCurrentUserName,
  formatReminderDateTime,
  normalizeId,
} from '../common/reminders/remindersStorage'
import './RecordatoriosPopup.css'

const getNowDateParts = () => {
  const now = new Date()
  return {
    date: now.toISOString().slice(0, 10),
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
  }
}

const formatReminderContext = (reminder) => {
  const label = String(reminder?.context?.label || '').trim()
  if (label) return label

  const type = String(reminder?.context?.type || '').trim()
  if (!type) return 'General'

  return type.charAt(0).toUpperCase() + type.slice(1)
}

function RecordatoriosPopup({
  open,
  onClose,
  token,
  currentUser,
  currentUserName,
  currentUserIds,
  reminders,
  onCreateReminder,
  onMarkReminderSeen,
  darkMode,
  onError,
}) {
  const { shouldRender, isClosing } = useModalAnimation(open)
  const [users, setUsers] = useState([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [usersError, setUsersError] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [description, setDescription] = useState('')
  const [selectedRecipientIds, setSelectedRecipientIds] = useState([])
  const [submitError, setSubmitError] = useState('')
  const [activeView, setActiveView] = useState('list')
  const previousViewRef = useRef('list')

  const notifyError = useCallback(
    (message) => {
      if (!message) return
      onError?.(message)
    },
    [onError]
  )

  const currentUserIdSet = useMemo(
    () => new Set((Array.isArray(currentUserIds) ? currentUserIds : []).map(normalizeId).filter(Boolean)),
    [currentUserIds]
  )

  const currentPrimaryUserId = useMemo(() => {
    const values = Array.from(currentUserIdSet)
    return values[0] || ''
  }, [currentUserIdSet])

  const creatorRecipientId = currentPrimaryUserId || extractUserId(currentUser)
  const creatorRecipientName = currentUserName || formatCurrentUserName(currentUser)

  const selectableUsers = useMemo(
    () => users.filter((userItem) => userItem.id !== creatorRecipientId),
    [users, creatorRecipientId]
  )

  useEffect(() => {
    if (!open) return
    const defaults = getNowDateParts()
    setDate(defaults.date)
    setTime(defaults.time)
    setDescription('')
    setSelectedRecipientIds([])
    setSubmitError('')
    setActiveView('list')
    previousViewRef.current = 'list'
  }, [open, currentPrimaryUserId])

  useEffect(() => {
    if (!usersError) return
    notifyError(usersError)
  }, [notifyError, usersError])

  useEffect(() => {
    if (!submitError) return
    notifyError(submitError)
  }, [notifyError, submitError])

  useEffect(() => {
    if (!open) return undefined

    let cancelled = false

    const ensureCurrentUserInList = (list) => {
      const currentId = currentPrimaryUserId || extractUserId(currentUser)
      if (!currentId) return list
      if (list.some((userItem) => userItem.id === currentId)) return list

      return [
        {
          id: currentId,
          name: currentUserName || formatCurrentUserName(currentUser),
          email: currentUser?.correo || currentUser?.email || '',
        },
        ...list,
      ]
    }

    const fetchUsers = async () => {
      if (!token) {
        setLoadingUsers(false)
        setUsers(ensureCurrentUserInList([]))
        setUsersError('')
        return
      }

      setLoadingUsers(true)
      setUsersError('')

      try {
        const list = []
        let url = `${API_URL}/usuarios/listado/?page_size=200`

        while (url) {
          const response = await authFetch(url, {}, token)
          if (!response.ok) throw new Error('No se pudo cargar la lista de usuarios.')

          const data = await response.json()
          if (Array.isArray(data)) {
            list.push(...data)
            url = null
          } else {
            const pageResults = Array.isArray(data?.results) ? data.results : []
            list.push(...pageResults)
            url = data?.next || null
          }
        }

        if (cancelled) return

        const dedupedUsers = []
        const seenIds = new Set()
        list.forEach((item) => {
          const id = extractUserId(item)
          if (!id || seenIds.has(id)) return
          seenIds.add(id)
          dedupedUsers.push({
            id,
            name: formatCurrentUserName(item),
            email: item?.correo || item?.email || '',
          })
        })

        const withCurrentUser = ensureCurrentUserInList(dedupedUsers).sort((a, b) =>
          String(a.name || '').localeCompare(String(b.name || ''), 'es', { sensitivity: 'base' })
        )

        setUsers(withCurrentUser)
      } catch (error) {
        if (cancelled) return
        setUsersError(error?.message || 'No se pudieron cargar los usuarios.')
        setUsers(ensureCurrentUserInList([]))
      } finally {
        if (!cancelled) {
          setLoadingUsers(false)
        }
      }
    }

    fetchUsers()

    return () => {
      cancelled = true
    }
  }, [open, token, currentPrimaryUserId, currentUser, currentUserName])

  useEffect(() => {
    if (!open) return undefined

    const handleEscape = (event) => {
      if (event.key === 'Escape') onClose?.()
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [open, onClose])

  const toggleRecipient = (recipientId) => {
    const normalizedId = normalizeId(recipientId)
    if (!normalizedId) return

    setSelectedRecipientIds((prev) =>
      prev.includes(normalizedId)
        ? prev.filter((id) => id !== normalizedId)
        : [...prev, normalizedId]
    )
  }

  const handleSubmit = (event) => {
    event.preventDefault()
    setSubmitError('')

    if (!date || !time) {
      setSubmitError('Debes completar fecha y hora.')
      return
    }

    const normalizedDescription = String(description || '').trim()
    if (!normalizedDescription) {
      setSubmitError('Debes escribir la descripcion del recordatorio.')
      return
    }

    if (!creatorRecipientId) {
      setSubmitError('No se pudo resolver el usuario creador.')
      return
    }

    const usersById = new Map(users.map((userItem) => [userItem.id, userItem]))
    const selectedRecipients = selectedRecipientIds
      .map((recipientId) => {
        const userItem = usersById.get(recipientId)
        if (!userItem) return null

        return {
          id: userItem.id,
          name: userItem.name,
        }
      })
      .filter(Boolean)

    const recipients = [
      { id: creatorRecipientId, name: creatorRecipientName },
      ...selectedRecipients,
    ].filter((recipient, index, list) => list.findIndex((item) => item.id === recipient.id) === index)

    if (!recipients.length) {
      setSubmitError('No se pudo resolver la lista de destinatarios.')
      return
    }

    const created = onCreateReminder?.({
      date,
      time,
      description: normalizedDescription,
      recipients,
    })

    if (created === false) {
      setSubmitError('No se pudo crear el recordatorio.')
      return
    }

    const defaults = getNowDateParts()
    setDate(defaults.date)
    setTime(defaults.time)
    setDescription('')
    setSelectedRecipientIds([])
    setActiveView(previousViewRef.current || 'list')
  }

  const handleOpenCreateView = () => {
    previousViewRef.current = activeView || 'list'
    setSubmitError('')
    setActiveView('create')
  }

  const handleCloseCreateView = () => {
    setSubmitError('')
    setActiveView(previousViewRef.current || 'list')
  }

  if (!shouldRender || typeof document === 'undefined') return null

  return createPortal(
    <div
      className={`recordatorios-popup__overlay${isClosing ? ' recordatorios-popup__overlay--closing' : ''}${darkMode ? ' is-dark' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Recordatorios"
      onMouseDown={() => onClose?.()}
    >
      <div
        className={`recordatorios-popup__dialog${isClosing ? ' recordatorios-popup__dialog--closing' : ''}${darkMode ? ' is-dark' : ''}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="recordatorios-popup__header">
          <div>
            <h3>Recordatorios</h3>
            <p>Crea y revisa recordatorios personales.</p>
          </div>
          <button type="button" className="recordatorios-popup__close" onClick={() => onClose?.()} aria-label="Cerrar recordatorios">
            <X />
          </button>
        </header>

        <div className="recordatorios-popup__content">
          {activeView === 'create' ? (
            <form className="recordatorios-popup__form recordatorios-popup__form--fullscreen" noValidate onSubmit={handleSubmit}>
              <div className="recordatorios-popup__section-head">
                <h4>Nuevo recordatorio</h4>
                {loadingUsers && (
                  <span className="recordatorios-popup__loading">
                    <Loader2 />
                    Cargando usuarios...
                  </span>
                )}
              </div>

              <div className="recordatorios-popup__grid">
                <label className="recordatorios-popup__field">
                  <span>Fecha</span>
                  <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
                </label>

                <label className="recordatorios-popup__field">
                  <span>Hora</span>
                  <input type="time" value={time} onChange={(event) => setTime(event.target.value)} required />
                </label>

                <label className="recordatorios-popup__field recordatorios-popup__field--full">
                  <span>Usuario creador</span>
                  <input type="text" value={creatorRecipientName} readOnly />
                </label>

                <label className="recordatorios-popup__field recordatorios-popup__field--full">
                  <span>Descripcion</span>
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Escribe de que trata este recordatorio"
                    required
                  />
                </label>
              </div>

              <section className="recordatorios-popup__recipients">
                <div className="recordatorios-popup__section-head">
                  <h4>Dirigido a</h4>
                </div>
                <p className="recordatorios-popup__helper">El creador siempre esta incluido.</p>

                <div className="recordatorios-popup__recipient-list recordatorios-popup__recipient-list--fullscreen">
                  {!selectableUsers.length && !loadingUsers && (
                    <p className="recordatorios-popup__empty-list">No hay mas usuarios disponibles.</p>
                  )}

                  {selectableUsers.map((userItem) => {
                    const checked = selectedRecipientIds.includes(userItem.id)
                    return (
                      <label key={userItem.id} className="recordatorios-popup__recipient">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleRecipient(userItem.id)}
                        />
                        <span className="recordatorios-popup__recipient-name">{userItem.name}</span>
                        {userItem.email && (
                          <small className="recordatorios-popup__recipient-meta">{userItem.email}</small>
                        )}
                      </label>
                    )
                  })}
                </div>
              </section>

              <div className="recordatorios-popup__actions">
                <button
                  type="button"
                  className="recordatorios-popup__button recordatorios-popup__button--ghost"
                  onClick={handleCloseCreateView}
                >
                  Cancelar
                </button>
                <button type="submit" className="recordatorios-popup__button recordatorios-popup__button--primary">
                  Guardar recordatorio
                </button>
              </div>
            </form>
          ) : (
            <section className="recordatorios-popup__history recordatorios-popup__history--fullscreen">
              <div className="recordatorios-popup__section-head">
                <h4>Recordatorios personales</h4>
                <button
                  type="button"
                  className="recordatorios-popup__button recordatorios-popup__button--primary recordatorios-popup__add-trigger"
                  onClick={handleOpenCreateView}
                >
                  <Plus />
                  Anadir recordatorio
                </button>
              </div>

              {!Array.isArray(reminders) || !reminders.length ? (
                <p className="recordatorios-popup__empty-list">No hay recordatorios personales.</p>
              ) : (
                <div className="recordatorios-popup__table-wrap">
                  <table className="recordatorios-popup__table">
                    <thead>
                      <tr>
                        <th>Fecha y hora</th>
                        <th>Descripcion</th>
                        <th>Creador</th>
                        <th>Dirigido a</th>
                        <th>Modulo</th>
                        <th>Estado</th>
                        <th>Accion</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reminders.map((reminder) => {
                        const status = buildReminderStatusForUser(reminder, currentUserIdSet)
                        const recipients = Array.isArray(reminder?.recipients) ? reminder.recipients : []
                        const recipientNames = recipients
                          .map((recipient) => String(recipient?.name || '').trim())
                          .filter(Boolean)
                          .join(', ')

                        return (
                          <tr key={reminder.id}>
                            <td>{formatReminderDateTime(reminder)}</td>
                            <td>{reminder?.description || '-'}</td>
                            <td>{reminder?.creator?.name || 'Usuario'}</td>
                            <td>{recipientNames || 'Sin destinatarios'}</td>
                            <td>{formatReminderContext(reminder)}</td>
                            <td>
                              <span className={`recordatorios-popup__status recordatorios-popup__status--${status.className}`}>
                                {status.label}
                              </span>
                            </td>
                            <td>
                              {status.canMarkSeen ? (
                                <button
                                  type="button"
                                  className="recordatorios-popup__mark-seen"
                                  onClick={() => onMarkReminderSeen?.(reminder.id)}
                                >
                                  Marcar como visto
                                </button>
                              ) : (
                                <span className="recordatorios-popup__action-placeholder">No aplica</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

export default RecordatoriosPopup

