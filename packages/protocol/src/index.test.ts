import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { LIMITS, PROTOCOL_VERSION, encode, parseClientMessage } from './index.ts';

describe('parseClientMessage', () => {
  it('accepts well-formed messages', () => {
    const hello = encode({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      docId: 'd1',
      token: 't',
      name: 'Ada',
    });
    expect(parseClientMessage(hello)).toMatchObject({ ok: true });
    const batch = encode({ type: 'batch', batchId: 1, ops: [{ t: 'delete', id: 'c:1' }] });
    expect(parseClientMessage(batch)).toMatchObject({ ok: true });
  });

  it('rejects malformed messages', () => {
    for (const raw of [
      'nope',
      '{}',
      '{"type":"batch","batchId":0,"ops":[{"t":"delete","id":"x"}]}',
      '{"type":"batch","batchId":1,"ops":[]}',
      '{"type":"presence","chat":"' + 'x'.repeat(LIMITS.chat + 1) + '"}',
      'x'.repeat(LIMITS.messageBytes + 1),
    ]) {
      expect(parseClientMessage(raw).ok).toBe(false);
    }
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.json(),
          fc.jsonValue().map((v) => JSON.stringify(v)),
        ),
        (raw) => {
          parseClientMessage(raw);
        },
      ),
      { numRuns: 2000 },
    );
  });
});
