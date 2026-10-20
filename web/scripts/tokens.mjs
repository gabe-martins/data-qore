import fs from "node:fs";
const colors = JSON.parse(
  fs.readFileSync(new URL("../src/color-system.json", import.meta.url)),
);
function resolve(value, seen = new Set()) {
  if (!value.startsWith("{")) return value;
  const ref = value.slice(1, -1);
  if (seen.has(ref)) throw Error("Cyclic color token");
  seen.add(ref);
  return resolve(
    ref.split(".").reduce((o, k) => o[k], colors),
    seen,
  );
}
let out = [];
function walk(obj, path = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "object") walk(v, [...path, k]);
    else if (typeof v === "string" && (v.startsWith("#") || v.startsWith("{"))) {
      resolve(v); // Validate aliases and cycles before emitting CSS variables.
      out.push(
        `  --${[...path, k].join("-").replaceAll("_", "-")}: ${v.startsWith('{') ? `var(--${v.slice(1, -1).replaceAll('.', '-').replaceAll('_', '-')})` : resolve(v)};`,
      );
    }
  }
}
for (const k of ["primitive", "semantic", "component_guidance"])
  walk(colors[k], [k.replaceAll("_", "-")]);
let css = "/* Generated from color-system.json. Run npm run tokens:generate. */\n:root {\n" + out.join("\n") + "\n}\n";
for (const [theme, tokens] of Object.entries(colors.themes ?? {})) {
  out = [];
  walk(tokens);
  css += `[data-theme="${theme}"] {\n${out.join("\n")}\n}\n`;
}
fs.writeFileSync(new URL("../src/tokens.css", import.meta.url), css);
