function Workspace({ user, logo }) {
  return (
    <main className="workspace">
      <section className="workspace__hero">
        <div className="workspace__logo">
          <img src={logo} alt="Logotipo Kava" />
        </div>
        <h2>¡Qué gusto tenerte de vuelta, {user?.nombre || 'usuario'}!</h2>
      </section>
    </main>
  )
}

export default Workspace
