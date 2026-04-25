import Link from 'next/link';
import { get } from '@/lib/api';

interface Trace {
  id: string;
  conversation_id: string;
  stage_before: string | null;
  stage_after: string | null;
  intent: string | null;
  outbound_count: number;
  status: 'ok' | 'silent' | 'fallback' | 'error';
  silence_reason: string | null;
  duration_ms: number | null;
  created_at: string;
}

export const dynamic = 'force-dynamic';

export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const path = status ? `/traces?status=${encodeURIComponent(status)}&limit=200` : '/traces?limit=200';
  const traces = await get<Trace[]>(path);
  return (
    <div>
      <h1>Traces</h1>
      <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
        {['', 'ok', 'silent', 'fallback', 'error'].map((s) => (
          <Link
            key={s || 'all'}
            href={s ? `/traces?status=${s}` : '/traces'}
            className="badge"
            style={{
              border: '1px solid var(--border)',
              background: status === s || (!s && !status) ? 'var(--accent)' : 'transparent',
              color: status === s || (!s && !status) ? 'white' : 'var(--text)',
              cursor: 'pointer',
            }}
          >
            {s || 'all'}
          </Link>
        ))}
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Conversation</th>
              <th>Stage in → out</th>
              <th>Intent</th>
              <th>Outbounds</th>
              <th>Status</th>
              <th>Duration</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <tr key={t.id}>
                <td className="muted">{new Date(t.created_at).toLocaleString()}</td>
                <td>
                  <Link href={`/conversations/${encodeURIComponent(t.conversation_id)}`}>
                    {t.conversation_id}
                  </Link>
                </td>
                <td>
                  {t.stage_before ?? '—'} → {t.stage_after ?? '?'}
                </td>
                <td>{t.intent ?? '—'}</td>
                <td>{t.outbound_count}</td>
                <td>
                  <span className={`badge ${t.status}`}>{t.status}</span>
                  {t.silence_reason && <span className="muted"> {t.silence_reason}</span>}
                </td>
                <td className="muted">{t.duration_ms ? `${t.duration_ms}ms` : '—'}</td>
                <td>
                  <Link href={`/traces/${t.id}`}>view</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
