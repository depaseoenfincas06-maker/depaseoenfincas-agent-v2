'use client';

import { useState } from 'react';

interface Attempt {
  model: string;
  text: string;
  ok: boolean;
  latencyMs: number;
  errorMessage?: string;
}

interface Result {
  ok: boolean;
  status: 'ok' | 'empty' | 'failed';
  text: string;
  reason?: string;
  attempts: Attempt[];
  input: { mimeType: string; filename: string; bytes: number; durationSec: number | null };
  domainPrompt: string;
  latencyMs: number;
}

const AGENT_PATH = '/api/agent/admin/transcribe-test';

export default function TranscribeForm() {
  const [mode, setMode] = useState<'file' | 'url'>('file');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      let res: Response;
      if (mode === 'file') {
        if (!file) {
          setErr('Selecciona un archivo de audio primero');
          setRunning(false);
          return;
        }
        const fd = new FormData();
        fd.append('file', file, file.name);
        res = await fetch(AGENT_PATH, { method: 'POST', body: fd });
      } else {
        if (!url) {
          setErr('Pega una URL');
          setRunning(false);
          return;
        }
        res = await fetch(AGENT_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
      }
      if (!res.ok) {
        const text = await res.text();
        setErr(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        return;
      }
      const data = (await res.json()) as Result;
      setResult(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Input</h2>
        <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="radio"
              checked={mode === 'file'}
              onChange={() => setMode('file')}
              style={{ width: 'auto' }}
            />
            Subir archivo
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="radio"
              checked={mode === 'url'}
              onChange={() => setMode('url')}
              style={{ width: 'auto' }}
            />
            URL pública
          </label>
        </div>
        {mode === 'file' ? (
          <input
            type="file"
            accept="audio/*,video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        ) : (
          <input
            type="text"
            placeholder="https://ejemplo.com/audio.ogg"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
        <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
          <button onClick={run} disabled={running}>
            {running ? 'Transcribiendo…' : 'Transcribir'}
          </button>
          {err && <span style={{ color: 'var(--error)' }}>{err}</span>}
        </div>
      </div>

      {result && (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Resultado</h2>
            <div className="grid grid-3">
              <div>
                <div className="muted">Status</div>
                <div>
                  <span className={`badge ${result.status === 'ok' ? 'ok' : result.status === 'empty' ? 'silent' : 'error'}`}>
                    {result.status}
                  </span>
                </div>
              </div>
              <div>
                <div className="muted">Duración</div>
                <div>{result.latencyMs}ms</div>
              </div>
              <div>
                <div className="muted">Bytes / mime</div>
                <div className="muted">
                  {result.input.bytes.toLocaleString()} · {result.input.mimeType}
                </div>
              </div>
            </div>
            {result.reason && (
              <>
                <div className="muted" style={{ marginTop: 12 }}>Reason</div>
                <div>{result.reason}</div>
              </>
            )}
            <div className="muted" style={{ marginTop: 12 }}>Texto transcrito</div>
            <pre>{result.text || '(vacío)'}</pre>
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>Intentos por modelo ({result.attempts.length})</h2>
            <table>
              <thead>
                <tr>
                  <th>Modelo</th>
                  <th>OK?</th>
                  <th>Latency</th>
                  <th>Texto</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {result.attempts.map((a, i) => (
                  <tr key={i}>
                    <td>{a.model}</td>
                    <td>
                      <span className={`badge ${a.ok ? 'ok' : 'error'}`}>{a.ok ? 'ok' : 'no'}</span>
                    </td>
                    <td className="muted">{a.latencyMs}ms</td>
                    <td>
                      <pre style={{ margin: 0, fontSize: 11, maxWidth: 360 }}>{a.text || '(vacío)'}</pre>
                    </td>
                    <td className="muted">{a.errorMessage ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>Domain prompt</h2>
            <pre>{result.domainPrompt}</pre>
          </div>
        </>
      )}
    </div>
  );
}
