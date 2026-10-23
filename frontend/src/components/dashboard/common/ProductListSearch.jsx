import '../admin/UsersTable/UsersTable.css'
import './ProductListSearch.css'

function ProductListSearch({ value, onChange, shown, total }) {
  return (
    <div className="product-list-search">
      <div className="search-input-container">
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="search-input"
          placeholder="Buscar producto"
          title="Busca por código, descripción o referencia"
          aria-label="Buscar producto en este movimiento"
        />
        <i className="pi pi-search search-input-icon" />
      </div>
      {String(value || '').trim() && (
        <span className="product-list-search__count">
          {`${shown} de ${total}`}
          <button type="button" className="product-list-search__clear" onClick={() => onChange('')}>Limpiar</button>
        </span>
      )}
    </div>
  )
}

export const ProductSearchEmptyRow = ({ query }) => (
  <div className="create-user__locations-row create-user__locations-row--empty">
    <span>{`Ningún producto coincide con "${String(query || '').trim()}".`}</span>
  </div>
)

export default ProductListSearch
