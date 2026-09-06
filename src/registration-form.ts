// Accept labelled fields in any order, or plain lines: name, unit, type, email.
// Keep submitted values without requiring particular formats or resident types.
export function parseRegistrationForm(text: string) {
  const fields = { name: "", unit: "", status: "", email: "" };
  type Field = keyof typeof fields;
  const labels: Record<string, Field> = {
    name: "name",
    unit: "unit",
    "unit number": "unit",
    "resident type": "status",
    status: "status",
    email: "email",
  };
  const labelled = new Set<Field>();
  const plainLines: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^\*|\*$/g, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    const label = line.slice(0, separator).replace(/\*/g, "").trim().toLowerCase();
    const field = separator >= 0 && Object.prototype.hasOwnProperty.call(labels, label) ? labels[label] : undefined;
    if (field) {
      fields[field] = line.slice(separator + 1).trim().replace(/^\*|\*$/g, "").trim();
      labelled.add(field);
    } else {
      plainLines.push(line);
    }
  }

  for (const field of Object.keys(fields) as Field[]) {
    if (!labelled.has(field)) fields[field] = plainLines.shift() || "";
  }
  return fields;
}
