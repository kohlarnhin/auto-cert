import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import process from 'node:process'

const backendDevUrl = process.env.VITE_BACKEND_DEV_URL || 'http://localhost:8787'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': backendDevUrl,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
