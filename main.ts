// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Reads a patch in unified diff, SEARCH/REPLACE, V4A or JSON form, finds each
// edit's old lines at the first of three matching tiers, and writes every
// change or none. Node 22, standard library alone; run as
// `node main.ts [options] [PATCH]` with the working directory as the root of
// a tree of text files. When MAKEFUN_ENV_URL is set, this file runs the trial
// itself: it fetches the checks, runs the CLI on each, and posts the results.

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Per-run context: strict matching, and the moves successful edits made. */
interface Ctx {
  strict: boolean;
  moves: Array<[string, string]>;
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

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

type Edit = (tree: Tree, ctx: Ctx) => void;

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

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3) and matching (section 5)
// ---------------------------------------------------------------------------

interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** A line of N: a context line (written as the file's own matched line) or a
 *  plain line. `oIdx` names the line of O the context line mirrors. */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

const norm = (line: string, tier: number): string => {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
};

function occurrences(fileLines: string[], o: string[], tier: number): number[] {
  const pos: number[] = [];
  if (o.length === 0) return pos;
  const on = o.map((l) => norm(l, tier));
  const fn = fileLines.map((l) => norm(l, tier));
  outer: for (let i = 0; i + o.length <= fn.length; i++) {
    for (let j = 0; j < o.length; j++) if (fn[i + j] !== on[j]) continue outer;
    pos.push(i);
  }
  return pos;
}

/** The first tier at which O occurs at least once, with its positions. */
function findFirstTier(fileLines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const p = occurrences(fileLines, o, t);
    if (p.length > 0) return { tier: t, pos: p };
  }
  return null;
}

const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** Replace the k matched lines at `at` with N. Context lines are written as
 *  the file's own matched lines; at tier 2 every other non-blank line of N
 *  that starts with O's first line's indent has that indent replaced by the
 *  file's first matched line's indent. */
function applyReplace(fileLines: string[], o: string[], n: NLine[], tier: number, at: number): string[] {
  const fLead = leadOf(fileLines[at] ?? '');
  const pLead = leadOf(o[0] ?? '');
  const out: string[] = [];
  for (const item of n) {
    if (item.ctx) out.push(fileLines[at + item.oIdx]!);
    else if (tier === 2 && item.text !== '' && item.text.trim() !== '' && item.text.startsWith(pLead)) {
      out.push(fLead + item.text.slice(pLead.length));
    } else out.push(item.text);
  }
  return [...fileLines.slice(0, at), ...out, ...fileLines.slice(at + o.length)];
}

/** Build O (old lines) and N (new lines with context marks) from a body of
 *  context / old / new lines, in body order. */
function splitBody(body: Array<{ kind: string; text: string }>): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oIdx: o.length - 1 });
    } else if (b.kind === '-') o.push(b.text);
    else if (b.kind === '+') n.push({ text: b.text, ctx: false, oIdx: -1 });
  }
  return { o, n };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one. */
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

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path after `--- ` / `+++ `: text after the four characters, up to the
 *  first tab, with surrounding spaces removed. */
function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0] ?? '';
  return raw.trim();
}

/** Does a `\` line follow the hunk's last context or `+` line? */
function backslashAfterLast(hunk: Hunk): boolean {
  let last = -1;
  hunk.body.forEach((b, i) => {
    if (b.kind === ' ' || b.kind === '+') last = i;
  });
  if (last < 0) return false;
  return hunk.body[last + 1]?.kind === '\\';
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') body.push({ kind: ' ', text: '' });
        else if (b[0] === ' ') body.push({ kind: ' ', text: b.slice(1) });
        else if (b[0] === '-') body.push({ kind: '-', text: b.slice(1) });
        else if (b[0] === '+') body.push({ kind: '+', text: b.slice(1) });
        else if (b[0] === '\\') body.push({ kind: '\\', text: b.slice(1) });
        else break;
        j++;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (inHeader && cur !== null) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.oldPath = headerPath(line);
          cur.newPath = headerPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = { oldPath: headerPath(line), newPath: headerPath(lines[i + 1]!), isCreate: false, isDelete: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inHeader && cur !== null) {
      if (line.startsWith('rename from ')) cur.oldPath = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.newPath = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s));
}

