import type * as Y from 'yjs'

export function keepReplacedMaps(doc: Y.Doc): void
export function mergeConcurrentCreations(doc: Y.Doc, hooks?: { onMerge?: (kind: 'create' | 'late-write') => void }): void
