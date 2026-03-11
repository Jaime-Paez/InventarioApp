import { useCallback, useEffect, useMemo, useState } from 'react'
import { API_URL, authFetch } from '../../../../utils/api'
import './ProductoRatingTab.css'

const TOTAL_STARS = 5

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const toDateLabel = (value) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('es-EC', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const renderStarsText = (value) => {
  const score = Math.max(0, Math.min(TOTAL_STARS, Math.round(toNumber(value, 0))))
  return Array.from({ length: TOTAL_STARS }, (_, index) => (index < score ? '\u2605' : '\u2606')).join(' ')
}

function ProductoRatingTab({
  productoId,
  token,
  onError,
  canComment = false,
  commentLockedByEdit = false,
}) {
  const [ratingSummary, setRatingSummary] = useState(null)
  const [comments, setComments] = useState([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [draftStars, setDraftStars] = useState(0)
  const [draftComment, setDraftComment] = useState('')

  const notifyError = useCallback(
    (message) => {
      if (!message) return
      if (typeof onError === 'function') {
        onError(message)
        return
      }
      console.error(message)
    },
    [onError]
  )

  const fetchTabData = useCallback(async () => {
    if (!productoId || !token) {
      setComments([])
      setRatingSummary(null)
      return
    }

    setLoading(true)
    try {
      const [summaryResponse, commentsResponse] = await Promise.all([
        authFetch(`${API_URL}/productos/listado/${productoId}/calificacion/`, {}, token),
        authFetch(`${API_URL}/productos/listado/${productoId}/comentarios/`, {}, token),
      ])

      const summaryPayload = await summaryResponse.json().catch(() => ({}))
      const commentsPayload = await commentsResponse.json().catch(() => ({}))

      if (!summaryResponse.ok) {
        throw new Error(summaryPayload?.detail || 'No se pudo cargar la calificacion del producto.')
      }
      if (!commentsResponse.ok) {
        throw new Error(commentsPayload?.detail || 'No se pudieron cargar los comentarios del producto.')
      }

      const incomingSummary = commentsPayload?.rating_summary || summaryPayload || null
      const incomingComments = Array.isArray(commentsPayload?.results)
        ? commentsPayload.results
        : Array.isArray(commentsPayload)
          ? commentsPayload
          : []

      setRatingSummary(incomingSummary)
      setComments(incomingComments)
    } catch (error) {
      notifyError(error?.message || 'No se pudo cargar la informacion de calificaciones.')
    } finally {
      setLoading(false)
    }
  }, [notifyError, productoId, token])

  useEffect(() => {
    fetchTabData()
  }, [fetchTabData])

  const handleSubmitComment = async () => {
    if (!canComment || !productoId || !token || submitting) return
    const trimmedComment = String(draftComment || '').trim()
    if (!trimmedComment) return

    setSubmitting(true)
    try {
      const response = await authFetch(
        `${API_URL}/productos/listado/${productoId}/comentarios/`,
        {
          method: 'POST',
          body: JSON.stringify({
            estrellas: draftStars > 0 ? draftStars : null,
            comentario: trimmedComment,
          }),
        },
        token
      )

      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        const errorText = payload?.detail || payload?.estrellas?.[0] || payload?.comentario?.[0]
        throw new Error(errorText || 'No se pudo guardar el comentario.')
      }

      setDraftStars(0)
      setDraftComment('')

      if (payload?.rating_summary) {
        setRatingSummary(payload.rating_summary)
      }
      await fetchTabData()
    } catch (error) {
      notifyError(error?.message || 'No se pudo guardar el comentario del producto.')
    } finally {
      setSubmitting(false)
    }
  }

  const headerRating = useMemo(() => {
    if (!ratingSummary) return 0
    return toNumber(ratingSummary?.rating, 0)
  }, [ratingSummary])

  return (
    <div className="producto-rating-tab">
      <section className="create-user__section producto-rating-tab__summary">
        <div className="create-user__section-header">
          <h4>Calificacion general</h4>
        </div>

        <div className="producto-rating-tab__summary-grid">
          <div className="producto-rating-tab__score">
            <strong>{headerRating.toFixed(1)}</strong>
            <span>/ 5</span>
            <p className="producto-rating-tab__stars" aria-label={`Calificacion ${headerRating.toFixed(1)} de 5`}>
              {renderStarsText(headerRating)}
            </p>
            <small>{toNumber(ratingSummary?.comment_count, 0)} comentario(s)</small>
          </div>
        </div>

        <p className="producto-rating-tab__rule-note">
          Regla activa: la calificacion final usa formula ponderada (75% comentarios y 25% señales automaticas). Las devoluciones no funcionales penalizan el bloque operativo y las ventas lo fortalecen.
        </p>
      </section>

      <section className="create-user__section producto-rating-tab__form">
        <div className="create-user__section-header">
          <h4>Agregar comentario</h4>
        </div>

        {canComment ? (
          <>
            <div className="producto-rating-tab__stars-picker">
              <span className="producto-rating-tab__stars-label">Calificacion</span>
              <div className="producto-rating-tab__stars-picker-buttons" role="radiogroup" aria-label="Calificar producto">
                {Array.from({ length: TOTAL_STARS }, (_, index) => {
                  const score = index + 1
                  const isActive = score <= draftStars
                  return (
                    <button
                      key={score}
                      type="button"
                      className={`producto-rating-tab__star-btn${isActive ? ' is-active' : ''}`}
                      onClick={() => setDraftStars(score)}
                      disabled={submitting || loading}
                      role="radio"
                      aria-checked={draftStars === score}
                      aria-label={`${score} estrella${score === 1 ? '' : 's'}`}
                      title={`${score} estrella${score === 1 ? '' : 's'}`}
                    >
                      {isActive ? '\u2605' : '\u2606'}
                    </button>
                  )
                })}
              </div>
              <span className="producto-rating-tab__selected-score">
                {draftStars > 0 ? `${draftStars}/5` : 'Sin seleccionar'}
              </span>
            </div>

            <label className="create-user__field">
              <span>Comentario</span>
              <textarea
                rows={3}
                value={draftComment}
                onChange={(event) => setDraftComment(event.target.value)}
                placeholder="Escribe una observacion sobre este producto."
                maxLength={1200}
                disabled={submitting || loading}
              />
            </label>

            <div className="producto-rating-tab__actions">
              <button
                type="button"
                className="create-user__action create-user__action--primary"
                onClick={handleSubmitComment}
                disabled={submitting || loading || !String(draftComment || '').trim()}
              >
                {submitting ? 'Guardando...' : 'Publicar comentario'}
              </button>
            </div>
          </>
        ) : (
          <p className="producto-rating-tab__empty">
            {commentLockedByEdit
              ? 'Presiona Editar para agregar un comentario.'
              : 'Solo usuarios con permisos de editar en productos pueden comentar.'}
          </p>
        )}
      </section>

      <section className="create-user__section producto-rating-tab__comments">
        <div className="create-user__section-header">
          <h4>Comentarios recientes</h4>
          <small>{comments.length} comentario(s)</small>
        </div>

        {loading && <p className="producto-rating-tab__empty">Cargando comentarios...</p>}
        {!loading && comments.length === 0 && (
          <p className="producto-rating-tab__empty">Aun no hay comentarios para este producto.</p>
        )}

        {!loading && comments.length > 0 && (
          <div className="producto-rating-tab__comment-list">
            {comments.map((comment) => (
              <article key={comment.id} className="producto-rating-tab__comment-card">
                <div className="producto-rating-tab__comment-top">
                  <strong>{comment?.usuario_nombre || 'Usuario'}</strong>
                  <span>{toDateLabel(comment?.created_at)}</span>
                </div>
                <p className="producto-rating-tab__comment-stars" aria-label={`${comment?.estrellas || 0} estrellas`}>
                  {renderStarsText(comment?.estrellas)}
                </p>
                <p className="producto-rating-tab__comment-text">
                  {String(comment?.comentario || '').trim() || 'Sin comentario.'}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export default ProductoRatingTab
