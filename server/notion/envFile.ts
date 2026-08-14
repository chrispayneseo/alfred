import fs from "node:fs";

/** Updates or appends KEY=value lines in a .env file, leaving everything else untouched. */
export function updateEnvFile(path: string, updates: Record<string, string>): void {
  const content = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
  const lines = content.length ? content.split("\n") : [];
  const seen = new Set<string>();

  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (match && Object.prototype.hasOwnProperty.call(updates, match[1])) {
      seen.add(match[1]);
      return `${match[1]}=${updates[match[1]]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) nextLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(path, nextLines.join("\n"));
}
