// Names PostgreSQL generates for objects the desired schema leaves unnamed
// (primary keys, NOT NULL constraints, identity sequences), computed the way
// PostgreSQL 18's makeObjectName() does: `name1_name2_label`, with name1 and
// name2 shortened (longest first) to fit NAMEDATALEN - 1 = 63 bytes.

const maxNameBytes = 63;

export function generatedName(
  name1: string,
  name2: string | undefined,
  label: string,
): string {
  const overhead = Buffer.byteLength(label) + 1 + (name2 === undefined ? 0 : 1);
  let name1Bytes = Buffer.byteLength(name1);
  let name2Bytes = name2 === undefined ? 0 : Buffer.byteLength(name2);
  const available = maxNameBytes - overhead;
  while (name1Bytes + name2Bytes > available) {
    if (name1Bytes > name2Bytes) {
      name1Bytes--;
    } else {
      name2Bytes--;
    }
  }
  const parts = [clip(name1, name1Bytes)];
  if (name2 !== undefined) {
    parts.push(clip(name2, name2Bytes));
  }
  parts.push(label);
  return parts.join("_");
}

/** The longest prefix of `name` that fits in `bytes` UTF-8 bytes without splitting a character. */
function clip(name: string, bytes: number): string {
  let result = "";
  let used = 0;
  for (const character of name) {
    const size = Buffer.byteLength(character);
    if (used + size > bytes) {
      break;
    }
    result += character;
    used += size;
  }
  return result;
}
