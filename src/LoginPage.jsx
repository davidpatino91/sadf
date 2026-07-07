import { useState } from 'react'
import { useAuth } from './AuthContext'

const inputStyle = {
  width: '100%',
  padding: '11px 13px',
  borderRadius: 8,
  border: '1px solid #DFE3E8',
  fontSize: 14,
  fontFamily: 'Inter, system-ui, sans-serif',
  color: '#16212E',
  background: '#FFFFFF',
  outline: 'none',
  boxSizing: 'border-box',
}

const TOKENS = `
  *{box-sizing:border-box;margin:0}
  body{background:#F4F6F8;min-height:100vh;display:flex;align-items:center;justify-content:center}
`

export default function LoginPage() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [enviando, setEnviando] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    setEnviando(true)
    try {
      await signIn(email, password)
    } catch (err) {
      setError(err.message === 'Invalid login credentials'
        ? 'Correo o contraseña incorrectos.'
        : err.message)
    } finally {
      setEnviando(false)
    }
  }

  return (
    <>
      <style>{TOKENS}</style>
      <div
        style={{
          background: '#FFFFFF',
          border: '1px solid #DFE3E8',
          borderRadius: 14,
          padding: '36px 32px',
          width: 380,
          maxWidth: '90vw',
          boxShadow: '0 12px 32px rgba(14,26,43,0.1)',
        }}
      >
        <div style={{ marginBottom: 24, textAlign: 'center' }}>
          <div
            style={{
              fontFamily: "'Sora', system-ui, sans-serif",
              fontWeight: 700,
              fontSize: 20,
              letterSpacing: '-0.01em',
            }}
          >
            Deuda<span style={{ color: '#0C7C6B' }}>Fin</span>
          </div>
          <div style={{ fontSize: 13.5, color: '#5B6675', marginTop: 4 }}>
            Administración de créditos financieros
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 14 }}>
            <label
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: '#5B6675',
                marginBottom: 5,
                display: 'block',
              }}
            >
              Correo electrónico
            </label>
            <input
              style={inputStyle}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@correo.com"
              required
              autoFocus
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: '#5B6675',
                marginBottom: 5,
                display: 'block',
              }}
            >
              Contraseña
            </label>
            <input
              style={inputStyle}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
            />
          </div>

          {error && (
            <div
              style={{
                fontSize: 12.5,
                color: '#B23A34',
                background: '#FBEAEA',
                padding: '9px 12px',
                borderRadius: 7,
                marginBottom: 14,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={enviando}
            style={{
              width: '100%',
              padding: '11px 0',
              borderRadius: 8,
              border: 'none',
              background: enviando ? '#95C9BC' : '#0C7C6B',
              color: '#FFFFFF',
              fontSize: 14,
              fontWeight: 600,
              cursor: enviando ? 'not-allowed' : 'pointer',
              fontFamily: 'Inter, system-ui, sans-serif',
            }}
          >
            {enviando ? 'Iniciando sesión…' : 'Iniciar sesión'}
          </button>
        </form>

        <div
          style={{
            marginTop: 18,
            fontSize: 12,
            color: '#8A93A0',
            textAlign: 'center',
          }}
        >
          Los usuarios son creados por el administrador del proyecto en Supabase
          Auth.
        </div>
      </div>
    </>
  )
}
