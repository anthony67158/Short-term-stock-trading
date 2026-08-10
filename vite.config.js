import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // Rolldown 手动分包：稳定依赖单独缓存，业务改动不使大包失效。
    // ECharts 与 zrender 保持同组；React 与 scheduler 保持同组。
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 20,
            },
            {
              name: 'echarts-vendor',
              test: /node_modules[\\/](echarts|echarts-for-react|zrender)[\\/]/,
              priority: 20,
            },
          ],
        },
      },
    },
    chunkSizeWarningLimit: 1200,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000'
    }
  }
})
