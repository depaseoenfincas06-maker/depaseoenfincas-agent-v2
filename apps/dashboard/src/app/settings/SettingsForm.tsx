'use client';

import { useState } from 'react';
import { put } from '@/lib/api';

interface Settings {
  tone_preset: string;
  tone_guidelines_extra: string | null;
  initial_message_template: string | null;
  handoff_message: string | null;
  company_knowledge: Record<string, unknown>;
  company_documents: Array<Record<string, unknown>>;
  payment_methods: Record<string, unknown>;
  inventory_sheet_id: string | null;
  inventory_sheet_tab: string | null;
  owner_test_mode: boolean;
}

export default function SettingsForm({ initial }: { initial: Settings }) {
  const [s, setS] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const updated = await put<Settings>('/settings', {
        tonePreset: s.tone_preset,
        toneGuidelinesExtra: s.tone_guidelines_extra,
        initialMessageTemplate: s.initial_message_template,
        handoffMessage: s.handoff_message,
        companyKnowledge: s.company_knowledge,
        companyDocuments: s.company_documents,
        paymentMethods: s.payment_methods,
        inventorySheetId: s.inventory_sheet_id,
        inventorySheetTab: s.inventory_sheet_tab,
        ownerTestMode: s.owner_test_mode,
      });
      setS(updated);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function setJsonField<K extends 'company_knowledge' | 'company_documents' | 'payment_methods'>(
    field: K,
    value: string,
  ) {
    try {
      const parsed = JSON.parse(value);
      setS({ ...s, [field]: parsed });
      setErr(null);
    } catch {
      setErr(`${field}: invalid JSON`);
    }
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Tone</h2>
        <div className="muted" style={{ marginBottom: 6 }}>Preset (free text — used as base instruction)</div>
        <input
          value={s.tone_preset}
          onChange={(e) => setS({ ...s, tone_preset: e.target.value })}
          placeholder="colombian-bogota-warm"
        />
        <div className="muted" style={{ marginTop: 12, marginBottom: 6 }}>
          Extra tone guidelines (Colombian-Bogotá expressions, no-go words, etc.)
        </div>
        <textarea
          value={s.tone_guidelines_extra ?? ''}
          onChange={(e) => setS({ ...s, tone_guidelines_extra: e.target.value })}
          placeholder='Tono colombiano de Bogotá, cálido y profesional. Tutea o ustea según el cliente. Usa "porfa", "listo", "claro que sí" con naturalidad. Nunca "vos". Sé breve.'
        />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Messages</h2>
        <div className="muted" style={{ marginBottom: 6 }}>Initial message template ({'{client_name}'} substituted)</div>
        <textarea
          value={s.initial_message_template ?? ''}
          onChange={(e) => setS({ ...s, initial_message_template: e.target.value })}
        />
        <div className="muted" style={{ marginTop: 12, marginBottom: 6 }}>Handoff message (HITL)</div>
        <textarea
          value={s.handoff_message ?? ''}
          onChange={(e) => setS({ ...s, handoff_message: e.target.value })}
        />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Company Knowledge (JSON)</h2>
        <div className="muted" style={{ marginBottom: 6 }}>
          Free-form facts the QA agent uses. Keys are categories; values can be strings or objects.
        </div>
        <textarea
          defaultValue={JSON.stringify(s.company_knowledge ?? {}, null, 2)}
          onChange={(e) => setJsonField('company_knowledge', e.target.value)}
          style={{ minHeight: 160 }}
        />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Company Documents (JSON array)</h2>
        <div className="muted" style={{ marginBottom: 6 }}>
          {`[{ "name": "RUT 2026", "url": "https://...", "topics": ["rut"] }]`}
        </div>
        <textarea
          defaultValue={JSON.stringify(s.company_documents ?? [], null, 2)}
          onChange={(e) => setJsonField('company_documents', e.target.value)}
          style={{ minHeight: 120 }}
        />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Payment Methods (JSON)</h2>
        <textarea
          defaultValue={JSON.stringify(s.payment_methods ?? {}, null, 2)}
          onChange={(e) => setJsonField('payment_methods', e.target.value)}
          style={{ minHeight: 120 }}
        />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Inventory</h2>
        <div className="muted" style={{ marginBottom: 6 }}>Google Sheets document ID</div>
        <input
          value={s.inventory_sheet_id ?? ''}
          onChange={(e) => setS({ ...s, inventory_sheet_id: e.target.value })}
        />
        <div className="muted" style={{ marginTop: 12, marginBottom: 6 }}>Tab name</div>
        <input
          value={s.inventory_sheet_tab ?? ''}
          onChange={(e) => setS({ ...s, inventory_sheet_tab: e.target.value })}
        />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Misc</h2>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={s.owner_test_mode}
            onChange={(e) => setS({ ...s, owner_test_mode: e.target.checked })}
            style={{ width: 'auto' }}
          />
          Owner test mode (don&apos;t send real WhatsApp messages to property owners)
        </label>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedAt && <span className="muted">Saved at {savedAt}</span>}
        {err && <span style={{ color: 'var(--error)' }}>{err}</span>}
      </div>
    </div>
  );
}