function unifiedEdit(s: UniSection): Edit {
  const oldP = s.oldPath === '/dev/null' ? null : s.oldPath === null ? null : stripAB(s.oldPath);
  const newP = s.newPath === '/dev/null' ? null : s.newPath === null ? null : stripAB(s.newPath);
  const isCreate = s.isCreate || s.oldPath === '/dev/null';
  const isDelete = s.isDelete || s.newPath === '/dev/null';
  return (tree, ctx) => {
    if (isCreate) {
      if (newP === null) throw new Fail('missing', '');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      let text = '';
      if (plus.length > 0) {
        text = plus.join('\n') + '\n';
        const lastHunk = [...s.hunks].reverse().find((h) => h.body.some((b) => b.kind === '+'));
        if (lastHunk !== undefined && backslashAfterLast(lastHunk)) text = plus.join('\n');
      }
      tree.now.set(newP, text);
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('missing', '');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const doc = applyHunks(parseDoc(before), s.hunks, ctx, oldP);
      tree.now.set(newP, renderDoc(doc));
      tree.now.set(oldP, null);
      ctx.moves.push([oldP, newP]);
      return;
    }
    const p = oldP ?? newP;
    if (p === null) throw new Fail('missing', '');
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const doc = applyHunks(parseDoc(before), s.hunks, ctx, p);
    tree.now.set(p, renderDoc(doc));
  };
}

/** Apply a section's hunks in order to a document. */
function applyHunks(doc: FileDoc, hunks: Hunk[], ctx: Ctx, path: string): FileDoc {
  let lines = doc.lines;
  let final = doc.final;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h.body);
    if (o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      const ins = n.map((x) => x.text);
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      // Insertion at the end: the result ends with a line break unless a `\`
      // line follows the hunk's last context or `+` line.
      if (atEnd) final = !backslashAfterLast(h);
      d += n.length;
      continue;
    }
    const found = findFirstTier(lines, o, ctx.strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let at = found.pos[0]!;
    for (const p of found.pos) {
      if (Math.abs(p - target) < Math.abs(at - target)) at = p;
    }
    const runsToEnd = at + o.length === lines.length;
    lines = applyReplace(lines, o, n, found.tier, at);
    if (runsToEnd) final = !backslashAfterLast(h);
    d += n.length - o.length;
  }
  return { lines, br: doc.br, final };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(((p, o, n) => (tree, ctx) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (o.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, n.length === 0 ? '' : n.join('\n') + '\n');
        return;
      }
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const doc = parseDoc(text);
      const found = findFirstTier(doc.lines, o, ctx.strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const out = applyReplace(doc.lines, o, n.map((t) => ({ text: t, ctx: false, oIdx: -1 })), found.tier, found.pos[0]!);
      tree.now.set(p, renderDoc({ lines: out, br: doc.br, final: doc.final }));
    })(path, oldLines, newLines));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

const ADD_PREFIX = '*** Add File: ';
const DEL_PREFIX = '*** Delete File: ';
const UPD_PREFIX = '*** Update File: ';
const MOVE_PREFIX = '*** Move to: ';

