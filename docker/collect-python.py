"""Export native wheel libraries from the build image, preserving loader paths."""
from pathlib import Path
import re
import shutil
import subprocess
import sys

destination, venv, baseline = map(Path, sys.argv[1:4])
libraries = set()
for binary in venv.rglob("*.so*"):
    if not binary.is_file():
        continue
    with binary.open("rb") as stream:
        if stream.read(4) != b"\x7fELF":
            continue
    result = subprocess.run(["ldd", str(binary)], capture_output=True, text=True)
    if "not found" in result.stdout:
        raise SystemExit(f"Missing native dependency for {binary.name}: {result.stdout}")
    libraries.update(re.findall(r"(?:=>\s*|^\s*)(/[^\s]+)", result.stdout, re.M))
for name in sorted(libraries):
    source = Path(name)
    if source.is_relative_to(venv) or (baseline / source.relative_to("/")).exists():
        continue
    target = destination / source.relative_to("/")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
destination.mkdir(parents=True, exist_ok=True)
if len(sys.argv) == 5:
    extra = Path(sys.argv[4])
    for source in extra.rglob("*"):
        if not source.is_file() or (baseline / source.relative_to(extra)).exists():
            continue
        target = destination / source.relative_to(extra)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
