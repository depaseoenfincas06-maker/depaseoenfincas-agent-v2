import TranscribeForm from './TranscribeForm';

export const dynamic = 'force-dynamic';

export default function TranscribeTestPage() {
  return (
    <div>
      <h1>Transcribe test</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Sube un audio o pega una URL para probar el pipeline de transcripción end-to-end.
        Útil para validar que un audio que falló en producción transcribe bien después de un
        ajuste, o para verificar antes de un deploy.
      </p>
      <TranscribeForm />
    </div>
  );
}
