import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import process from 'node:process'

const isVercel = process.env.VERCEL === '1'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
  build: {
    outDir: isVercel ? 'dist' : '../static',
    emptyOutDir: true,
  },
})
