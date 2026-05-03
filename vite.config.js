import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    // In local Vite dev, default to the backend port so REST + WS reach Express
    // instead of the Vite dev server itself.
    // In production/Railway, keep same-origin unless VITE_API_URL is explicitly set.
    __VITE_API_URL__: JSON.stringify(
      process.env.VITE_API_URL || (command === 'serve' ? 'http://127.0.0.1:3001' : '')
    ),
  },
}))
