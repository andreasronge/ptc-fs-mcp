/**
 * Opaque pagination cursors that fail rather than tear.
 *
 * Reading live bytes means the filesystem can change between two pages of one
 * traversal. A cursor therefore carries a digest of the state it was issued
 * against; on resume that state is recomputed and compared. A mismatch ends
 * the traversal with an actionable error. Silently returning a torn page --
 * half from the old tree, half from the new -- is the one outcome worth
 * spending an error on.
 *
 * Cursors are also signed, so a client cannot forge a position, replay a
 * cursor into another traversal, or hand back an edited string.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { ToolError } from './errors.js'

const MAX_CURSOR_LENGTH = 4_096

/**
 * A key for this process only. Cursors do not survive a restart, which is the
 * honest lifetime for a position into a filesystem this process is watching.
 */
const KEY = randomBytes(32)

/** Identifies the traversal a cursor belongs to: the tool and its arguments. */
export function scopeOf(tool: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(tool).update('\0').update(JSON.stringify(args)).digest('hex')
}

/** Digests an observation of the filesystem state a traversal depends on. */
export function stateOf(parts: Iterable<string>): string {
  const digest = createHash('sha256')
  for (const part of parts) digest.update(part, 'utf8').update('\0')
  return digest.digest('hex')
}

function sign(payload: string): Buffer {
  return Buffer.from(createHmac('sha256', KEY).update(payload, 'ascii').digest('base64url'), 'ascii')
}

export function encodeCursor(scope: string, state: string, position: unknown): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, s: scope, t: state, p: position }), 'utf8').toString('base64url')
  return `${payload}.${sign(payload).toString('ascii')}`
}

/**
 * Verifies a cursor and returns its position, or `first` when none was given.
 *
 * @param validPosition Narrows the decoded position to the shape this tool
 *   issued. A position that does not match is a forged or stale cursor, not a
 *   value to coerce.
 */
export function decodeCursor<T>(
  scope: string,
  state: string,
  cursor: unknown,
  validPosition: (position: unknown) => position is T,
  first: T,
): T {
  if (cursor === undefined) return first
  if (typeof cursor !== 'string' || cursor === '' || cursor.length > MAX_CURSOR_LENGTH) {
    throw new ToolError('cursor is not valid')
  }

  const parts = cursor.split('.')
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new ToolError('cursor is not valid')
  }
  const [payload, encodedSignature] = parts as [string, string]

  // Compare the encoded signatures, not the decoded bytes. The trailing bits
  // of a base64url digest are not significant, so several spellings decode to
  // the same 32 bytes; comparing decoded buffers would admit cursor strings
  // this server never issued.
  const signature = Buffer.from(encodedSignature, 'ascii')
  const expected = sign(payload)
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    throw new ToolError('cursor is not valid')
  }

  let decoded: Record<string, unknown>
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    throw new ToolError('cursor is not valid')
  }

  if (decoded.v !== 1 || Object.keys(decoded).sort().join(',') !== 'p,s,t,v') {
    throw new ToolError('cursor is not valid')
  }
  if (decoded.s !== scope) throw new ToolError('cursor was issued for a different traversal')
  if (decoded.t !== state) {
    throw new ToolError('the filesystem changed since this cursor was issued; start the traversal again')
  }
  if (!validPosition(decoded.p)) throw new ToolError('cursor is not valid')
  return decoded.p
}
