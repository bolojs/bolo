export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export interface PackageJsonMeta {
  data: PackageJson;
  indent: string;
  trailingNewline: boolean;
}

const detectIndent = (text: string): string => {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const leading = line.match(/^[\t ]+/)?.[0];
    if (leading) {
      if (leading.includes("\t")) return "\t";
      return leading;
    }
  }
  return "  ";
};

export const readPackageJsonWithMeta = (text: string): PackageJsonMeta => {
  const data = JSON.parse(text) as PackageJson;
  const indent = detectIndent(text);
  const trailingNewline = text.endsWith("\n");
  return { data, indent, trailingNewline };
};

export const writePackageJsonWithMeta = (
  data: PackageJson,
  indent: string,
  trailingNewline: boolean,
): string => {
  const serialized = JSON.stringify(data, null, indent);
  return trailingNewline ? `${serialized}\n` : serialized;
};
