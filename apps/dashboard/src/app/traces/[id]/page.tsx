import Link from 'next/link';
import { get } from '@/lib/api';

interface TraceDetail {
  trace: {
    id: string;
    conversation_id: string;
    stage_before: string | null;
    stage_after: string | null;
    intent: string | null;
    outbound_count: number;
    status: string;
    silence_reason: string | null;
    duration_ms: number | null;
    error_detail: Record<string, unknown> | null;
    created_at: string;
  };
  turns: Array<{
    id: string;
    stage: string;
    model: string;
    prompt: unknown;
    response: unknown;
    tools_called: unknown[];
    tokens_in: number | null;
    tokens_out: number | null;
    cost_usd: number | null;
    latency_ms: number | null;
    status: string;
    error_detail: unknown;
    created_at: string;
  }>;
}

export const dynamic = 'force-dynamic';

export default async function TraceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await get<TraceDetail>(`/traces/${id}`);
  const t = data.trace;
  return (
    <div>
      <h1>
        <Link href="/traces">←</Link> Trace {t.id.slice(0, 8)}…
      </h1>
      <div className="card">
        <div className="grid grid-3">
          <div>
            <div className="muted">Conversation</div>
            <Link href={`/conversations/${encodeURIComponent(t.conversation_id)}`}>
              {t.conversation_id}
            </Link>
          </div>
          <div>
            <div className="muted">Stage in → out</div>
            <div>
              {t.stage_before ?? '—'} → {t.stage_after ?? '?'}
            </div>
          </div>
          <div>
            <div className="muted">Status</div>
            <div>
              <span className={`badge ${t.status}`}>{t.status}</span>
              {t.silence_reason && <span className="muted"> · {t.silence_reason}</span>}
            </div>
          </div>
          <div>
            <div className="muted">Intent</div>
            <div>{t.intent ?? '—'}</div>
          </div>
          <div>
            <div className="muted">Outbounds</div>
            <div>{t.outbound_count}</div>
          </div>
          <div>
            <div className="muted">Duration</div>
            <div>{t.duration_ms ? `${t.duration_ms}ms` : '—'}</div>
          </div>
        </div>
        {t.error_detail && (
          <>
            <h2>Error</h2>
            <pre>{JSON.stringify(t.error_detail, null, 2)}</pre>
          </>
        )}
      </div>

      <h2>Agent turns ({data.turns.length})</h2>
      {data.turns.map((turn) => (
        <details key={turn.id} className="card" open>
          <summary style={{ cursor: 'pointer', listStyle: 'none' }}>
            <strong>{turn.stage}</strong>{' '}
            <span className="muted">
              {turn.model} · {turn.latency_ms ?? '?'}ms · {turn.tokens_in ?? '?'} in / {turn.tokens_out ?? '?'} out
              {turn.cost_usd ? ` · $${turn.cost_usd.toFixed(6)}` : ''}
            </span>{' '}
            <span className={`badge ${turn.status === 'ok' ? 'ok' : 'error'}`}>{turn.status}</span>
          </summary>
          <h3 style={{ marginTop: 12, fontSize: 13 }}>Prompt</h3>
          <pre>{JSON.stringify(turn.prompt, null, 2)}</pre>
          <h3 style={{ fontSize: 13 }}>Response</h3>
          <pre>{JSON.stringify(turn.response, null, 2)}</pre>
          {Array.isArray(turn.tools_called) && turn.tools_called.length > 0 && (
            <>
              <h3 style={{ fontSize: 13 }}>Tools</h3>
              <pre>{JSON.stringify(turn.tools_called, null, 2)}</pre>
            </>
          )}
          {turn.error_detail !== null && (
            <>
              <h3 style={{ fontSize: 13 }}>Error</h3>
              <pre>{JSON.stringify(turn.error_detail, null, 2)}</pre>
            </>
          )}
        </details>
      ))}
    </div>
  );
}
