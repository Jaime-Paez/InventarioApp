// Ícono de "Pedido por Uber" (traslados marcados para enviarse por Uber):
// insignia negra con la palabra Uber en blanco. Reemplaza el "!" rojo que se
// usaba para los traslados urgentes.
function UberIcon({ size = 18, className = '', style }) {
  const width = Math.round(size * 1.9)
  return (
    <svg
      className={className}
      style={style}
      width={width}
      height={size}
      viewBox="0 0 38 20"
      role="img"
      aria-label="Pedido por Uber"
    >
      <rect x="0" y="0" width="38" height="20" rx="5" fill="#000" />
      <text
        x="19"
        y="14.2"
        textAnchor="middle"
        fill="#fff"
        fontFamily="Helvetica, Arial, sans-serif"
        fontSize="11.5"
        fontWeight="700"
        letterSpacing="-0.2"
      >
        Uber
      </text>
    </svg>
  )
}

export default UberIcon
