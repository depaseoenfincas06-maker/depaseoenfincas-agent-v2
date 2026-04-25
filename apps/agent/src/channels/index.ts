import type { Channel } from '@depf/shared';
import type { ChannelAdapter } from './types.js';
import { simulatorChannel } from './simulator.js';
import { chatwootChannel } from './chatwoot.js';
import { whatsappChannel } from './whatsapp.js';

const map: Record<Channel, ChannelAdapter> = {
  simulator: simulatorChannel,
  chatwoot: chatwootChannel,
  whatsapp: whatsappChannel,
};

export function getChannel(channel: Channel): ChannelAdapter {
  const adapter = map[channel];
  if (!adapter) throw new Error(`No channel adapter for: ${channel}`);
  return adapter;
}

export { simulatorChannel, chatwootChannel, whatsappChannel };
export * from './types.js';
