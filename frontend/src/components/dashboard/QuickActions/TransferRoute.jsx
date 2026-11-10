import './TransferRoute.css'

// Caminito animado de un traslado dentro de la tarjeta del recordatorio:
// sucursal que envia → sucursal que recibe, con una animacion por estado.
// Los estados en curso (por decidir, aceptada, enviado) se mueven en bucle;
// los finales (cumplido, novedades, rechazada, cancelado) se animan una sola
// vez al aparecer y luego quedan quietos.

const MailIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" fill="var(--tr-surface)" />
    <path d="m3 7 9 6 9-6" />
  </svg>
)

const BoxIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 8 12 3 3 8v8l9 5 9-5Z" fill="var(--tr-surface)" />
    <path d="m3 8 9 5 9-5M12 13v8" />
  </svg>
)

const TruckIcon = () => (
  <svg width="30" height="22" viewBox="0 0 30 22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="16" height="12" rx="1.5" fill="var(--tr-surface)" />
    <path d="M18 7h5l4 4v4h-9Z" fill="var(--tr-surface)" />
    <circle cx="8" cy="17" r="2.5" fill="var(--tr-surface)" />
    <circle cx="22" cy="17" r="2.5" fill="var(--tr-surface)" />
  </svg>
)

const Dots = () => (
  <span className="transfer-route__dots" aria-hidden="true"><i /><i /><i /></span>
)

const STAGES = {
  pendiente: { tone: 'pend', Icon: MailIcon },
  aceptada: { tone: 'acc', Icon: BoxIcon },
  enviado: { tone: 'sent', Icon: TruckIcon },
  recibido: { tone: 'ok', Icon: TruckIcon },
  novedades: { tone: 'warn', Icon: TruckIcon },
  rechazada: { tone: 'bad', Icon: BoxIcon },
  cancelado: { tone: 'off', Icon: BoxIcon },
}

const buildNote = (stage, origen, destino) => {
  switch (stage) {
    case 'pendiente':
      return <>Esperando que {origen} responda <Dots /></>
    case 'aceptada':
      return <>Preparando el envío <Dots /></>
    case 'enviado':
      return <>En camino a {destino}</>
    case 'recibido':
      return <>Recibido en {destino}</>
    case 'novedades':
      return <>Llegó con novedades</>
    case 'rechazada':
      return <>No se enviará</>
    case 'cancelado':
      return <>Traslado cancelado</>
    default:
      return null
  }
}

export default function TransferRoute({ stage, origen, destino }) {
  const config = STAGES[stage]
  if (!config) return null
  const origenLabel = String(origen || '').trim() || 'Origen'
  const destinoLabel = String(destino || '').trim() || 'Destino'
  const { tone, Icon } = config

  return (
    <div className={`transfer-route transfer-route--${tone}`}>
      <div className="transfer-route__path">
        <div className="transfer-route__node transfer-route__node--origen">
          <span className="transfer-route__label" data-title={origenLabel}>
            <em>Sale de</em>
            {origenLabel}
          </span>
        </div>

        <div className="transfer-route__track" aria-hidden="true">
          {tone === 'bad' ? (
            <>
              <span className="transfer-route__rail transfer-route__rail--left" />
              <span className="transfer-route__rail transfer-route__rail--right" />
              <span className="transfer-route__badge">✕</span>
            </>
          ) : (
            <span className="transfer-route__rail" />
          )}
          <span className="transfer-route__marching" />
          <span className="transfer-route__fill" />
          {tone === 'off' && <span className="transfer-route__strike" />}
          {(tone === 'ok' || tone === 'warn') && (
            <span className="transfer-route__stamp">{tone === 'ok' ? '✓' : '!'}</span>
          )}
          <span className="transfer-route__mover"><Icon /></span>
        </div>

        <div className="transfer-route__node transfer-route__node--destino">
          <span className="transfer-route__label" data-title={destinoLabel}>
            <em>Llega a</em>
            {destinoLabel}
          </span>
        </div>
      </div>
      <div className="transfer-route__note">{buildNote(stage, origenLabel, destinoLabel)}</div>
    </div>
  )
}
