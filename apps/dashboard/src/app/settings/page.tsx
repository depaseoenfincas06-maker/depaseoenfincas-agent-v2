import { get } from '@/lib/api';
import SettingsForm from './SettingsForm';

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

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const settings = await get<Settings>('/settings');
  return (
    <div>
      <h1>Settings</h1>
      <SettingsForm initial={settings} />
    </div>
  );
}
