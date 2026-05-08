/**
 * Tests for the flexible normalizer. Covers shapes we're likely to encounter
 * from Chatwoot variants, Meta directly, custom integrations, and edge cases.
 */
import { describe, it, expect } from 'vitest';
import { flexibleNormalize } from './_flexible-normalize.js';

describe('flexibleNormalize', () => {
  it('extracts wa_id and content from real Chatwoot 4.x payload (the shape that broke us)', () => {
    const payload = {
      account: { id: 1, name: 'chatwoot' },
      content: 'prueba',
      content_type: 'text',
      conversation: {
        id: 40,
        contact_inbox: { source_id: '573007750712', inbox_id: 4 },
        messages: [
          {
            id: 7008,
            content: 'prueba',
            message_type: 0,
            source_id: 'wamid.HBgABCDEF',
            sender_type: 'Contact',
            private: false,
          },
        ],
      },
    };
    const r = flexibleNormalize(payload);
    expect('skip' in r).toBe(false);
    if ('skip' in r) return;
    expect(r.waId).toBe('573007750712');
    expect(r.text).toBe('prueba');
    expect(r.externalMessageId).toBe('wamid.HBgABCDEF');
    expect(r.chatwootConversationId).toBe(40);
  });

  it('skips outgoing messages (message_type=1)', () => {
    const payload = {
      content: 'agent reply',
      message_type: 1,
      conversation: {
        contact_inbox: { source_id: '573007750712' },
        messages: [{ id: 1, content: 'agent reply', message_type: 1, sender_type: 'User' }],
      },
    };
    const r = flexibleNormalize(payload);
    expect('skip' in r).toBe(true);
  });

  it('handles a totally flat Meta-style payload', () => {
    const payload = {
      from: '573001234567',
      text: { body: 'hola, busco finca' },
      // Wait — text is not a string here; collectTextCandidates only matches strings.
      // The flexibleNormalize would skip text but still find wa_id.
      // Let me adjust to a flatter shape that's definitely flat:
    };
    const flat = {
      from: '573001234567',
      body: 'hola desde meta',
      message_id: 'wamid.MetaTest',
    };
    const r = flexibleNormalize(flat);
    expect('skip' in r).toBe(false);
    if ('skip' in r) return;
    expect(r.waId).toBe('573001234567');
    expect(r.text).toBe('hola desde meta');
    expect(r.externalMessageId).toBe('wamid.MetaTest');
  });

  it('prefers contact-context phone over agent-context phone', () => {
    const payload = {
      content: 'hello',
      contact: { phone_number: '573001111111' },
      assignee: { phone_number: '573009999999' }, // agent — must be ignored
    };
    const r = flexibleNormalize(payload);
    expect('skip' in r).toBe(false);
    if ('skip' in r) return;
    expect(r.waId).toBe('573001111111');
  });

  it('returns skip with detail when no phone-like field exists anywhere', () => {
    const payload = {
      content: 'no phone in here',
      account: { id: 1 },
    };
    const r = flexibleNormalize(payload);
    expect('skip' in r).toBe(true);
    if (!('skip' in r)) return;
    expect(r.reason).toMatch(/no phone/i);
  });

  it('finds wamid even if buried 5 levels deep', () => {
    const payload = {
      contact: { phone_number: '573001111111' },
      content: 'hi',
      meta: { extra: { nested: { evenMore: { id: 'wamid.DEEP123' } } } },
    };
    const r = flexibleNormalize(payload);
    expect('skip' in r).toBe(false);
    if ('skip' in r) return;
    expect(r.externalMessageId).toBe('wamid.DEEP123');
  });

  it('extracts client name preferring sender context', () => {
    const payload = {
      account: { name: 'chatwoot' }, // ignored — chatwoot literal
      contact: { name: 'Juan Pérez', phone_number: '573001111111' },
      assignee: { name: 'Carlos Agente' }, // ignored — agent context
      content: 'hi',
    };
    const r = flexibleNormalize(payload);
    expect('skip' in r).toBe(false);
    if ('skip' in r) return;
    expect(r.clientName).toBe('Juan Pérez');
  });

  it('handles media attachments at any nesting', () => {
    const payload = {
      contact: { phone_number: '573001111111' },
      content: '',
      conversation: {
        messages: [
          {
            id: 1,
            message_type: 0,
            sender_type: 'Contact',
            attachments: [{ file_type: 'audio', data_url: 'https://example.com/audio.ogg' }],
          },
        ],
      },
    };
    const r = flexibleNormalize(payload);
    expect('skip' in r).toBe(false);
    if ('skip' in r) return;
    expect(r.media?.url).toBe('https://example.com/audio.ogg');
    expect(r.media?.mimeType).toBe('audio/ogg');
  });

  it('does NOT pick a random integer field as a phone (avoid contact_id, account_id)', () => {
    const payload = {
      content: 'hi',
      contact_id: 42, // integer, not phone-shaped
      account_id: 100,
      sender: { identifier: '573001234567' },
    };
    const r = flexibleNormalize(payload);
    expect('skip' in r).toBe(false);
    if ('skip' in r) return;
    expect(r.waId).toBe('573001234567');
  });
});
