// main.ts is mend, the CLI SPEC.md specifies. It reads an edit an AI model wrote in any of four formats (a unified
// diff, SEARCH/REPLACE blocks, a V4A patch, text-editor tool calls as JSON) and applies it to the tree in the
// working directory: every file is changed or nothing is. Lines an edit names are matched at three tiers (exact,
// trailing-whitespace-insensitive, fully whitespace-insensitive) unless --strict is given. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines: its own line break, its lines, and whether it ends with a break (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** One body line of a hunk or chunk: a context line (in O and N), an old line (O only) or a new line (N only). */
interface Tagged {
  text: string;
  kind: 'ctx' | 'old' | 'new';
  fromEmpty?: boolean;
}

const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

/**
 * Every position at or after `from` where O occurs in `lines`, at the first tier (section 5) that has one.
 * With `mustEnd`, only occurrences that end at the file's last line count.
 */
function findTier(lines: string[], O: string[], strict: boolean, from = 0, mustEnd = false): { tier: number; positions: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions: number[] = [];
    for (let i = from; i + O.length <= lines.length; i++) {
      if (mustEnd && i + O.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!tierEq(lines[i + j]!, O[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first line at or after `from` equal to a single anchor line, at the first tier that has one (section 8). */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    for (let i = from; i < lines.length; i++) {
      if (tierEq(lines[i]!, anchor, tier)) return i;
    }
  }
  return -1;
}

/**
 * The lines that replace the matched ones (section 5): a context line of N is written as the file's own matched
 * line; at tier 2 every other line of N is re-indented from O's first line's indent to the file's.
 */
function replacement(lines: string[], pos: number, O: Tagged[], N: Tagged[], tier: number): string[] {
  const ctxLines: string[] = [];
  O.forEach((o, idx) => {
    if (o.kind === 'ctx') ctxLines.push(lines[pos + idx]!);
  });
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = /^[ \t]*/.exec(lines[pos]!)![0];
    P = /^[ \t]*/.exec(O[0]!.text)![0];
  }
  const out: string[] = [];
  let ci = 0;
  for (const n of N) {
    if (n.kind === 'ctx') {
      out.push(ctxLines[ci++]!);
    } else if (tier === 2 && n.text.trim() !== '' && n.text.startsWith(P)) {
      out.push(F + n.text.slice(P.length));
    } else {
      out.push(n.text);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified hunk (section 6): its body's lines, the A of its header, and its end-of-file break rule. */
interface Hunk {
  A: number;
  body: (Tagged | { kind: 'bs' })[];
  backslashAfter: boolean;
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  oldPath?: string | null;
  newPath?: string | null;
  hasPair: boolean;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names (section 6): up to the first tab, spaces removed, `a/` or `b/` removed. */
function headerPath(s: string): string | null {
  const t = s.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

/** Apply a section's hunks in order to a file's lines (section 6), or throw the failing hunk's code. */
function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const O = h.body.filter((b): b is Tagged => b.kind === 'ctx' || b.kind === 'old');
    const N = h.body.filter((b): b is Tagged => b.kind === 'ctx' || b.kind === 'new');
    if (O.length === 0) {
      let at = h.A + d;
      if (at > f.lines.length) at = f.lines.length;
      if (at < 0) at = 0;
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...N.map((n) => n.text));
      if (atEnd) f.final = !h.backslashAfter;
    } else {
      const found = findTier(f.lines, O.map((o) => o.text), strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let pos = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const out = replacement(f.lines, pos, O, N, found.tier);
      const atEnd = pos + O.length === f.lines.length;
      f.lines.splice(pos, O.length, ...out);
      if (atEnd) f.final = !h.backslashAfter;
    }
    d += N.length - O.length;
  }
}

/** One unified section as an edit (section 6). */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP: string | null | undefined = sec.hasPair ? sec.oldPath : sec.renameFrom ?? sec.gitOld;
    const newP: string | null | undefined = sec.hasPair ? sec.newPath : sec.renameTo ?? sec.gitNew;
    const creation = sec.newFile || oldP === null;
    const deletion = sec.delFile || newP === null;
    if (creation && newP != null) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const texts: string[] = [];
      let lastNew = -1;
      let flat = 0;
      let bsAfter = false;
      for (const h of sec.hunks) {
        h.body.forEach((b, j) => {
          if (b.kind === 'new') {
            texts.push(b.text);
            lastNew = flat + j;
          }
        });
        flat += h.body.length;
      }
      if (lastNew >= 0) {
        let k = 0;
        outer: for (const h of sec.hunks) {
          for (let j = 0; j < h.body.length; j++, k++) {
            if (k === lastNew) {
              bsAfter = h.body[j + 1]?.kind === 'bs';
              break outer;
            }
          }
        }
      }
      tree.now.set(newP, texts.length === 0 ? '' : texts.join('\n') + (bsAfter ? '' : '\n'));
      return;
    }
    if (deletion && oldP != null) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP == null || newP == null) return;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const content = tree.get(oldP);
    if (content === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const f = splitFile(content);
    applyHunks(f, sec.hunks, strict, oldP);
    const text = joinFile(f);
    if (oldP !== newP) {
      tree.now.set(newP, text);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const isPairStart = (idx: number): boolean => lines[idx]!.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ');
  const newSection = (): Section => {
    const s: Section = { hasPair: false, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (isPairStart(i)) {
      if (cur === null || cur.hunks.length > 0 || cur.hasPair) cur = newSection();
      cur.oldPath = headerPath(line.slice(4));
      cur.newPath = headerPath(lines[i + 1]!.slice(4));
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      const body: (Tagged | { kind: 'bs' })[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ') || isPairStart(i)) break;
        const c = bl[0];
        if (bl === '') body.push({ text: '', kind: 'ctx', fromEmpty: true });
        else if (c === ' ') body.push({ text: bl.slice(1), kind: 'ctx' });
        else if (c === '-') body.push({ text: bl.slice(1), kind: 'old' });
        else if (c === '+') body.push({ text: bl.slice(1), kind: 'new' });
        else if (c === '\\') body.push({ kind: 'bs' });
        else break;
        i += 1;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === 'ctx' && last.fromEmpty) body.pop();
        else break;
      }
      let lastCtxNew = -1;
      body.forEach((b, j) => {
        if (b.kind === 'ctx' || b.kind === 'new') lastCtxNew = j;
      });
      cur.hunks.push({ A: parseInt(m[1]!, 10), body, backslashAfter: lastCtxNew >= 0 && body[lastCtxNew + 1]?.kind === 'bs' });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One SEARCH/REPLACE block as an edit (section 7). */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    const f = splitFile(content);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const O: Tagged[] = oldLines.map((t) => ({ text: t, kind: 'old' }));
    const N: Tagged[] = newLines.map((t) => ({ text: t, kind: 'new' }));
    const out = replacement(f.lines, pos, O, N, found.tier);
    f.lines.splice(pos, oldLines.length, ...out);
    tree.now.set(path, joinFile(f));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let eq = -1;
    for (let j = at + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    let path: string | null = null;
    for (let j = at - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${at + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(at + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** One chunk of a V4A Update File section (section 8). */
interface Chunk {
  anchor: string | null;
  body: Tagged[];
  eof: boolean;
}

/** One V4A Update File section as an edit (section 8). */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(content);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(f.lines, chunk.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const O = chunk.body.filter((b) => b.kind !== 'new');
      const N = chunk.body.filter((b) => b.kind !== 'old');
      if (O.length === 0) {
        const at = chunk.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(at, 0, ...N.map((n) => n.text));
        cursor = at + N.length;
      } else {
        const found = findTier(f.lines, O.map((o) => o.text), strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0]!;
        const out = replacement(f.lines, pos, O, N, found.tier);
        f.lines.splice(pos, O.length, ...out);
        cursor = pos + out.length;
      }
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      lastNB = j;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secKind = (l: string): 'add' | 'del' | 'upd' | null =>
    l.startsWith('*** Add File:') ? 'add' : l.startsWith('*** Delete File:') ? 'del' : l.startsWith('*** Update File:') ? 'upd' : null;
  const edits: Edit[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = secKind(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(line.indexOf(':') + 1).trim();
    const secLine = i + 1;
    i += 1;
    if (kind === 'add') {
      const content: string[] = [];
      while (i < lastNB && secKind(lines[i]!) === null) {
        const l = lines[i]!;
        if (l.startsWith('+')) content.push(l.slice(1));
        else if (l === '') content.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      const texts = content;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, texts.length === 0 ? '' : texts.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      while (i < lastNB && secKind(lines[i]!) === null) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let sawAny = false;
      while (i < lastNB && secKind(lines[i]!) === null) {
        const l = lines[i]!;
        if (l.startsWith('*** Move to:') && !sawAny && cur === null) {
          moveTo = l.slice('*** Move to:'.length).trim();
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim() || null, body: [], eof: false };
          chunks.push(cur);
          sawAny = true;
          i += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.eof = true;
          sawAny = true;
          i += 1;
          continue;
        }
        if (l.startsWith('***')) throw new Exit2(`error: parse ${i + 1}`);
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          sawAny = true;
          cur.body.push(
            l === ''
              ? { text: '', kind: 'ctx', fromEmpty: true }
              : { text: l.slice(1), kind: l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new', fromEmpty: l.trim() === '' },
          );
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) {
        while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.fromEmpty) cur.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const covered = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [o, n] of tree.moves) {
    const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
    if (tree.original(o) !== null && finalOf(o) === null && tree.original(n) === null && finalOf(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      covered.add(o);
      covered.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
