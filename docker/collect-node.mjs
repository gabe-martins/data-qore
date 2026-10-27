// Called only in the build stage. ldd resolves the executable's transitive deps.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
const destination = process.argv[2];
const output = execFileSync("ldd", [process.execPath], { encoding: "utf8" });
if (output.includes("not found")) throw Error("Node runtime library missing");
const paths = new Set([process.execPath, ...output.matchAll(/(?:=>\s*|^\s*)(\/[^\s]+)/gm)].map(v => typeof v === "string" ? v : v[1]));
for (const source of paths) {
  const target = join(destination, source);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target); // Dereference symlinks, retaining the loader's path.
}
