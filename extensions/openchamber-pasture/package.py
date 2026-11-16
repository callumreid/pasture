#!/usr/bin/env python3
"""Create an OpenChamber-compatible, reproducible ZIP from built assets."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parent
files = [root / "package.json", *sorted((root / "panel").glob("*")), *sorted((root / "licenses").glob("*"))]
with ZipFile(root / "pasture-openchamber.zip", "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
    for file in files:
        if not file.is_file():
            continue
        info = ZipInfo(file.relative_to(root).as_posix(), date_time=(2020, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, file.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)
