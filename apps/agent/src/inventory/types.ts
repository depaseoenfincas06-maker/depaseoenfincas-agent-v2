/**
 * Finca = property in the catalog. Loaded from the Google Sheet.
 * fincaId is a stable code (e.g. "F001") — we NEVER expose `realName`
 * to the client until the conversation reaches CONFIRMING_RESERVATION.
 */
export interface Finca {
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
  raw: Record<string, unknown>; // original sheet row, for debugging
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
