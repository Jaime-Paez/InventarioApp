function Workspace({ user, logo }) {
  const username = [user?.nombre || user?.first_name, user?.apellido || user?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim() || 'usuario'

  return (
    <main className="workspace">
      <section className="workspace__hero">
        <div className="workspace__logo">
          <img src={logo} alt="Logotipo Kava" />
        </div>
        <div className="workspace__copy">
          <h2>¡Qué gusto tenerte de vuelta, {username}!</h2>
          <p className="workspace__subtitle">
            Para comenzar, selecciona una opción del menú
          </p>
        </div>
      </section>
    </main>
  )
}

export default Workspace
