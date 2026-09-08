# SPDX-License-Identifier: MPL-2.0
"""Disposable fixture for an explicitly authorized Linux native-GUI copy test.

Run via SSH stdin with arguments: setup|verify|cleanup /tmp/shellcanvas-native-copy-UUID
The UI performs the copy. This script only creates, checks, or removes exact
generated paths; cleanup refuses unexpected entries and never recurses.
"""
import hashlib
import pathlib
import re
import sys

mode, raw_root = sys.argv[1:]
if not re.fullmatch(r"/tmp/shellcanvas-native-copy-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", raw_root):
    raise ValueError("Expected a newly owned UUID fixture path")
root = pathlib.Path(raw_root)
destination = root / "destination"
source = root / "sample.bin"
copied = destination / source.name
payload = bytes(range(251)) * 33421 + b"end"
expected = hashlib.sha256(payload).hexdigest()

if mode == "setup":
    root.mkdir(mode=0o700)
    destination.mkdir(mode=0o700)
    with source.open("xb") as file:
        file.write(payload)
    print(f"Created {root}; bytes={len(payload)} sha256={expected}")
elif mode in ("verify", "cleanup"):
    if root.is_symlink() or destination.is_symlink():
        raise ValueError("Fixture directories must not be symlinks")
    if set(root.iterdir()) != {source, destination}:
        raise ValueError("Unexpected fixture entries; inspect before cleanup")
    children = set(destination.iterdir())
    if not children.issubset({copied}):
        raise ValueError("Unexpected destination entries; inspect before cleanup")
    for path in [source, *children]:
        if path.is_symlink() or not path.is_file():
            raise ValueError("Expected regular generated files")
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"Unexpected file contents: {path}")
    if mode == "verify":
        if children != {copied}:
            raise ValueError("Copy missing")
        print(f"Source and copied file match: bytes={len(payload)} sha256={expected}")
    else:
        for path in children:
            path.unlink()
        source.unlink()
        destination.rmdir()
        root.rmdir()
        assert not root.exists()
        print(f"Removed exact generated files and empty fixture: {root}")
else:
    raise ValueError("Use setup, verify or cleanup")
