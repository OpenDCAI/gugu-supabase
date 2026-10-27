import type * as Y from 'yjs'

export function isJson(contentType: string | null | undefined): boolean
export class InvalidJson extends Error {
  reason: 'invalid-json'
}
export function isTextMark(v: unknown): v is { $text: string }
export function withoutMarks(v: unknown): unknown
export function utf8Length(s: string): number
export function parseJsonObject(text: string): Record<string, unknown>
export function buildDoc(contentType: string, text: string | null): Y.Doc
export function readText(doc: Y.Doc, contentType: string, options?: { pretty?: boolean }): string
export function readFileText(doc: Y.Doc, contentType: string): string
export function applyJson(ymap: Y.Map<unknown>, obj: Record<string, unknown>): void
export function spliceText(ytext: Y.Text, next: string): void
export function rebuildDoc(source: Y.Doc, contentType: string): Y.Doc
export function sameContent(contentType: string, a: string, b: string): boolean
export function applyEdit(
  doc: Y.Doc,
  contentType: string,
  oldText: string,
  newText: string,
  maxBytes: number,
): { status: number; body: Record<string, unknown> }
