import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // VITE_API_URL can be set in Railway env vars to point to the same service
    // e.g. VITE_API_URL=https://your-app.railway.app
    // Falls back to localhost for local dev
    __VITE_API_URL__: JSON.stringify(process.env.VITE_API_URL || ''),
  },
})
