/**
 * Public reservation document endpoint. Receives `?payload=<base64url>&sig=<hex>`,
 * verifies HMAC, renders an HTML confirmation page suitable for sharing as
 * a link in WhatsApp. WhatsApp generates a link preview from the OG meta
 * tags so the customer sees a card without having to click through.
 *
 * Why HTML instead of PDF: WhatsApp link previews work for HTML pages,
 * which is enough for the v1 use case (customer sees the price summary,
 * pays anticipo, replies with the receipt). A real PDF would require a
 * heavier renderer (puppeteer / pdf-lib) and a hosted file — out of scope
 * for the initial port. The route name keeps `.pdf` suffix so future
 * binary PDF rendering can swap in without changing the URLs already
 * shared with customers.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { verifyPdfPayload } from '../../agent/reservation-pdf-url.js';

function escape(s: string | number | undefined | null): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(n);
}

export async function reservationPdfRoutes(app: FastifyInstance) {
  app.get('/reservation-confirmation.pdf', async (req, reply) => {
    const q = req.query as { payload?: string; sig?: string };
    const secret = config.PDF_HMAC_SECRET ?? config.WEBHOOK_SHARED_SECRET ?? '';
    if (!secret) {
      return reply.code(500).send({ error: 'PDF endpoint not configured (no HMAC secret)' });
    }
    if (!q.payload || !q.sig) {
      return reply.code(400).send({ error: 'missing payload or sig' });
    }
    const v = verifyPdfPayload(q.payload, q.sig, secret);
    if (!v.ok || !v.payload) {
      return reply.code(403).send({ error: 'invalid signature' });
    }
    const p = v.payload;
    const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confirmación de reserva — ${escape(p.fincaCodigo)}</title>
<meta property="og:title" content="Reserva ${escape(p.fincaCodigo)} — ${escape(p.cliente.nombre || 'Cliente')}">
<meta property="og:description" content="${escape(p.fechaInicio)} a ${escape(p.fechaFin)} · ${escape(p.personas)} personas · Total ${escape(fmtCurrency(p.total))}">
<style>
  body { font-family: system-ui, -apple-system, "Helvetica Neue", sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1f2933; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  h2 { font-size: 1rem; margin: 24px 0 8px; color: #486581; }
  .codigo { color: #b58300; font-weight: 600; }
  .panel { border: 1px solid #cbd2d9; border-radius: 8px; padding: 16px; margin: 12px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 4px 0; vertical-align: top; }
  td.label { color: #627d98; width: 40%; }
  td.value { font-weight: 500; text-align: right; }
  .total td { padding-top: 8px; border-top: 1px solid #cbd2d9; font-size: 1.05rem; }
  .anticipo { background: #fffaf0; border-color: #f0b429; }
  .footer { margin-top: 32px; color: #829ab1; font-size: 0.85rem; }
</style>
</head>
<body>
  <h1>Confirmación de reserva</h1>
  <div class="codigo">${escape(p.fincaCodigo)}</div>

  <div class="panel">
    <table>
      <tr><td class="label">Fechas</td><td class="value">${escape(p.fechaInicio)} → ${escape(p.fechaFin)}</td></tr>
      <tr><td class="label">Noches</td><td class="value">${escape(p.noches)}</td></tr>
      <tr><td class="label">Huéspedes</td><td class="value">${escape(p.personas)}</td></tr>
    </table>
  </div>

  <h2>Tarifa</h2>
  <div class="panel">
    <table>
      <tr><td class="label">Por noche</td><td class="value">${escape(fmtCurrency(p.precioPorNoche))}</td></tr>
      <tr><td class="label">Subtotal (${escape(p.noches)} × ${escape(fmtCurrency(p.precioPorNoche))})</td><td class="value">${escape(fmtCurrency(p.subtotal))}</td></tr>
      ${p.depositoSeguridad > 0 ? `<tr><td class="label">Depósito de seguridad</td><td class="value">${escape(fmtCurrency(p.depositoSeguridad))}</td></tr>` : ''}
      <tr class="total"><td class="label">Total</td><td class="value">${escape(fmtCurrency(p.total))}</td></tr>
    </table>
  </div>

  <div class="panel anticipo">
    <table>
      <tr><td class="label">Anticipo requerido</td><td class="value">${escape(fmtCurrency(p.anticipoRequerido))}</td></tr>
    </table>
  </div>

  ${p.metodoPago.length > 0 ? `<h2>Métodos de pago</h2>
  <div class="panel">${p.metodoPago.map((m) => escape(m)).join(' · ')}</div>` : ''}

  <h2>Titular</h2>
  <div class="panel">
    <table>
      <tr><td class="label">Nombre</td><td class="value">${escape(p.cliente.nombre)}</td></tr>
      ${p.cliente.documento ? `<tr><td class="label">Documento</td><td class="value">${escape(p.cliente.documento)}</td></tr>` : ''}
      ${p.cliente.celular ? `<tr><td class="label">Celular</td><td class="value">${escape(p.cliente.celular)}</td></tr>` : ''}
      ${p.cliente.email ? `<tr><td class="label">Email</td><td class="value">${escape(p.cliente.email)}</td></tr>` : ''}
      ${p.cliente.direccion ? `<tr><td class="label">Dirección</td><td class="value">${escape(p.cliente.direccion)}</td></tr>` : ''}
    </table>
  </div>

  <div class="footer">
    Documento generado el ${escape(new Date(p.emittedAt).toLocaleString('es-CO'))}.<br>
    De Paseo en Fincas · este enlace contiene una firma HMAC y caduca si los datos cambian.
  </div>
</body>
</html>`;
    return reply.type('text/html; charset=utf-8').send(html);
  });
}
