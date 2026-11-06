import CatalogoTallerTable from '../taller/CatalogoTallerTable'

const CONFIG = {
  endpoint: '/tipos/tipos-division/',
  listQuery: '?page_size=500&ordering=nombre',
  sinActivo: true,
  title: 'Tipos',
  singular: 'tipo de ubicación',
  plural: 'los tipos de ubicación',
  empty: 'Todavía no hay tipos. Crea el primero con "Crear" (Estantería, Cajonera, Puerta...).',
  deleteMessage: 'Solo se puede eliminar si ninguna división de las bodegas lo usa.',
  fields: [
    { key: 'nombre', label: 'Nombre', required: true, placeholder: 'Estantería, Cajonera, Puerta...', full: true },
    { key: 'color', label: 'Color en el plano', type: 'color' },
    {
      key: 'es_referencia',
      label: 'Solo visual (no guarda productos)',
      type: 'boolean',
      help: 'Para puertas, pasillos, columnas...: se ven en el plano pero no crean división ni subdivisiones.',
    },
    { key: 'descripcion', label: 'Descripción', full: true },
  ],
  columns: [
    {
      field: 'nombre',
      header: 'Tipo',
      body: (row) => (
        <span className="taller-color-swatch">
          <i style={{ backgroundColor: row.color || '#4f8df8' }} />
          {row.nombre}
        </span>
      ),
      style: { minWidth: 200 },
    },
    { field: 'es_referencia', header: 'Uso', body: (row) => (row.es_referencia ? 'Solo visual' : 'Guarda productos'), style: { width: 160 } },
    { field: 'descripcion', header: 'Descripción', body: (row) => row.descripcion || '-', style: { minWidth: 200 } },
    { field: 'divisiones_count', header: 'Divisiones que lo usan', style: { width: 180 } },
  ],
}

function TiposUbicacionTable(props) {
  return <CatalogoTallerTable {...props} config={CONFIG} />
}

export default TiposUbicacionTable
