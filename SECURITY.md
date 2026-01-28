# Seguridad del Backend - Free Tarot Fun

Este documento describe las medidas de seguridad implementadas en el backend de la aplicación.

## Medidas Implementadas

### 1. Security Headers (Helmet.js)

Helmet.js configura automáticamente headers HTTP seguros:

- **Content-Security-Policy**: Previene ataques XSS
- **Strict-Transport-Security (HSTS)**: Fuerza HTTPS
- **X-Content-Type-Options**: Previene MIME type sniffing
- **X-Frame-Options**: Previene clickjacking
- **X-XSS-Protection**: Protección adicional contra XSS

### 2. CORS Restrictivo

CORS configurado con whitelist de orígenes permitidos:

- `https://freetarot.fun`
- `https://www.freetarot.fun`
- `http://localhost:5173` (desarrollo)

**Configuración:**
```javascript
origin: function (origin, callback) {
  if (allowedOrigins.indexOf(origin) === -1) {
    return callback(new Error('CORS not allowed'), false);
  }
  return callback(null, true);
}
```

### 3. Rate Limiting

Diferentes límites según el tipo de endpoint:

#### General API (100 req/15min)
```javascript
app.use('/api/', generalLimiter);
```
Protege contra ataques de denegación de servicio (DoS).

#### Chat Endpoint (30 req/15min)
```javascript
app.post("/api/chat/message", chatLimiter, ...);
```
Protege la funcionalidad core de lecturas de tarot.

#### Payment Endpoints (10 req/hour)
```javascript
app.post("/api/payments/create-order", paymentLimiter, ...);
app.post("/api/payments/capture-order", paymentLimiter, ...);
```
Protege contra fraude y abuso en pagos.

### 4. Input Validation

**Nota:** NoSQL injection protection (express-mongo-sanitize) fue removido porque usamos **PostgreSQL (Supabase)**, no MongoDB. PostgreSQL tiene protección nativa contra SQL injection cuando se usan consultas parametrizadas, que es lo que usa Supabase.

Para mayor seguridad, se recomienda implementar `express-validator` en endpoints críticos (ver sección de Próximos Pasos).

### 5. Payload Size Limit

Limita el tamaño de las peticiones JSON:

```javascript
app.use(express.json({ limit: '10mb' }));
```

Previene ataques de denegación de servicio mediante payloads grandes.

### 6. Trust Proxy

Configurado para funcionar correctamente detrás de reverse proxies:

```javascript
app.set('trust proxy', 1);
```

Esencial para que rate limiting funcione correctamente con Nginx, Cloudflare, etc.

### 7. Request Logging

Logging estructurado de todas las peticiones:

- Timestamp
- Método HTTP
- Path
- IP del cliente
- Status code
- Duración de la petición

### 8. Error Handling

Manejador global de errores que:

- Registra el error completo en logs
- No expone detalles internos en producción
- Retorna mensajes genéricos al cliente

## Health Check Endpoint

```
GET /health
```

Endpoint sin rate limiting para monitoreo:

```json
{
  "status": "ok",
  "timestamp": "2026-01-27T...",
  "uptime": 12345,
  "environment": "production"
}
```

## Variables de Entorno Requeridas

Ver `.env.example` para la lista completa. Las críticas para seguridad son:

```bash
NODE_ENV=production           # Activa modo producción
FRONTEND_URL=https://...      # Para CORS
```

## Mejores Prácticas

### En Producción

1. **Siempre usar HTTPS**: Los headers HSTS fuerzan HTTPS
2. **Variables de entorno seguras**: Nunca commitear .env
3. **Monitoreo activo**: Usar el endpoint /health
4. **Logs centralizados**: Implementar Winston/Pino
5. **Error tracking**: Integrar Sentry o similar

### Configuración de Reverse Proxy

Si usas Nginx o similar, asegúrate de pasar la IP real del cliente:

```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

## Auditoría de Seguridad

### Comando de Auditoría

```bash
npm audit
```

### Actualizar Dependencias

```bash
npm audit fix
```

### Dependencias de Seguridad

- `helmet@^8.1.0` - Security headers
- `express-rate-limit@^8.2.1` - Rate limiting
- `express-validator@^7.3.1` - Input validation (recomendado para implementar)

## Próximos Pasos Recomendados

### Alta Prioridad
- [ ] Implementar Winston para logging estructurado
- [ ] Integrar Sentry para error tracking
- [ ] Implementar tests de seguridad automatizados
- [ ] Configurar monitoreo de métricas (CPU, memoria)

### Media Prioridad
- [ ] Implementar express-validator en todos los endpoints
- [ ] Agregar CSRF protection para endpoints stateful
- [ ] Implementar refresh tokens para auth
- [ ] Configurar backups automáticos

### Baja Prioridad
- [ ] Implementar 2FA para admin
- [ ] Agregar IP whitelisting para admin endpoints
- [ ] Implementar audit logs para operaciones críticas

## Contacto de Seguridad

Si encuentras una vulnerabilidad de seguridad, por favor repórtala de forma responsable.

## Referencias

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Express Security Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)
- [Node.js Security Checklist](https://blog.risingstack.com/node-js-security-checklist/)