function isSectionStart(line: string): boolean {
  return line.startsWith(ADD_PREFIX) || line.startsWith(DEL_PREFIX) || line.startsWith(UPD_PREFIX);
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith(ADD_PREFIX)) {
      const path = line.slice(ADD_PREFIX.length).trim();
      const content: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        const b = lines[j]!;
        if (b === '') content.push('');
        else if (b[0] === '+') content.push(b.slice(1));
        else throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      edits.push(((p, c) => (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, c.length === 0 ? '' : c.join('\n') + '\n');
      })(path, content));
      i = j;
      continue;
    }
    if (line.startsWith(DEL_PREFIX)) {
      const path = line.slice(DEL_PREFIX.length).trim();
      edits.push(((p) => (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
      i++;
      continue;
    }
    if (line.startsWith(UPD_PREFIX)) {
      const path = line.slice(UPD_PREFIX.length).trim();
      const updateLine = i + 1;
      let moveTo: string | null = null;
      let j = i + 1;
      if (j < last && lines[j]!.startsWith(MOVE_PREFIX)) {
        moveTo = lines[j]!.slice(MOVE_PREFIX.length).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let started = false;
      const closeChunk = (): void => {
        if (cur === null) return;
        chunks.push(cur);
        cur = null;
      };
      while (j < last && !isSectionStart(lines[j]!)) {
        const b = lines[j]!;
        if (b.startsWith('@@')) {
          closeChunk();
          cur = { anchor: b.slice(2).trim(), eof: false, body: [] };
          started = true;
        } else if (b === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          closeChunk();
        } else if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (cur === null) {
            if (started) throw new Exit2(`error: parse ${j + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            started = true;
          }
          cur.body.push(b === '' ? { kind: ' ', text: '' } : { kind: b[0] as ' ' | '-' | '+', text: b.slice(1) });
        } else {
          throw new Exit2(`error: parse ${j + 1}`);
        }
        j++;
      }
      closeChunk();
      // Blank lines at the end of a section are not part of it.
      if (chunks.length > 0) {
        const tail = chunks[chunks.length - 1]!;
        while (tail.body.length > 0 && tail.body[tail.body.length - 1]!.kind === ' ' && tail.body[tail.body.length - 1]!.text === '') tail.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(((p, m, cs) => (tree, ctx) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (m !== null && !safe(m)) throw new Fail('unsafe', m);
        const text = tree.get(p);
        if (text === null) throw new Fail('missing', p);
        if (m !== null && tree.get(m) !== null) throw new Fail('exists', m);
        const doc = parseDoc(text);
        let curLines = doc.lines;
        let cursor = 0;
        for (const ch of cs) {
          if (ch.anchor !== null && ch.anchor !== '') {
            const at = findAnchor(curLines, ch.anchor, cursor, ctx.strict);
            if (at === null) throw new Fail('no-match', p);
            cursor = at + 1;
          }
          const { o, n } = splitBody(ch.body);
          if (o.length === 0) {
            const at = ch.eof ? curLines.length : cursor;
            const ins = n.map((x) => x.text);
            curLines = [...curLines.slice(0, at), ...ins, ...curLines.slice(at)];
            cursor = at + ins.length;
            continue;
          }
          const found = findChunkOccurrence(curLines, o, cursor, ch.eof, ctx.strict);
          if (found === null) throw new Fail('no-match', p);
          curLines = applyReplace(curLines, o, n, found.tier, found.at);
          cursor = found.at + n.length;
        }
        const out = renderDoc({ lines: curLines, br: doc.br, final: doc.final });
        if (m !== null) {
          tree.now.set(m, out);
          tree.now.set(p, null);
          ctx.moves.push([p, m]);
        } else {
          tree.now.set(p, out);
        }
      })(path, moveTo, chunks));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** First line at or after `cursor` equal to the anchor at the first tier
 *  where one is (single-line match). */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < lines.length; i++) {
      if (norm(lines[i]!, t) === norm(anchor, t)) return i;
    }
  }
  return null;
}

/** First occurrence of O at or after `cursor` at the first tier with one; an
 *  end-of-file chunk takes only an occurrence ending at the last line. */
function findChunkOccurrence(lines: string[], o: string[], cursor: number, eof: boolean, strict: boolean): { tier: number; at: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (const at of occurrences(lines, o, t)) {
      if (at < cursor) continue;
      if (eof && at + o.length !== lines.length) continue;
      return { tier: t, at };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Running the CLI (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

const byteCompare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

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
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const ctx: Ctx = { strict, moves: [] };
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = ctx.moves.length;
    try {
      edit(tree, ctx);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      ctx.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [oldP, newP] of ctx.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      movedOld.add(oldP);
      movedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCompare)) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCompare)) {
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

// ---------------------------------------------------------------------------
// Trial hand-over: run as the grader runs it (RULES.md "The trial and the
// runner"). GET $MAKEFUN_ENV_URL/checks, run main.ts on each check in a fresh
// directory, POST the results ten at a time.
// ---------------------------------------------------------------------------

const MAIN = fileURLToPath(import.meta.url);
const TIMEOUT_MS = 10_000;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_FILES = 64;
const BATCH = 10;
const RETRIES = 4;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function send(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (attempt >= RETRIES) throw err;
      await sleep(250 * (attempt + 1));
    }
  }
}

interface Check {
  id: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
}
interface Result {
  id: string;
  exit: number;
  stdout: string;
  files: Record<string, string>;
}

function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && Object.keys(out).length < MAX_FILES) out[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function runCheck(c: Check): Result {
  const dir = mkdtempSync(join(tmpdir(), 'mend-'));
  try {
    for (const [p, text] of Object.entries(c.files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const env = { ...process.env };
    delete env.MAKEFUN_ENV_URL;
    const r = spawnSync(process.execPath, [MAIN, ...c.argv], { cwd: dir, env, input: c.stdin ?? '', encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 4 * MAX_STDOUT_BYTES });
    const exit = r.error !== undefined || r.status === null ? 124 : r.status;
    let stdout = r.stdout ?? '';
    while (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) stdout = stdout.slice(0, Math.floor(stdout.length / 2));
    return { id: c.id, exit, stdout, files: readTree(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runTrial(envUrl: string): Promise<void> {
  const base = envUrl.replace(/\/+$/, '');
  const post = async (results: Result[]): Promise<void> => {
    const res = await send(`${base}/results`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ results }) });
    const body = await res.text();
    if (!res.ok && res.status !== 409) throw new Error(`POST /results answered ${res.status}: ${body}`);
  };
  const res = await send(`${base}/checks`);
  if (!res.ok) throw new Error(`GET /checks answered ${res.status}`);
  const { checks } = (await res.json()) as { checks: Check[] };
  let batch: Result[] = [];
  for (const c of checks) {
    batch.push(runCheck(c));
    if (batch.length === BATCH) {
      await post(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await post(batch);
  process.stdout.write(`posted ${checks.length} results\n`);
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
