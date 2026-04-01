const rateLimits = new Map();

function rateLimit(options = {}) {
  const windowMs = options.windowMs || 60000;
  const max = options.max || 30;
  const message = options.message || 'Demasiadas solicitudes. Intenta en un momento.';

  // Clean old entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimits) {
      if (now - entry.start > windowMs * 2) rateLimits.delete(key);
    }
  }, 300000);

  return (req, res, next) => {
    const key = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = rateLimits.get(key);

    if (!entry || now - entry.start > windowMs) {
      entry = { count: 0, start: now };
      rateLimits.set(key, entry);
    }

    entry.count++;

    if (entry.count > max) {
      return res.status(429).json({ error: message });
    }

    next();
  };
}

module.exports = { rateLimit };
