// Parses the subset of project.godot that godot_project_info needs.
// Quoted strings become strings, PackedStringArray(...) becomes string[],
// and everything else stays a raw string.

export type ProjectValue = string | string[];

// Top-level keys, before any [section], live under the "" section.
export type ProjectFile = Record<string, Record<string, ProjectValue>>;

const STRING_LITERAL = /"(?:[^"\\]|\\.)*"/g;
const PACKED_STRING_ARRAY = /^PackedStringArray\((.*)\)$/s;

export function parseProjectFile(text: string): ProjectFile {
  const file: ProjectFile = { "": {} };
  let section = file[""] ?? {};
  let key: string | null = null;
  let value = "";
  let depth = 0;

  const commit = () => {
    if (key !== null) section[key] = parseValue(value);
    key = null;
    value = "";
    depth = 0;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // A multi-line value (for example an [input] dictionary) continues until its brackets balance.
    if (key !== null && depth > 0) {
      value += `\n${line}`;
      depth = bracketDepth(value);
      if (depth === 0) commit();
      continue;
    }
    if (line === "" || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      commit();
      section = file[header[1] ?? ""] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) throw new Error(`malformed project.godot line: ${line}`);
    commit();
    key = line.slice(0, eq).trim();
    value = line.slice(eq + 1).trim();
    depth = bracketDepth(value);
    if (depth === 0) commit();
  }
  commit();
  return file;
}

function parseValue(raw: string): ProjectValue {
  const packed = PACKED_STRING_ARRAY.exec(raw);
  if (packed) {
    return [...(packed[1] ?? "").matchAll(STRING_LITERAL)].map(
      (m) => JSON.parse(m[0]) as string,
    );
  }
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))
    return JSON.parse(raw) as string;
  return raw;
}

// Counts open brackets outside string literals. Returns 0 when a value is complete.
function bracketDepth(text: string): number {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
  }
  return depth;
}
