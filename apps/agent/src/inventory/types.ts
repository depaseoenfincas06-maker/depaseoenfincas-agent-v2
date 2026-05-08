/**
 * Finca = property in the catalog. Loaded from the Google Sheet.
 * fincaId is a stable code (e.g. "F001") — we NEVER expose `realName`
 * to the client until the conversation reaches CONFIRMING_RESERVATION.
 */
/**
 * Finca shape used internally. Combines our canonical fields (camelCase) with
 * the v1-compatible snake_case columns from the Google Sheet (e.g.
 * `precio_noche_base`, `min_noches`, `pet_friendly`). The matcher (`match.ts`)
 * reads the v1 column names directly because that's how the inventory CSV is
 * structured — keeping them on the Finca type avoids constant transforms.
 */
export interface Finca {
  // Canonical (v2) fields
  fincaId: string;
  realName: string;
  zona: string;
  ciudad?: string;
  capacidadMin?: number;
  capacidadMax: number;
  precioPorNoche?: number;
  precioPorPersona?: number;
  amenidades: string[];
  mascotas: boolean;
  fotos: string[];
  descripcionCorta?: string;
  raw: Record<string, unknown>;

  // v1-compatible fields read directly from the sheet
  codigo_original?: string;
  capacidad_minima_tarifa?: number;
  habitaciones?: number;
  min_noches?: number;
  precio_noche_base?: number;
  precio_fin_semana?: number;
  precio_festivo?: number;
  precio_semana_santa_receso?: number;
  precio_temporada_alta?: number;
  precio_persona_extra?: number;
  pet_friendly?: boolean;
  tipo_evento?: string[];
  foto_url?: string;
  owner_nombre?: string;
  owner_contacto?: string;
  descuento_max_pct?: number;
  especificacion_habitaciones?: string;
  observaciones_originales?: string;
  caracteristicas_originales?: string;
  deposito_seguridad?: number;
  empleadas?: number;
  administrador_nombre?: string;
  administrador_contacto?: string;
  pricing_model?: string;
  review_notes?: string;
  prioridad?: number;
}

export interface FincaQuery {
  personas?: number;
  /**
   * Either a single zone or an array (OR logic). A finca matches if its zona
   * matches ANY of the entries.
   */
  zona?: string | string[];
  /** Same as zona — accepts string or array, matched with OR. */
  ciudad?: string | string[];
  presupuestoMax?: number;
  amenidadesRequeridas?: string[];
  mascotas?: boolean;
  excludeIds?: string[];
  limit?: number;
}

export interface FincaMatch {
  finca: Finca;
  score: number;
  reasons: string[];
  /** Anonymized view safe to send to the LLM during OFFERING. */
  publicView: PublicFincaView;
}

/**
 * The view the LLM is allowed to see when proposing fincas. Strips realName
 * to enforce the privacy invariant on the OFFERING stage.
 */
export interface PublicFincaView {
  fincaId: string;
  zona: string;
  ciudad?: string;
  capacidadMax: number;
  capacidadMin?: number;
  precioPorNoche?: number;
  precioPorPersona?: number;
  amenidades: string[];
  mascotas: boolean;
  descripcionCorta?: string;
}
