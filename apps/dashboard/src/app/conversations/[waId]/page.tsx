import Link from 'next/link';
import { get } from '@/lib/api';

interface ConversationDetail {
  conversation: {
    wa_id: string;
    client_name: string | null;
    current_stage: string;
    search_criteria: Record<string, unknown>;
    shown_fincas: string[];
    selected_finca: string | null;
    reservation: Record<string, unknown>;
    agente_activo: boolean;
    hitl_reason: string | null;
  };
  messages: Array<{
    id: string;
    direction: 'inbound' | 'outbound';
    message_type: string;
    content: string | null;
    transcription_status: string | null;
    state_at_time: string | null;
    created_at: string;
  }>;
  traces: Array<{
    id: string;
    stage_before: string | null;
    stage_after: string | null;
    intent: string | null;
    outbound_count: number;
    status: 'ok' | 'silent' | 'fallback' | 'error';
    silence_reason: string | null;
    duration_ms: number | null;
    created_at: string;
  }>;
}

export const dynamic = 'force-dynamic';

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ waId: string }>;
}) {
  const { waId } = await params;
  const data = await get<ConversationDetail>(`/conversations/${encodeURIComponent(waId)}`);
  const conv = data.conversation;
  return (
    <div>
      <h1>
        <Link href="/conversations">←</Link> {conv.client_name ?? conv.wa_id}{' '}
        <span className="badge stage">{conv.current_stage}</span>
      </h1>

      <div className="grid grid-2">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Context</h2>
          <div className="muted" style={{ marginBottom: 6 }}>WA ID</div>
          <div>{conv.wa_id}</div>
          <div className="muted" style={{ marginTop: 12, marginBottom: 6 }}>Stage</div>
          <div>{conv.current_stage} {!conv.agente_activo && <span className="badge silent">bot off</span>}</div>
          <div className="muted" style={{ marginTop: 12, marginBottom: 6 }}>Search criteria</div>
          <pre>{JSON.stringify(conv.search_criteria, null, 2)}</pre>
          <div className="muted" style={{ marginTop: 12, marginBottom: 6 }}>Shown fincas</div>
          <div>{conv.shown_fincas?.join(', ') || '—'}</div>
          {conv.selected_finca && (
            <>
              <div className="muted" style={{ marginTop: 12, marginBottom: 6 }}>Selected</div>
              <div>{conv.selected_finca}</div>
            </>
          )}
          <div className="muted" style={{ marginTop: 12, marginBottom: 6 }}>Reservation</div>
          <pre>{JSON.stringify(conv.reservation ?? {}, null, 2)}</pre>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Messages</h2>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {data.messages.map((m) => (
              <div key={m.id} className={`message-bubble ${m.direction}`}>
                <div>
                  {m.message_type === 'AUDIO_UNTRANSCRIBED' && '🎙 (audio sin transcribir) '}
                  {m.transcription_status === 'empty' && '🎙 (transcripción vacía) '}
                  {m.content || <span className="muted">—</span>}
                </div>
                <span className="ts">
                  {new Date(m.created_at).toLocaleTimeString()} · {m.state_at_time ?? ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <h2>Traces</h2>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Stage in → out</th>
              <th>Intent</th>
              <th>Outbounds</th>
              <th>Status</th>
              <th>Duration</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.traces.map((t) => (
              <tr key={t.id}>
                <td className="muted">{new Date(t.created_at).toLocaleString()}</td>
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
