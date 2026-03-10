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

function ProductoRatingTab({ productoId, token, onError }) {
  const [ratingSummary, setRatingSummary] = useState(null)
  const [comments, setComments] = useState([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [draftStars, setDraftStars] = useState(5)
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
    if (!productoId || !token || submitting) return
    const stars = Math.max(1, Math.min(TOTAL_STARS, Math.round(toNumber(draftStars, 5))))

    setSubmitting(true)
    try {
      const response = await authFetch(
        `${API_URL}/productos/listado/${productoId}/comentarios/`,
        {
          method: 'POST',
          body: JSON.stringify({
            estrellas: stars,
            comentario: String(draftComment || '').trim(),
          }),
        },
        token
      )

      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        const errorText = payload?.detail || payload?.estrellas?.[0] || payload?.comentario?.[0]
        throw new Error(errorText || 'No se pudo guardar el comentario.')
      }

      setDraftComment('')
      setDraftStars(5)

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
          </div>

          <div className="producto-rating-tab__metrics">
            <div className="producto-rating-tab__metric-item">
              <span>Promedio comentarios</span>
              <strong>
                {ratingSummary?.comment_average != null
                  ? Number(ratingSummary.comment_average).toFixed(1)
                  : '-'}
              </strong>
            </div>
            <div className="producto-rating-tab__metric-item">
              <span>Comentarios</span>
              <strong>{toNumber(ratingSummary?.comment_count, 0)}</strong>
            </div>
            <div className="producto-rating-tab__metric-item">
              <span>Negativos</span>
              <strong>{toNumber(ratingSummary?.negative_comments, 0)}</strong>
            </div>
            <div className="producto-rating-tab__metric-item">
              <span>Ventas registradas</span>
              <strong>{toNumber(ratingSummary?.sales_count, 0)}</strong>
            </div>
            <div className="producto-rating-tab__metric-item">
              <span>Devoluciones</span>
              <strong>{toNumber(ratingSummary?.returns_count, 0)}</strong>
            </div>
            <div className="producto-rating-tab__metric-item">
              <span>Meses sin ventas</span>
              <strong>{toNumber(ratingSummary?.months_without_sales, 0)}</strong>
            </div>
            <div className="producto-rating-tab__metric-item">
              <span>Ultima venta</span>
              <strong>{ratingSummary?.last_sale_date || '-'}</strong>
            </div>
          </div>
        </div>

        <p className="producto-rating-tab__rule-note">
          Regla activa: cada devolucion resta 1 estrella y cada 2 meses sin ventas se descuenta 0.5 estrellas.
        </p>
      </section>

      <section className="create-user__section producto-rating-tab__form">
        <div className="create-user__section-header">
          <h4>Agregar comentario y calificacion</h4>
        </div>

        <div className="producto-rating-tab__stars-picker" role="group" aria-label="Calificar producto">
          {Array.from({ length: TOTAL_STARS }, (_, index) => {
            const value = index + 1
            const active = value <= draftStars
            return (
              <button
                key={value}
                type="button"
                className={`producto-rating-tab__star-btn${active ? ' is-active' : ''}`}
                onClick={() => setDraftStars(value)}
                disabled={submitting || loading}
                aria-label={`${value} estrella${value === 1 ? '' : 's'}`}
              >
                {active ? '\u2605' : '\u2606'}
              </button>
            )
          })}
          <span className="producto-rating-tab__selected-score">{draftStars}/5</span>
        </div>

        <label className="create-user__field">
          <span>Comentario</span>
          <textarea
            rows={3}
            value={draftComment}
            onChange={(event) => setDraftComment(event.target.value)}
            placeholder="Escribe una observacion sobre este producto (opcional)."
            maxLength={1200}
            disabled={submitting || loading}
          />
        </label>

        <div className="producto-rating-tab__actions">
          <button
            type="button"
            className="create-user__action create-user__action--primary"
            onClick={handleSubmitComment}
            disabled={submitting || loading}
          >
            {submitting ? 'Guardando...' : 'Publicar comentario'}
          </button>
        </div>
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
