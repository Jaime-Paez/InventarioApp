function Workspace({ activeItem, user, logo, darkMode, search }) {
  return (
    <main className="workspace">
      <section className="workspace__hero">
        <div className="workspace__logo">
          <img src={logo} alt="Logotipo Kava" />
        </div>
        <h2>¡Qué gusto tenerte de vuelta, {user?.nombre || 'usuario'}!</h2>
        <p className="workspace__subtitle">
          Para comenzar, selecciona una opción del menú o busca algo rápido.
        </p>
        <div className="workspace__chips">
          <span className="chip">{activeItem}</span>
          {search && <span className="chip muted">Búsqueda: {search}</span>}
          <span className="chip ghost">Tema: {darkMode ? 'Oscuro' : 'Claro'}</span>
        </div>
      </section>

      <section className="workspace__panes">
        <div className="pane">
          <h3>Actividad reciente</h3>
          <p>Aún no hay movimientos. Usa el menú lateral para comenzar.</p>
        </div>
        <div className="pane">
          <h3>Favoritos</h3>
          <ul className="pill-list">
            <li>Inventario</li>
            <li>Productos</li>
            <li>Solicitudes</li>
          </ul>
        </div>
      </section>
    </main>
  )
}

export default Workspace
