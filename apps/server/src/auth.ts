import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Role } from '@tandem/protocol';
import type { Identity } from '@tandem/room';
import type { DocMeta } from './store.ts';

/** 128-bit random token, URL-safe. */
export function newToken(): string {
  return randomBytes(16).toString('base64url');
}

export function newDocId(): string {
  return randomBytes(9).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** The role a share-link token grants on `doc`, or null. */
export function roleForToken(doc: DocMeta, token: string): Role | null {
  const h = hashToken(token);
  if (safeEqualHex(h, doc.editTokenHash)) return 'edit';
  if (safeEqualHex(h, doc.viewTokenHash)) return 'view';
  return null;
}

/** Client ids plus an HMAC that lets a reconnecting tab keep its id. */
export function hmacIdentity(secret: string): Identity {
  const sign = (docId: string, clientId: string) =>
    createHmac('sha256', secret).update(`${docId}:${clientId}`).digest('base64url');
  return {
    newClientId: () => randomBytes(6).toString('base64url'),
    sign,
    verify(docId, clientId, sig) {
      const expected = Buffer.from(sign(docId, clientId));
      const given = Buffer.from(sig);
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
  };
}
