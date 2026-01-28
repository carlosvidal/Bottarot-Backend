/**
 * Security middleware configuration for production
 * Implements rate limiting, CORS restrictions, and security headers
 */

import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import mongoSanitize from 'express-mongo-sanitize';

/**
 * Configure Helmet for security headers
 */
export const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
});

/**
 * Configure CORS with whitelist of allowed origins
 */
export function corsConfig() {
  const allowedOrigins = [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    'https://freetarot.fun',
    'https://www.freetarot.fun'
  ];

  return {
    origin: function (origin, callback) {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) === -1) {
        const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
    credentials: true,
    optionsSuccessStatus: 200
  };
}

/**
 * Rate limiter for general API endpoints
 * 100 requests per 15 minutes per IP
 */
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Demasiadas solicitudes desde esta IP, por favor intenta de nuevo más tarde.',
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limiting for certain IPs (optional)
  skip: (req) => {
    // Skip for localhost in development
    if (process.env.NODE_ENV === 'development' && req.ip === '::1') {
      return true;
    }
    return false;
  }
});

/**
 * Stricter rate limiter for authentication endpoints
 * 5 requests per 15 minutes per IP
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: 'Demasiados intentos de autenticación, por favor intenta de nuevo más tarde.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true // Don't count successful requests
});

/**
 * Rate limiter for AI chat endpoints
 * 30 requests per 15 minutes per IP (more generous for core functionality)
 */
export const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  message: 'Has alcanzado el límite de lecturas por periodo. Por favor, espera unos minutos.',
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Rate limiter for payment endpoints
 * 10 requests per hour per IP
 */
export const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: 'Demasiadas solicitudes de pago, por favor intenta de nuevo más tarde.',
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * MongoDB injection sanitizer
 * Removes $ and . characters from user input
 */
export const sanitizeInput = mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }) => {
    console.warn(`Sanitized potentially malicious input on key: ${key}`);
  }
});

/**
 * Request logging middleware
 */
export function requestLogger(req, res, next) {
  const start = Date.now();

  // Log request
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - IP: ${req.ip}`);

  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
  });

  next();
}

/**
 * Error handler middleware
 */
export function errorHandler(err, req, res, next) {
  console.error('Error:', err);

  // Don't leak error details in production
  const isDevelopment = process.env.NODE_ENV === 'development';

  const statusCode = err.statusCode || 500;
  const message = isDevelopment ? err.message : 'Ha ocurrido un error en el servidor';

  res.status(statusCode).json({
    error: message,
    ...(isDevelopment && { stack: err.stack })
  });
}

/**
 * 404 handler
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: 'Endpoint no encontrado'
  });
}
