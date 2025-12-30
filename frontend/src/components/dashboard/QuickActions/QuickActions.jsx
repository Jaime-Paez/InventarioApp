import React, { useEffect, useRef, useState } from 'react'
import { Bell, Moon, Search, SunMedium } from 'lucide-react'
import './QuickActions.css'

function QuickActions({ darkMode, onToggleTheme }) {
  const wrapRef = useRef(null)
  const btnRefs = useRef([])
  const moveTimerRef = useRef(null)

  const [blob, setBlob] = useState({ x: 0, y: 0, w: 0, h: 0, visible: false })
  const [isMoving, setIsMoving] = useState(false)

  const setBtnRef = (i) => (el) => {
    btnRefs.current[i] = el
  }

  const measure = (i) => {
    const wrap = wrapRef.current
    const btn = btnRefs.current[i]
    if (!wrap || !btn) return null

    const wr = wrap.getBoundingClientRect()
    const br = btn.getBoundingClientRect()

    return {
      x: br.left - wr.left,
      y: br.top - wr.top,
      w: br.width,
      h: br.height,
    }
  }

  const startMoveFx = () => {
    if (moveTimerRef.current) clearTimeout(moveTimerRef.current)
    setIsMoving(true)
    moveTimerRef.current = setTimeout(() => setIsMoving(false), 420)
  }

  const showAndMove = (i) => {
    const m = measure(i)
    if (!m) return

    setBlob((prev) => ({
      ...prev,
      ...m,
      visible: true,
    }))

    startMoveFx()
  }

  const hideBlob = () => {
    setBlob((prev) => ({ ...prev, visible: false }))
    setIsMoving(false)
  }

  // Re-alinear si hay resize mientras está visible
  useEffect(() => {
    const onResize = () => {
      // si está visible, intenta mantener posición recalculando con el botón más cercano
      // (simple: lo escondemos para evitar desalineación fea)
      hideBlob()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    return () => {
      if (moveTimerRef.current) clearTimeout(moveTimerRef.current)
    }
  }, [])

  return (
    <div
      ref={wrapRef}
      className={`quick-actions ${darkMode ? 'dark' : 'light'}`}
      onMouseLeave={hideBlob}
    >
      {/* Liquid lens */}
      <span
        className={[
          'quick-actions__blob',
          blob.visible ? 'is-visible' : '',
          isMoving ? 'is-moving' : '',
        ].join(' ')}
        style={{
          transform: `translate3d(${blob.x}px, ${blob.y}px, 0)`,
          width: `${blob.w}px`,
          height: `${blob.h}px`,
        }}
        aria-hidden="true"
      />

      <button
        ref={setBtnRef(0)}
        type="button"
        className="quick-actions__button"
        aria-label="Buscar"
        onMouseEnter={() => showAndMove(0)}
        onFocus={() => showAndMove(0)}
      >
        <Search />
      </button>

      <button
        ref={setBtnRef(1)}
        type="button"
        className="quick-actions__button"
        aria-label="Notificaciones"
        onMouseEnter={() => showAndMove(1)}
        onFocus={() => showAndMove(1)}
      >
        <Bell />
      </button>

      <button
        ref={setBtnRef(2)}
        type="button"
        className="quick-actions__button"
        aria-label={darkMode ? 'Activar modo claro' : 'Activar modo oscuro'}
        onClick={onToggleTheme}
        onMouseEnter={() => showAndMove(2)}
        onFocus={() => showAndMove(2)}
      >
        {darkMode ? <SunMedium /> : <Moon />}
      </button>
    </div>
  )
}

export default QuickActions
