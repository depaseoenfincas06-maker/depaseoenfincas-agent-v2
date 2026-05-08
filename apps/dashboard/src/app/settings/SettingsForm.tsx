'use client';

import { useState } from 'react';
import { put } from '@/lib/api';

/**
 * Replicates the v1 Ops Console "Configuración del asistente" page exactly:
 * the same cards, the same field labels, the same accordion of per-stage
 * prompt addenda, the same dynamic list for company documents.
 *
 * Wired to the v2 backend: every field maps to a column on agent_settings
 * (most existed; the v1-parity fields were added in migration 0002).
 */

interface CompanyDocument {
  name?: string;
  url?: string;
  topics?: string[];
  description?: string;
}

interface PromptAddenda {
  global?: string | null;
  qualifying?: string | null;
  offering?: string | null;
  verifying?: string | null;
  qa?: string | null;
  hitl?: string | null;
  confirming?: string | null;
}

export interface Settings {
  tone_preset: string | null;
  tone_guidelines_extra: string | null;
  initial_message_template: string | null;
  handoff_message: string | null;
  company_knowledge: unknown;
  company_documents: CompanyDocument[] | null;
  payment_methods: unknown;
  inventory_sheet_id: string | null;
  inventory_sheet_tab: string | null;
  owner_test_mode: boolean;
  prompt_addenda: PromptAddenda | null;
  coverage_zones: string | null;
  public_app_base_url: string | null;
  max_properties_to_show: number | null;
  global_bot_enabled: boolean;
  owner_contact_override: string | null;
  selection_notification_settings: { enabled?: boolean; recipients?: string[] } | null;
}

const TONE_PRESETS = [
  { value: 'calido_profesional', label: 'Cálido profesional' },
  { value: 'premium_cercano', label: 'Premium cercano' },
  { value: 'directo_eficiente', label: 'Directo eficiente' },
];

/** Coerce JSONB knowledge/payment back to a textarea-friendly string. */
function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && Object.keys(v as object).length === 0) return '';
  return JSON.stringify(v, null, 2);
}

