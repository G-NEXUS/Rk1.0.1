import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

function rkGitHubPagesPlugin() {
  const staticFiles = ['styles.css', 'common.js', 'firebase-bundle.js'];

  return {
    name: 'rk-github-pages-static',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/(href|src)="\/(styles\.css|common\.js|firebase-bundle\.js)/g, '$1="./$2');
    },
    closeBundle() {
      const rootDir = process.cwd();
      const distDir = path.resolve(rootDir, 'dist');
      fs.mkdirSync(distDir, { recursive: true });

      for (const file of staticFiles) {
        const src = path.join(rootDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(distDir, file));
        }
      }

      // Copy any user-added static images under assets/ while skipping internal dev screenshots
      const rootAssets = path.join(rootDir, 'assets');
      if (fs.existsSync(rootAssets)) {
        fs.cpSync(rootAssets, path.join(distDir, 'assets'), { recursive: true });
      }

      // Disable Jekyll processing on GitHub Pages
      fs.writeFileSync(path.join(distDir, '.nojekyll'), '', 'utf8');
    },
  };
}

export default defineConfig({
  base: './',
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      input: path.resolve(process.cwd(), 'index.html'),
    },
  },
  plugins: [rkGitHubPagesPlugin()],
});
