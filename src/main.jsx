import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Catch any unhandled React render error and show a recoverable panel instead
// of leaving the page completely gray/white with no feedback.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('[UI] Uncaught render error:', error, info?.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
          height:'100vh', background:'#0a0a14', gap:16, padding:24,
        }}>
          <div style={{ color:'#ff4466', fontSize:18, fontWeight:800, letterSpacing:'-0.5px' }}>
            Erro na Interface
          </div>
          <div style={{ color:'#888', fontSize:11, maxWidth:420, textAlign:'center', lineHeight:1.6 }}>
            {this.state.error?.message || 'Erro desconhecido'}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              background:'#4899ff', color:'#fff', border:'none',
              borderRadius:6, padding:'8px 22px', cursor:'pointer', fontSize:13, fontWeight:600,
            }}>
            Recarregar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