export default function SettingsForm({ initial }: { initial: Settings }) {
  const [s, setS] = useState<Settings>(initial);
  const [companyKnowledgeText, setCompanyKnowledgeText] = useState(asText(initial.company_knowledge));
  const [paymentMethodsText, setPaymentMethodsText] = useState(asText(initial.payment_methods));
  const [docs, setDocs] = useState<CompanyDocument[]>(initial.company_documents ?? []);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setS((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  function updateAddendum(stage: keyof PromptAddenda, value: string) {
    setS((prev) => ({
      ...prev,
      prompt_addenda: { ...(prev.prompt_addenda ?? {}), [stage]: value || null },
    }));
    setDirty(true);
  }

  function addDoc() {
    setDocs((prev) => [...prev, { name: '', url: '', topics: [] }]);
    setDirty(true);
  }
  function updateDoc(idx: number, patch: Partial<CompanyDocument>) {
    setDocs((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
    setDirty(true);
  }
  function removeDoc(idx: number) {
    setDocs((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const updated = await put<Settings>('/settings', {
        tonePreset: s.tone_preset,
        toneGuidelinesExtra: s.tone_guidelines_extra,
        initialMessageTemplate: s.initial_message_template,
        handoffMessage: s.handoff_message,
        companyKnowledge: companyKnowledgeText,
        paymentMethods: paymentMethodsText,
        companyDocuments: docs,
        inventorySheetId: s.inventory_sheet_id,
        inventorySheetTab: s.inventory_sheet_tab,
        ownerTestMode: s.owner_test_mode,
        promptAddenda: s.prompt_addenda ?? {},
        coverageZones: s.coverage_zones,
        publicAppBaseUrl: s.public_app_base_url,
        maxPropertiesToShow: s.max_properties_to_show ?? 3,
        globalBotEnabled: s.global_bot_enabled,
        ownerContactOverride: s.owner_contact_override,
      });
      setS(updated);
      setCompanyKnowledgeText(asText(updated.company_knowledge));
      setPaymentMethodsText(asText(updated.payment_methods));
      setDocs(updated.company_documents ?? []);
      setSavedAt(new Date().toLocaleTimeString());
      setDirty(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const addenda = s.prompt_addenda ?? {};
  const selRecipients = (s.selection_notification_settings?.recipients ?? []).join(', ');
  const selEnabled = s.selection_notification_settings?.enabled ?? false;

  return (
    <div className="settings-shell">
      <header className="settings-header">
        <div>
          <p className="eyebrow">Configuración viva</p>
          <h2>Configuración del asistente</h2>
        </div>
        <div className="settings-header__actions">
          <span className="chat-panel__badge">
            {dirty ? 'Cambios sin guardar' : savedAt ? `Guardado ${savedAt}` : 'Sin cambios'}
          </span>
          <button className="primary-btn" onClick={save} disabled={saving || !dirty}>
            {saving ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </header>

      {err && <div className="settings-alert settings-alert--error">⚠️ {err}</div>}

      <form className="settings-grid" onSubmit={(e) => e.preventDefault()}>
        {/* ---- Cómo responde el asistente ---- */}
        <section className="settings-card settings-card--wide">
          <div className="settings-card__head">
            <div>
              <h3>Cómo responde el asistente</h3>
              <p className="settings-card__subtext">
                Aquí defines el estilo del asistente y el primer mensaje que verá el cliente al iniciar una conversación.
              </p>
            </div>
          </div>
          <div className="settings-row settings-row--double">
            <label className="settings-field">
              <span>Estilo de conversación</span>
              <select
                value={s.tone_preset ?? ''}
                onChange={(e) => update('tone_preset', e.target.value)}
              >
                <option value="">— Sin preset —</option>
                {TONE_PRESETS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <small className="settings-help">Elige cómo quieres que suene el asistente en general.</small>
            </label>
            <label className="settings-field">
              <span>Indicaciones adicionales (opcional)</span>
              <textarea
                rows={5}
                placeholder="Ej: tono colombiano de Bogotá, cálido y profesional. Usa 'porfa', 'listo', 'claro que sí' con naturalidad."
                value={s.tone_guidelines_extra ?? ''}
                onChange={(e) => update('tone_guidelines_extra', e.target.value)}
              />
              <small className="settings-help">Úsalo solo si quieres ajustar detalles del estilo de respuesta.</small>
            </label>
          </div>
          <label className="settings-field">
            <span>Primer mensaje de bienvenida</span>
            <textarea
              rows={5}
              placeholder="Mensaje que el asistente enviará cuando se abra una conversación nueva."
              value={s.initial_message_template ?? ''}
              onChange={(e) => update('initial_message_template', e.target.value)}
            />
            <small className="settings-help">Este es el saludo inicial que verá el cliente al comenzar la atención.</small>
          </label>
          <label className="settings-field">
            <span>Mensaje de escalación a humano (HITL)</span>
            <textarea
              rows={3}
              placeholder="Mensaje que el asistente enviará cuando se cambie a humano."
              value={s.handoff_message ?? ''}
              onChange={(e) => update('handoff_message', e.target.value)}
            />
          </label>
        </section>

        {/* ---- Instrucciones adicionales por agente ---- */}
        <section className="settings-card settings-card--wide">
          <div className="settings-card__head">
            <div>
              <h3>Instrucciones adicionales para el agente</h3>
              <p className="settings-card__subtext">
                Se agregan al final del prompt base de cada agente. Dejar vacío para usar solo el prompt base.
              </p>
            </div>
          </div>
          <label className="settings-field">
            <span>Instrucciones globales (aplican a todos los agentes)</span>
            <textarea
              rows={3}
              placeholder="Instrucciones adicionales que se agregan a todos los agentes del sistema..."
              value={addenda.global ?? ''}
              onChange={(e) => updateAddendum('global', e.target.value)}
            />
          </label>
          <div className="settings-accordion">
            {[
              { key: 'qualifying', label: 'Qualifying (calificación)' },
              { key: 'offering', label: 'Offering (oferta de fincas)' },
              { key: 'verifying', label: 'Verifying (verificación de disponibilidad)' },
              { key: 'qa', label: 'QA (preguntas y respuestas)' },
              { key: 'hitl', label: 'HITL (escalación a humano)' },
              { key: 'confirming', label: 'Confirming (confirmación de reserva)' },
            ].map((stage) => (
              <details key={stage.key} className="settings-accordion__item">
                <summary>{stage.label}</summary>
                <textarea
                  rows={3}
                  placeholder={`Instrucciones adicionales para el agente de ${stage.label.toLowerCase()}...`}
                  value={(addenda[stage.key as keyof PromptAddenda] as string | null | undefined) ?? ''}
                  onChange={(e) => updateAddendum(stage.key as keyof PromptAddenda, e.target.value)}
                />
              </details>
            ))}
          </div>
        </section>

        {/* ---- Conocimiento de la empresa ---- */}
        <section className="settings-card settings-card--wide">
          <div className="settings-card__head">
            <div>
              <h3>Conocimiento de la empresa</h3>
              <p className="settings-card__subtext">
                Información institucional, medios de pago y documentos que el agente usará para responder preguntas sobre la empresa.
              </p>
            </div>
          </div>
          <label className="settings-field">
            <span>Información general de la empresa</span>
            <small className="settings-help">
              Incluye sedes, representante legal, historia, redes sociales y cualquier dato institucional relevante.
            </small>
            <textarea
              rows={8}
              placeholder="Sedes, representante legal, historia, redes sociales, datos institucionales..."
              value={companyKnowledgeText}
              onChange={(e) => {
                setCompanyKnowledgeText(e.target.value);
                setDirty(true);
              }}
            />
          </label>
          <label className="settings-field">
            <span>Medios de pago</span>
            <small className="settings-help">
              Describe cómo deben pagar los clientes: cuentas, números, instrucciones y condiciones.
            </small>
            <textarea
              rows={6}
              placeholder="Ej: Transferencia Bancolombia - Cuenta de ahorros 123-456789-00 a nombre de De Paseo en Fincas SAS. Nequi al 300-123-4567. El anticipo es del 50% para confirmar la reserva."
              value={paymentMethodsText}
              onChange={(e) => {
                setPaymentMethodsText(e.target.value);
                setDirty(true);
              }}
            />
          </label>
          <div>
            <h4 style={{ margin: '8px 0 4px', fontSize: 13, color: 'var(--text-strong)' }}>Documentos de la empresa</h4>
            <p className="settings-card__subtext" style={{ marginBottom: 10 }}>
              Documentos que el agente puede compartir cuando el cliente los solicite (RUT, Cámara de Comercio, etc).
            </p>
            <div className="settings-dynamic-list">
              {docs.map((d, i) => (
                <div key={i} className="settings-dynamic-list__row">
                  <label className="settings-field">
                    <span>Nombre</span>
                    <input
                      value={d.name ?? ''}
                      onChange={(e) => updateDoc(i, { name: e.target.value })}
                      placeholder="RUT 2026"
                    />
                  </label>
                  <label className="settings-field">
                    <span>URL pública</span>
                    <input
                      value={d.url ?? ''}
                      onChange={(e) => updateDoc(i, { url: e.target.value })}
                      placeholder="https://drive.google.com/file/..."
                    />
                  </label>
                  <label className="settings-field">
                    <span>Tópicos (separados por coma)</span>
                    <input
                      value={(d.topics ?? []).join(', ')}
                      onChange={(e) =>
                        updateDoc(i, {
                          topics: e.target.value
                            .split(',')
                            .map((t) => t.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="rut, fiscal"
                    />
                  </label>
                  <button type="button" className="settings-remove-btn" onClick={() => removeDoc(i)}>
                    Quitar
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="settings-add-btn" onClick={addDoc} style={{ marginTop: 10 }}>
              + Agregar documento
            </button>
          </div>
        </section>

        {/* ---- Confirmación de reserva ---- */}
        <section className="settings-card">
          <div className="settings-card__head">
            <div>
              <h3>Confirmación de reserva</h3>
              <p className="settings-card__subtext">
                Configuración del PDF de confirmación que se envía al cliente.
              </p>
            </div>
          </div>
          <label className="settings-field">
            <span>URL pública del dashboard / simulador</span>
            <small className="settings-help">
              Se usa para generar el PDF de confirmación de reserva que se envía al cliente.
            </small>
            <input
              type="text"
              placeholder="https://depaseoenfincas-agent-v2-dashboard.vercel.app"
              value={s.public_app_base_url ?? ''}
              onChange={(e) => update('public_app_base_url', e.target.value)}
            />
          </label>
        </section>

        {/* ---- Base de propiedades ---- */}
        <section className="settings-card">
          <div className="settings-card__head">
            <div>
              <h3>Base de propiedades</h3>
              <p className="settings-card__subtext">Define de dónde lee el asistente la información de las fincas.</p>
            </div>
          </div>
          <label className="settings-field">
            <span>ID del archivo de Google Sheets</span>
            <input
              type="text"
              value={s.inventory_sheet_id ?? ''}
              onChange={(e) => update('inventory_sheet_id', e.target.value)}
            />
            <small className="settings-help">
              Normalmente no necesitas cambiarlo. Modifícalo solo si tu equipo cambió el archivo fuente.
            </small>
          </label>
          <label className="settings-field">
            <span>Nombre de la pestaña</span>
            <input
              type="text"
              value={s.inventory_sheet_tab ?? ''}
              onChange={(e) => update('inventory_sheet_tab', e.target.value)}
            />
            <small className="settings-help">Es la hoja dentro del archivo donde están cargadas las propiedades.</small>
          </label>
          <label className="settings-field">
            <span>Máximo de opciones por mensaje</span>
            <input
              type="number"
              min={1}
              max={10}
              value={s.max_properties_to_show ?? 3}
              onChange={(e) => update('max_properties_to_show', Number(e.target.value))}
            />
            <small className="settings-help">
              Limita cuántas propiedades puede mostrar el asistente en una sola respuesta.
            </small>
          </label>
        </section>

        {/* ---- Operación general ---- */}
        <section className="settings-card">
          <div className="settings-card__head">
            <div>
              <h3>Operación general</h3>
              <p className="settings-card__subtext">
                Controla si el asistente atiende, qué zonas comunica y qué número usar en pruebas.
              </p>
            </div>
          </div>
          <label className="settings-field settings-field--inline settings-toggle">
            <span>Asistente automático activo</span>
            <input
              type="checkbox"
              checked={s.global_bot_enabled}
              onChange={(e) => update('global_bot_enabled', e.target.checked)}
            />
          </label>
          <label className="settings-field settings-field--inline settings-toggle">
            <span>Prueba de propietarios</span>
            <input
              type="checkbox"
              checked={s.owner_test_mode}
              onChange={(e) => update('owner_test_mode', e.target.checked)}
            />
          </label>
          <label className="settings-field">
            <span>Número de prueba para el propietario</span>
            <input
              type="text"
              placeholder="Campo legado para otras pruebas internas"
              value={s.owner_contact_override ?? ''}
              onChange={(e) => update('owner_contact_override', e.target.value)}
            />
            <small className="settings-help">
              Este campo ya no controla la verificación de disponibilidad con propietarios. Usa el toggle de prueba de propietarios.
            </small>
          </label>
          <label className="settings-field">
            <span>Zonas que quieres comunicar como cobertura</span>
            <textarea
              rows={5}
              placeholder="Escribe aquí las zonas que el asistente debe mencionar como parte de la cobertura comercial."
              value={s.coverage_zones ?? ''}
              onChange={(e) => update('coverage_zones', e.target.value)}
            />
            <small className="settings-help">Puedes usar una lista simple de lugares o una explicación breve.</small>
          </label>
        </section>

        {/* ---- Aviso interno ---- */}
        <section className="settings-card">
          <div className="settings-card__head">
            <div>
              <h3>Aviso interno cuando el cliente elige una finca</h3>
              <p className="settings-card__subtext">
                Estas alertas se envían a tu equipo para continuar el proceso cuando el cliente elige una propiedad.
              </p>
            </div>
          </div>
          <label className="settings-field settings-field--inline settings-toggle">
            <span>Enviar aviso interno</span>
            <input
              type="checkbox"
              checked={selEnabled}
              onChange={(e) => {
                update('selection_notification_settings', {
                  ...(s.selection_notification_settings ?? {}),
                  enabled: e.target.checked,
                });
              }}
            />
          </label>
          <label className="settings-field">
            <span>Números que recibirán el aviso</span>
            <input
              type="text"
              placeholder="573001112233, 573004445566"
              value={selRecipients}
              onChange={(e) =>
                update('selection_notification_settings', {
                  ...(s.selection_notification_settings ?? {}),
                  recipients: e.target.value
                    .split(',')
                    .map((r) => r.trim())
                    .filter(Boolean),
                })
              }
            />
            <small className="settings-help">Separa los números con comas. Sin '+' ni espacios (ej: 573001112233).</small>
          </label>
        </section>
      </form>
    </div>
  );
}
