export const ESTADO_LABEL = {
  agotado: 'Agotado',
  pedir: 'Pedir',
  ok: 'OK',
  exceso: 'Exceso',
  esporadico: 'Esporádico',
  obsoleto: 'Obsoleto',
  sin_demanda: 'Sin venta reciente',
}

const n = (value, digits = 0) => (
  value == null ? '—' : Number(value).toLocaleString('es-EC', { minimumFractionDigits: 0, maximumFractionDigits: digits })
)

// Que es cada causa y por que el inventario cae ahi. `c` = configuracion.
export const causaInfo = (key, c = {}) => ({
  ciclo: {
    title: 'Ciclo',
    body: 'Lo que se va vendiendo entre un pedido y el siguiente. Es el inventario normal y necesario.',
    reason: 'Es la parte del stock que está por encima del de seguridad, hasta el tamaño de un pedido (en clase C, hasta lo que se vende entre dos revisiones).',
  },
  seguridad: {
    title: 'Seguridad',
    body: 'Un colchón por si se vende más de lo normal o el pedido se demora en llegar.',
    reason: 'Son las primeras unidades de cada producto, hasta su stock de seguridad. Es mayor en los productos A, que tienen un nivel de servicio más alto.',
  },
  en_camino: {
    title: 'En camino',
    body: 'Mercadería que ya se pidió pero todavía no llega.',
    reason: 'Se suma lo que viene en traslados enviados y en importaciones abiertas hacia cada sucursal.',
  },
  exceso: {
    title: 'Exceso',
    body: 'Stock que sobra: más de lo que debería haber incluso justo cuando acaba de llegar un pedido.',
    reason: 'Es lo que supera la seguridad más un pedido completo. Es dinero inmovilizado: conviene trasladarlo a otra sucursal o dejar de pedirlo.',
  },
  lento: {
    title: 'Lento',
    body: 'Productos que casi no se venden, pero que todavía no llegan a obsoletos.',
    reason: `No tuvieron ventas en los últimos ${n(c.ventana_dias)} días, o se vendieron en menos de ${n(c.min_dias_venta)} días distintos.`,
  },
  obsoleto: {
    title: 'Obsoleto',
    body: 'Productos con stock que no se venden hace mucho tiempo.',
    reason: `Tienen stock y no se venden hace ${n(c.dias_obsoleto)} días o más (o nunca se vendieron).`,
  },
}[key])

// Que significa el estado y por que ESTE producto quedo asi.
export const estadoInfo = (estado, row = null, c = {}) => {
  const pedirEn = row ? (row.punto_pedido ?? row.nivel_base) : null
  const base = {
    agotado: {
      body: 'El producto se vende pero no hay stock en la sucursal.',
      reason: row && `Vende ${n(row.venta_dia, 2)} por día y el stock es ${n(row.stock)}.${row.sugerido ? ` Se sugiere pedir ${n(row.sugerido)}.` : ''}`,
    },
    pedir: {
      body: 'Llegó al punto de pedido: hay que pedir ahora para no quedarse sin stock mientras llega la mercadería.',
      reason: row && `Stock ${n(row.stock)} + en camino ${n(row.en_camino)} = ${n(row.posicion)}, que no supera el "pedir en" de ${n(pedirEn)}. Se sugiere pedir ${n(row.sugerido)}.`,
    },
    ok: {
      body: 'Hay suficiente stock; por ahora no hace falta pedir.',
      reason: row && `Stock + en camino = ${n(row.posicion)}: está sobre el "pedir en" de ${n(pedirEn)} y bajo el máximo de ${n(row.nivel_maximo)}.`,
    },
    exceso: {
      body: 'Hay más stock del necesario.',
      reason: row && `El stock de ${n(row.stock)} supera el máximo recomendado de ${n(row.nivel_maximo)} (seguridad + un pedido completo).`,
    },
    esporadico: {
      body: 'Se vende muy de vez en cuando. No conviene tenerlo siempre en stock: se pide bajo pedido.',
      reason: row
        ? `Se vendió en ${n(row.dias_con_venta)} días de los últimos ${n(c.ventana_dias)}; el mínimo para reponerlo solo es ${n(c.min_dias_venta)}.`
        : `Se vendió en menos de ${n(c.min_dias_venta)} días distintos en los últimos ${n(c.ventana_dias)}.`,
    },
    obsoleto: {
      body: 'Tiene stock pero no se vende hace mucho tiempo.',
      reason: row
        ? (row.dias_sin_venta == null
          ? 'No tiene ventas registradas.'
          : `La última venta fue hace ${n(row.dias_sin_venta)} días; el límite es ${n(c.dias_obsoleto)}.`)
        : `Tiene stock y no se vende hace ${n(c.dias_obsoleto)} días o más.`,
    },
    sin_demanda: {
      body: 'No tuvo ventas recientes.',
      reason: `Sin ventas en los últimos ${n(c.ventana_dias)} días.`,
    },
    reponer: {
      body: 'Agotados y productos que llegaron al punto de pedido: lo que hay que pedir ya.',
    },
  }[estado]
  return base ? { title: ESTADO_LABEL[estado] || 'Reponer', ...base } : null
}

// Que significa la clase ABC.
export const claseInfo = (clase, c = {}) => {
  const common = 'Se calcula con el valor vendido (unidades × costo) en toda la empresa, ordenando de mayor a menor.'
  return {
    A: {
      title: 'Clase A: los más importantes',
      body: `Los pocos productos que más dinero mueven: juntos suman el primer ${n(c.corte_a)}% del valor vendido.`,
      reason: `${common} Se cuidan más: nivel de servicio ${n(c.nivel_servicio_a, 1)}% y se revisan siempre (punto de pedido).`,
    },
    B: {
      title: 'Clase B: importancia media',
      body: `Los que siguen, hasta completar el ${n(c.corte_b)}% del valor vendido.`,
      reason: `${common} Nivel de servicio ${n(c.nivel_servicio_b, 1)}% y se revisan siempre (punto de pedido).`,
    },
    C: {
      title: 'Clase C: los de menos valor',
      body: 'El resto: muchos productos que juntos mueven poco dinero.',
      reason: `${common} Se revisan cada ${n(c.revision_dias)} días y se completan hasta su nivel base, con nivel de servicio ${n(c.nivel_servicio_c, 1)}%.`,
    },
    N: {
      title: 'Sin clase',
      body: 'No tuvo ventas en el periodo, así que no se clasifica.',
    },
  }[clase] || null
}
