import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // 手动分包：把体积大且首屏非必需的库拆出主 bundle，
    // 让浏览器并行下载 + 长效缓存(库变动频率远低于业务代码)。
    // echarts(图表)~1MB 单独成块，仅在打开含图表页面时才拉取。
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'echarts-vendor': ['echarts', 'echarts-for-react'],
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
