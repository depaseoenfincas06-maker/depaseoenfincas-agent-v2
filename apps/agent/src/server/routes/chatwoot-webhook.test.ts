/**
 * Regression tests for the Chatwoot webhook normalizer.
 *
 * The fixtures here come from real Chatwoot 4.x payloads captured via
 * webhook.site during deployment debugging on 2026-05-08. Earlier we shipped
 * a normalizer that assumed a flat top-level shape (message_type, source_id,
 * sender at root) and silently skipped every real event because Chatwoot
 * actually nests those fields inside `conversation.messages[]`. These tests
 * lock the corrected behavior in.
 */
import { describe, it, expect } from 'vitest';
import { __test_normalize as normalize, __test_schema as schema } from './chatwoot-webhook.js';

describe('chatwoot webhook normalizer', () => {
  it('extracts wa_id and content from a real Chatwoot message_created payload', () => {
    const payload = {
      account: { id: 1, name: 'chatwoot' },
      additional_attributes: {},
      content_attributes: {},
      content_type: 'text',
      content: 'prueba',
      conversation: {
        additional_attributes: {},
        can_reply: true,
        channel: 'Channel::Whatsapp',
        contact_inbox: {
          id: 4,
          contact_id: 2,
          inbox_id: 4,
          source_id: '573007750712',
          created_at: '2026-03-26T17:27:53.203Z',
          updated_at: '2026-03-26T17:27:53.203Z',
          hmac_verified: false,
          pubsub_token: 'CiGSvFhR7KQKt1hQiYGh7ViC',
        },
        id: 40,
        inbox_id: 4,
        messages: [
          {
            id: 7008,
            content: 'prueba',
            account_id: 1,
            inbox_id: 4,
            conversation_id: 40,
            message_type: 0,
            created_at: 1778214072,
            updated_at: '2026-05-08T04:21:12.811Z',
            private: false,
            status: 'sent',
            source_id: 'wamid.HBgMNTczMDA3NzUwNzEyFQIAEhgUM0JBNkQyRjc2QjUzOTk5RDlBQjkA',
            content_type: 'text',
            content_attributes: {},
            sender_type: 'Contact',
            sender_id: 2,
            external_source_ids: {},
          },
        ],
      },
    };
    const parsed = schema.parse(payload);
    const result = normalize(parsed);
    expect('skip' in result).toBe(false);
    if ('skip' in result) return;
    expect(result.conversationId).toBe('573007750712');
    expect(result.text).toBe('prueba');
    expect(result.externalMessageId).toBe(
      'wamid.HBgMNTczMDA3NzUwNzEyFQIAEhgUM0JBNkQyRjc2QjUzOTk5RDlBQjkA',
    );
    expect(result.chatwootMessageId).toBe('7008');
    expect(result.chatwootConversationId).toBe(40);
  });

  it('skips outgoing messages (agent replies) where sender_type is User', () => {
    const payload = {
      content: 'agent reply',
      conversation: {
        id: 40,
        contact_inbox: { source_id: '573007750712' },
        messages: [
          {
            id: 7009,
            content: 'agent reply',
            message_type: 1,
            sender_type: 'User',
            private: false,
          },
        ],
      },
    };
    const parsed = schema.parse(payload);
    const result = normalize(parsed);
    expect('skip' in result).toBe(true);
  });

  it('skips private notes (internal team messages)', () => {
    const payload = {
      content: 'internal note',
      conversation: {
        id: 40,
        contact_inbox: { source_id: '573007750712' },
        messages: [
          {
            id: 7010,
            content: 'internal note',
            message_type: 0,
            sender_type: 'User',
            private: true,
          },
        ],
      },
    };
    const parsed = schema.parse(payload);
    const result = normalize(parsed);
    expect('skip' in result).toBe(true);
  });

  it('falls back to legacy top-level shape when conversation.messages is empty', () => {
    const payload = {
      content: 'legacy test',
      message_type: 0,
      source_id: 'wamid.legacy',
      sender: { identifier: '573001112222', name: 'Legacy User' },
      conversation: { id: 99 },
    };
    const parsed = schema.parse(payload);
    const result = normalize(parsed);
    expect('skip' in result).toBe(false);
    if ('skip' in result) return;
    expect(result.conversationId).toBe('573001112222');
    expect(result.externalMessageId).toBe('wamid.legacy');
  });

  it('skips when wa_id cannot be resolved from any source', () => {
    const payload = {
      content: 'no sender',
      conversation: {
        id: 1,
        messages: [{ id: 1, content: 'hi', message_type: 0, sender_type: 'Contact' }],
      },
    };
    const parsed = schema.parse(payload);
    const result = normalize(parsed);
    expect('skip' in result).toBe(true);
  });

  it('matches the triggering message by content when there are multiple in history', () => {
    const payload = {
      content: 'latest message',
      conversation: {
        id: 40,
        contact_inbox: { source_id: '573007750712' },
        messages: [
          { id: 100, content: 'old hi', message_type: 0, sender_type: 'Contact', source_id: 'wamid.OLD' },
          { id: 101, content: 'agent reply', message_type: 1, sender_type: 'User' },
          { id: 102, content: 'latest message', message_type: 0, sender_type: 'Contact', source_id: 'wamid.LATEST' },
        ],
      },
    };
    const parsed = schema.parse(payload);
    const result = normalize(parsed);
    expect('skip' in result).toBe(false);
    if ('skip' in result) return;
    expect(result.text).toBe('latest message');
    expect(result.externalMessageId).toBe('wamid.LATEST');
    expect(result.chatwootMessageId).toBe('102');
  });
});
