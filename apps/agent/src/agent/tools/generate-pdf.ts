/**
 * Reservation confirmation PDF generator. Self-contained — no external PDF
 * library. Produces a small (~5KB) one-page document with property + dates +
 * pricing + titular data + payment methods.
 *
 * Port of the simulator/lib/reservation_confirmation_pdf.mjs from the legacy
 * project, adapted to use Buffer and TS types. Kept intentionally minimal:
 * fancy layout improvements come later via vector-pdf or pdfkit if needed.
 */
import { Buffer } from 'node:buffer';
import type { Finca } from '../../inventory/types.js';

interface GenerateInput {
  finca: Finca;
  reservation: Record<string, string>;
  searchCriteria: { fechaInicio?: string; fechaFin?: string; personas?: number };
  paymentMethods: Record<string, unknown>;
}

interface GenerateOutput {
  base64: string;
  filename: string;
  bytes: number;
}

class PDFBuilder {
  private content: string[] = [];
  private y = 760;
  private readonly leftMargin = 60;
  private readonly width = 480;

  addHeader(title: string) {
    this.content.push(
      `BT /F2 18 Tf ${this.leftMargin} ${this.y} Td 0.110 0.369 0.541 rg (${this.escape(title)}) Tj ET`,
    );
    this.y -= 30;
    this.content.push(
      `0.110 0.369 0.541 RG 1 w ${this.leftMargin} ${this.y} m ${this.leftMargin + this.width} ${this.y} l S 0 0 0 RG`,
    );
    this.y -= 20;
  }

  addSection(title: string) {
    this.y -= 8;
    this.content.push(
      `BT /F2 12 Tf ${this.leftMargin} ${this.y} Td 0.110 0.369 0.541 rg (${this.escape(title)}) Tj ET`,
    );
    this.y -= 18;
    this.content.push(`0 0 0 rg`);
  }

  addLine(label: string, value: string) {
    this.content.push(
      `BT /F2 10 Tf ${this.leftMargin} ${this.y} Td (${this.escape(label)}) Tj ET`,
    );
    this.content.push(
      `BT /F1 10 Tf ${this.leftMargin + 110} ${this.y} Td (${this.escape(value)}) Tj ET`,
    );
    this.y -= 16;
  }

  addText(text: string) {
    this.content.push(
      `BT /F1 10 Tf ${this.leftMargin} ${this.y} Td (${this.escape(text)}) Tj ET`,
    );
    this.y -= 14;
  }

  finish(): Buffer {
    const stream = `q\n${this.content.join('\n')}\nQ`;
    const obj1 = '<< /Type /Catalog /Pages 2 0 R >>';
    const obj2 = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
    const obj3 = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`;
    const obj4 = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    const obj5 = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    const obj6 = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
    const objects = [obj1, obj2, obj3, obj4, obj5, obj6];

    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefOffset = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach((o) => {
      pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
    });
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return Buffer.from(pdf, 'latin1');
  }

  private escape(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }
}

function formatDate(s: string | undefined): string {
  if (!s) return '—';
  return s;
}

function nights(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(1, Math.round((b - a) / 86_400_000));
}

export async function generateReservationPDF(input: GenerateInput): Promise<GenerateOutput> {
  const { finca, reservation, searchCriteria, paymentMethods } = input;
  const builder = new PDFBuilder();
  builder.addHeader('Confirmación de Reserva — De Paseo en Fincas');

  builder.addSection('Propiedad');
  builder.addLine('Finca:', finca.realName);
  builder.addLine('Código:', finca.fincaId);
  builder.addLine('Zona:', `${finca.zona}${finca.ciudad ? ` — ${finca.ciudad}` : ''}`);
  if (finca.descripcionCorta) builder.addLine('Descripción:', finca.descripcionCorta);

  builder.addSection('Estadía');
  builder.addLine('Llegada:', formatDate(searchCriteria.fechaInicio));
  builder.addLine('Salida:', formatDate(searchCriteria.fechaFin));
  builder.addLine('Personas:', String(searchCriteria.personas ?? '—'));
  const n = nights(searchCriteria.fechaInicio, searchCriteria.fechaFin);
  if (n != null) builder.addLine('Noches:', String(n));

  builder.addSection('Tarifa');
  if (finca.precioPorNoche) builder.addLine('Precio/noche:', `$${finca.precioPorNoche.toLocaleString('es-CO')}`);
  if (n != null && finca.precioPorNoche) {
    builder.addLine('Total:', `$${(finca.precioPorNoche * n).toLocaleString('es-CO')}`);
  }

  builder.addSection('Datos del Titular');
  builder.addLine('Nombre:', reservation.nombreCompleto ?? '');
  builder.addLine('Documento:', `${reservation.tipoDocumento ?? ''} ${reservation.numeroDocumento ?? ''}`);
  builder.addLine('Celular:', reservation.celular ?? '');
  builder.addLine('Email:', reservation.email ?? '');
  builder.addLine('Dirección:', reservation.direccion ?? '');

  builder.addSection('Medios de Pago');
  const lines = paymentMethods && typeof paymentMethods === 'object' ? Object.entries(paymentMethods) : [];
  if (lines.length === 0) {
    builder.addText('Te confirmamos los detalles por este medio.');
  } else {
    for (const [label, value] of lines) {
      builder.addLine(`${label}:`, String(value));
    }
  }

  const pdfBuffer = builder.finish();
  return {
    base64: pdfBuffer.toString('base64'),
    filename: `reserva-${finca.fincaId}-${Date.now()}.pdf`,
    bytes: pdfBuffer.length,
  };
}
