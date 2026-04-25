import Link from 'next/link';
import { get } from '@/lib/api';

interface Row {
  wa_id: string;
  client_name: string | null;
  current_stage: string;
  search_criteria: Record<string, unknown>;
  selected_finca: string | null;
  agente_activo: boolean;
  updated_at: string;
}

export const dynamic = 'force-dynamic';

export default async function ConversationsPage() {
  const rows = await get<Row[]>('/conversations?limit=200');
  return (
    <div>
      <h1>Conversations</h1>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>WA ID</th>
              <th>Client</th>
              <th>Stage</th>
              <th>Criteria</th>
              <th>Selected</th>
              <th>Active?</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.wa_id}>
                <td>
                  <Link href={`/conversations/${encodeURIComponent(r.wa_id)}`}>{r.wa_id}</Link>
                </td>
                <td>{r.client_name ?? '—'}</td>
                <td>
                  <span className="badge stage">{r.current_stage}</span>
                </td>
                <td className="muted">
                  {Object.entries(r.search_criteria ?? {})
                    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
                    .join(', ')}
                </td>
                <td>{r.selected_finca ?? '—'}</td>
                <td>{r.agente_activo ? '✓' : '✗ (HITL)'}</td>
                <td className="muted">{new Date(r.updated_at).toLocaleString()}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No conversations yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
