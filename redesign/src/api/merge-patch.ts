// JSON Merge Patch (RFC 7396) — generate + apply. The spec is tiny and exactly defined; we
// implement it faithfully (and test against the RFC's own examples) rather than take a
// dependency. `apply` is the RFC's MergePatch pseudocode verbatim; `generate` is its inverse
// (the minimal patch P such that apply(before, P) deep-equals after).

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

function isObject(v: unknown): v is { [k: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** RFC 7396 §2 — apply `patch` to `target`, returning the result. */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch // non-object patch replaces wholesale (incl. arrays/null)
  const base: { [k: string]: Json } = isObject(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key]
    else base[key] = applyMergePatch(base[key], value) as Json
  }
  return base
}

/** The UI-protocol apply: RFC 7396, PLUS a null patch-value on an ABSENT key sets a literal null.
 *
 * RFC 7396 cannot express "set to null" — null means delete. Our state schema uses literal nulls
 * everywhere, so the client repairs the mismatch in two halves: `renullAfterPatch` restores keys
 * that existed pre-patch and vanished (value → null transitions), and THIS handles nulls inside a
 * NEWLY-introduced object (e.g. the first channel record, or the dmr slice at call start), which
 * renull can't see because the pre-patch state had no such subtree to walk. Deleting an absent key
 * is a no-op in the RFC, and our generator never emits one deliberately, so treating it as a
 * literal null loses nothing — it recovers exactly the nulls `generateMergePatch` put in the patch
 * verbatim for a brand-new subtree. Without this, every strict `!== null` check in the frontend
 * sees `undefined` where the schema promises `null`. */
export function applyStatePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch
  const base: { [k: string]: Json } = isObject(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      if (key in base) delete base[key] // RFC deletion (renullAfterPatch restores schema fields)
      else base[key] = null // literal null inside a newly-introduced object
    } else {
      base[key] = applyStatePatch(base[key], value) as Json
    }
  }
  return base
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  }
  if (isObject(a) && isObject(b)) {
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    return ak.length === bk.length && ak.every((k) => k in b && deepEqual(a[k], b[k]))
  }
  return false
}

/** The minimal RFC 7396 patch P such that applyMergePatch(before, P) deep-equals after.
 * For two objects this is a recursive diff (changed → new value, removed → null, equal →
 * omitted); otherwise the whole `after` value replaces. Returns `{}` when nothing changed. */
export function generateMergePatch(before: unknown, after: unknown): unknown {
  if (!isObject(before) || !isObject(after)) return after
  const patch: { [k: string]: Json } = {}
  for (const [key, value] of Object.entries(after)) {
    if (!(key in before)) patch[key] = value
    else if (!deepEqual(before[key], value)) patch[key] = generateMergePatch(before[key], value) as Json
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) patch[key] = null
  }
  return patch
}

export function isEmptyPatch(patch: unknown): boolean {
  return isObject(patch) && Object.keys(patch).length === 0
}

/** The AppState paths where a patch deletion is the INTENDED meaning (record maps whose keys come
 * and go: settings + per-side pending overlays) — everywhere else a deleted key is a value→null
 * transition to restore (see renullAfterPatch). ONE canonical list, shared by the real client
 * (useRadio.ts) and the integration mirror client, so they cannot drift: a new record-map field
 * added to AppState must be added HERE or the mirror test fails the moment a key is deleted. */
export const APP_STATE_RENULL_SKIP_PATHS: readonly string[] = [
  '/radio/settings',
  '/radio/pendingSettings',
  '/radio/sides/a/pendingChannel',
  '/radio/sides/b/pendingChannel',
]

/**
 * Restore fixed schema fields that an RFC 7396 patch deleted, as literal nulls. The RFC cannot
 * express "set to null" (null means delete), so a server field going value → null arrives as a
 * deletion and the applied state ends up with the key MISSING — `undefined` where the schema says
 * `null`. This walks the pre-patch state and re-adds any key that vanished. Keys under `skipPaths`
 * (record types like settings/pendingSettings, where deletion is the intended meaning) are left
 * deleted. Mutates + returns `next` (applyMergePatch already copied every patched object).
 */
export function renullAfterPatch(prev: unknown, next: unknown, skipPaths: readonly string[], path = ''): unknown {
  if (!isObject(prev) || !isObject(next) || skipPaths.includes(path)) return next
  for (const key of Object.keys(prev)) {
    if (!(key in next)) next[key] = null
    else next[key] = renullAfterPatch(prev[key], next[key], skipPaths, `${path}/${key}`) as Json
  }
  return next
}
