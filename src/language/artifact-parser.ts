import type { SourceRange } from "../domain/diagram/ast";
import type { Diagnostic, DiagnosticSeverity } from "./diagnostics/diagnostics";

export interface SourceLine { text: string; line: number; range: SourceRange }

export function sourceLines(source: string): SourceLine[] {
  return source.replace(/\r\n?/g, "\n").split("\n").map((text, line) => ({
    text, line, range: { start: { line, column: 0 }, end: { line, column: text.length } },
  }));
}

export function diagnostic(code: string, message: string, range: SourceRange, severity: DiagnosticSeverity = "error"): Diagnostic {
  return { code: code as Diagnostic["code"], message, range, severity };
}

/** Tokenize one declarative line; `{...}` is an opaque, possibly nested value. */
export function tokensOf(text: string): string[] | null {
  const tokens: string[] = [];
  for (let i = 0; i < text.length;) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text[i] === "#") break;
    if (text[i] === '"') {
      let value = ""; i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") {
          i++; if (i >= text.length) return null;
          const escaped: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };
          value += escaped[text[i]] ?? text[i]; i++;
        } else value += text[i++];
      }
      if (text[i] !== '"') return null;
      i++; tokens.push(value); continue;
    }
    if (text[i] === "{") {
      let depth = 1, value = ""; i++;
      while (i < text.length && depth) {
        const char = text[i++];
        if (char === "{") depth++;
        else if (char === "}") { if (--depth === 0) break; }
        if (depth) value += char;
      }
      if (depth) return null;
      tokens.push(value); continue;
    }
    if (text.startsWith("->", i)) { tokens.push("->"); i += 2; continue; }
    if (text.startsWith("--", i)) { tokens.push("--"); i += 2; continue; }
    if (text[i] === "(" || text[i] === ")" || text[i] === ",") { tokens.push(text[i++]); continue; }
    const start = i;
    while (i < text.length && !/\s|[(),{}#"]/.test(text[i]) && !text.startsWith("->", i) && !text.startsWith("--", i)) i++;
    if (start === i) return null;
    tokens.push(text.slice(start, i));
  }
  return tokens;
}

export const validId = (id: string): boolean => /^[a-z][a-z0-9_-]*$/.test(id);

export function idError(id: string): string | null {
  return validId(id) ? null : `Invalid identifier "${id}"; use [a-z][a-z0-9_-]*.`;
}
