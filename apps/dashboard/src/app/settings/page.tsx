import { get } from '@/lib/api';
import SettingsForm, { type Settings } from './SettingsForm';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const settings = await get<Settings>('/settings');
  return <SettingsForm initial={settings} />;
}
