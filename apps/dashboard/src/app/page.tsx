import { get } from '@/lib/api';

interface Health {
  db: boolean;
  pendingInbox: number;
  fallbacks24h: number;
  silent24h: number;
  ts: string;
}

export const dynamic = 'force-dynamic';

export default async function HealthPage() {
  let h: Health | null = null;
  let err: string | null = null;
  try {
    h = await get<Health>('/health-detailed');
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  return (
    <div>
      <h1>Health</h1>
      {err && (
        <div className="card" style={{ color: 'var(--error)' }}>
          Failed to reach agent: {err}
          <div className="muted" style={{ marginTop: 8 }}>
            Make sure the agent is running on port 3200 (`pnpm agent:dev`).
          </div>
        </div>
      )}
      {h && (
        <div className="grid grid-3">
          <div className="stat">
            <div className="label">Database</div>
            <div className="value" style={{ color: h.db ? 'var(--ok)' : 'var(--error)' }}>
              {h.db ? 'OK' : 'DOWN'}
            </div>
          </div>
          <div className="stat">
            <div className="label">Inbox pending</div>
            <div className="value">{h.pendingInbox}</div>
          </div>
          <div className="stat">
            <div className="label">Fallbacks (24h)</div>
            <div
              className="value"
              style={{ color: h.fallbacks24h > 0 ? 'var(--warn)' : undefined }}
            >
              {h.fallbacks24h}
            </div>
          </div>
          <div className="stat">
            <div className="label">Silent traces (24h)</div>
            <div
              className="value"
              style={{ color: h.silent24h > 5 ? 'var(--warn)' : undefined }}
            >
              {h.silent24h}
            </div>
          </div>
          <div className="stat">
            <div className="label">Last check</div>
            <div className="value" style={{ fontSize: 14 }}>
              {new Date(h.ts).toLocaleString()}
            </div>
          </div>
        </div>
      )}
      <h2>What you should monitor</h2>
      <div className="card">
        <ul style={{ marginTop: 0, paddingLeft: 20 }}>
          <li>
            <strong>Fallbacks 24h ↑</strong> = the agent fell back to a generic message
            instead of a real answer. Click into Fallbacks to see why and which conversation.
          </li>
          <li>
            <strong>Silent traces 24h ↑</strong> = the agent decided not to respond. Some are
            valid (HITL active, duplicate). Investigate spikes.
          </li>
          <li>
            <strong>Inbox pending</strong> growing = workers stuck. Restart with{' '}
            <code>pnpm agent:worker</code>.
          </li>
        </ul>
      </div>
    </div>
  );
}
