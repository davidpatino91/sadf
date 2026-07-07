import { AuthProvider, useAuth } from './AuthContext'
import LoginPage from './LoginPage'
import SistemaDeudaFinanciera from './sistema-deuda-financiera.jsx'

function AppInner() {
  const { user, cargando } = useAuth()

  if (cargando) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#F4F6F8',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            display: 'inline-block',
            borderRadius: '50%',
            border: '2.5px solid #DFE3E8',
            borderTopColor: '#0C7C6B',
            animation: 'sdf-spin 700ms linear infinite',
          }}
        />
        <style>{`@keyframes sdf-spin{to{transform:rotate(360deg);}}`}</style>
      </div>
    )
  }

  if (!user) return <LoginPage />

  return <SistemaDeudaFinanciera user={user} />
}

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  )
}
