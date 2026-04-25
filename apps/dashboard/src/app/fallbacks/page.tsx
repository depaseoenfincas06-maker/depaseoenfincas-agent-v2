import Link from 'next/link';
import { get } from '@/lib/api';

interface FallbackEvent {
  id: string;
  conversation_id: string;
  trace_id: string | null;
  reason: string;
  context: Record<string, unknown> | null;
  created_at: string;
}

export const dynamic = 'force-dynamic';

export default async function FallbacksPage() {
  const events = await get<FallbackEvent[]>('/fallback-events?limit=200');
  return (
    <div>
      <h1>Fallback events</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Times the always-respond invariant kicked in. Spikes here = the agent is having
        trouble with something. Click the trace to see exactly what happened.
      </p>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Conversation</th>
              <th>Reason</th>
              <th>Context</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="muted">{new Date(e.created_at).toLocaleString()}</td>
                <td>
                  <Link href={`/conversations/${encodeURIComponent(e.conversation_id)}`}>
                    {e.conversation_id}
                  </Link>
                </td>
                <td>
                  <span className="badge fallback">{e.reason}</span>
                </td>
                <td className="muted">
                  <pre style={{ margin: 0, fontSize: 11 }}>
                    {JSON.stringify(e.context, null, 0)?.slice(0, 200) ?? ''}
                  </pre>
                </td>
                <td>{e.trace_id && <Link href={`/traces/${e.trace_id}`}>trace</Link>}</td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No fallback events. Healthy 🌱
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
