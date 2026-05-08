import { describe, it, expect } from 'vitest';
import { buildFincaCard, buildMediaMessages, buildPropertySequence } from './finca-card.js';

describe('buildFincaCard', () => {
  it('renders v1-style card with codigo_original as title and emojis on amenities', () => {
    const card = buildFincaCard({
      finca_id: 'F009',
      codigo_original: 'PEREIRA #09',
      habitaciones: 4,
      capacidad_max: 10,
      amenidades: ['piscina', 'jacuzzi', 'BBQ'],
      ciudad: 'Pereira',
      zona: 'Eje cafetero',
      tiempo_en_vehiculo: '1h',
      precio_noche_base: 1200000,
      observaciones_originales: '3 baños',
    });
    expect(card).toContain('☀️🌴*PEREIRA #09*🌴☀️');
    expect(card).toContain('- 4 habitaciones 🍃');
    expect(card).toContain('- 3 baños 🚻');
    expect(card).toContain('- Piscina 🏊');
    expect(card).toContain('- Jacuzzi 🛁');
    expect(card).toContain('- BBQ ♨️');
    expect(card).toContain('Capacidad máxima 10 personas 👥');
    expect(card).toContain('Ubicada en Pereira, Eje cafetero');
    expect(card).toContain('Tiempo aproximado en vehículo: 1h');
    expect(card).toContain('Tarifa: $ 1.200.000/noche');
  });

  it('NEVER includes realName — only codigo_original is exposed in the title', () => {
    const card = buildFincaCard({
      finca_id: 'F009',
      codigo_original: 'PEREIRA #09',
      // realName-equivalent fields the LLM might mistakenly pass through
      nombre: 'Finca La Maravilla',
      capacidad_max: 8,
      amenidades: [],
    } as any);
    expect(card).toContain('PEREIRA #09');
    expect(card).not.toContain('Maravilla');
    expect(card).not.toContain('La Maravilla');
  });

  it('falls back gracefully when only minimal fields exist', () => {
    const card = buildFincaCard({ finca_id: 'F001', capacidad_max: 6, amenidades: [] });
    expect(card).toContain('*F001*');
    expect(card).toContain('Capacidad máxima 6 personas 👥');
  });

  it('returns null for empty input', () => {
    expect(buildFincaCard(null as unknown as { finca_id: string })).toBeNull();
  });
});

describe('buildMediaMessages', () => {
  it('builds a media_group with the photos array', () => {
    const items = buildMediaMessages({
      finca_id: 'F009',
      codigo_original: 'PEREIRA #09',
      capacidad_max: 10,
      amenidades: [],
      fotos: [
        'https://example.com/a.jpg',
        'https://example.com/b.jpg',
        'https://example.com/c.jpg',
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe('media_group');
    expect(items[0]!.media_urls).toHaveLength(3);
    expect(items[0]!.property_title).toBe('PEREIRA #09');
    expect(items[0]!.media_count).toBe(3);
  });

  it('parses comma-separated foto_url string', () => {
    const items = buildMediaMessages({
      finca_id: 'F010',
      capacidad_max: 6,
      amenidades: [],
      foto_url: 'https://x.com/1.jpg, https://x.com/2.jpg',
    });
    expect(items[0]!.media_urls).toHaveLength(2);
  });

  it('returns empty array when there are no photos', () => {
    const items = buildMediaMessages({ finca_id: 'F011', capacidad_max: 4, amenidades: [] });
    expect(items).toEqual([]);
  });
});

describe('buildPropertySequence', () => {
  it('produces interleaved [card, media, card, media] sequence', () => {
    const seq = buildPropertySequence([
      {
        finca_id: 'F009',
        codigo_original: 'PEREIRA #09',
        capacidad_max: 10,
        amenidades: ['piscina'],
        fotos: ['https://x.com/9a.jpg', 'https://x.com/9b.jpg'],
      },
      {
        finca_id: 'F003',
        codigo_original: 'CARMEN #03',
        capacidad_max: 8,
        amenidades: ['jacuzzi'],
        fotos: ['https://x.com/3a.jpg'],
      },
    ]);
    // [card1, media1, card2, media2]
    expect(seq).toHaveLength(4);
    expect(seq[0]!.type).toBe('text');
    expect(seq[0]!.content).toContain('PEREIRA #09');
    expect(seq[1]!.type).toBe('media_group');
    expect(seq[1]!.property_id).toBe('F009');
    expect(seq[2]!.type).toBe('text');
    expect(seq[2]!.content).toContain('CARMEN #03');
    expect(seq[3]!.type).toBe('media_group');
    expect(seq[3]!.property_id).toBe('F003');
  });

  it('skips the media item when a finca has no photos', () => {
    const seq = buildPropertySequence([
      { finca_id: 'F001', codigo_original: 'TEST #01', capacidad_max: 4, amenidades: [] },
    ]);
    expect(seq).toHaveLength(1);
    expect(seq[0]!.type).toBe('text');
  });
});
