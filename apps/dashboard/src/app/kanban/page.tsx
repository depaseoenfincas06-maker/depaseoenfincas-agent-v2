import Link from 'next/link';
import { get } from '@/lib/api';

interface KanbanRow {
  wa_id: string;
  client_name: string | null;
  search_criteria: Record<string, unknown>;
  selected_finca: string | null;
  agente_activo: boolean;
  updated_at: string;
}

type Kanban = Record<string, KanbanRow[]>;

const COLUMNS = [
  { key: 'QUALIFYING', title: 'Qualifying' },
  { key: 'OFFERING', title: 'Offering' },
  { key: 'VERIFYING_AVAILABILITY', title: 'Verifying' },
  { key: 'CONFIRMING_RESERVATION', title: 'Confirming' },
  { key: 'HITL', title: 'HITL' },
];

export const dynamic = 'force-dynamic';

export default async function KanbanPage() {
  const data = await get<Kanban>('/kanban');
  return (
    <div>
      <h1>Kanban</h1>
      <div className="kanban">
        {COLUMNS.map((col) => {
          const rows = data[col.key] ?? [];
          return (
            <div key={col.key} className="kanban-col">
              <h3>
                {col.title} · <span className="muted">{rows.length}</span>
              </h3>
              {rows.map((r) => (
                <Link key={r.wa_id} href={`/conversations/${encodeURIComponent(r.wa_id)}`}>
                  <div className="kanban-card">
                    <div className="name">
                      {r.client_name ?? r.wa_id}
                      {!r.agente_activo && ' 🟡'}
                    </div>
                    <div className="meta">
                      {Object.entries(r.search_criteria ?? {})
                        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
                        .join(', ') || '—'}
                    </div>
                    {r.selected_finca && (
                      <div className="meta">selected: {r.selected_finca}</div>
                    )}
                    <div className="meta">{new Date(r.updated_at).toLocaleString()}</div>
                  </div>
                </Link>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
