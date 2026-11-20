const app = require('../server');

module.exports = (req, res) => {
  try {
    const parsed = new URL(req.url || '/', 'http://localhost');
    const forwardedPath = parsed.searchParams.get('__vercel_path');
    if (forwardedPath !== null) {
      parsed.searchParams.delete('__vercel_path');
      const cleanPath = forwardedPath.replace(/^\/+/, '');
      const qs = parsed.searchParams.toString();
      req.url = (cleanPath ? `/api/${cleanPath}` : '/api') + (qs ? `?${qs}` : '');
    }
  } catch {
    // Keep original req.url if parsing fails
  }
  return app(req, res);
};
