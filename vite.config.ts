import { defineConfig } from 'vite';
export default defineConfig({ root: 'web',build: { outDir: '../dist/dashboard',emptyOutDir: false },esbuild: { jsx: 'automatic' } });
