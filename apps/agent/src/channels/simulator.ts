/**
 * In-memory channel for the dashboard simulator and integration tests.
 * Stores outbound messages in a buffer that the dashboard streams via SSE.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { OutboundMessage } from '@depf/shared';
import type { ChannelAdapter, SendResult } from './types.js';

interface BufferedMessage {
  id: string;
  conversationId: string;
  message: OutboundMessage;
  sentAt: string;
}

class SimulatorChannel extends EventEmitter implements ChannelAdapter {
  readonly channel = 'simulator' as const;
  private buffer = new Map<string, BufferedMessage[]>();

  async send(conversationId: string, message: OutboundMessage): Promise<SendResult> {
    const id = randomUUID();
    const entry: BufferedMessage = {
      id,
      conversationId,
      message,
      sentAt: new Date().toISOString(),
    };
    const list = this.buffer.get(conversationId) ?? [];
    list.push(entry);
    this.buffer.set(conversationId, list);
    this.emit('message', entry);
    return { externalMessageId: id, delivered: true };
  }

  async showTyping(): Promise<void> {
    this.emit('typing');
  }

  drain(conversationId: string): BufferedMessage[] {
    const list = this.buffer.get(conversationId) ?? [];
    this.buffer.delete(conversationId);
    return list;
  }

  peek(conversationId: string): BufferedMessage[] {
    return this.buffer.get(conversationId) ?? [];
  }
}

export const simulatorChannel = new SimulatorChannel();
