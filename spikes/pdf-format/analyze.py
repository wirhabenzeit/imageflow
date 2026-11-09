"""Reports per page: transparency features, image encodings and ICC profiles, and JPEG passthrough.

Usage: .venv/bin/python analyze.py out/*.pdf
"""
import hashlib
import pathlib
import sys

import pikepdf

ASSETS = pathlib.Path(__file__).parent / "assets"
SOURCE_HASHES = {
    hashlib.md5(p.read_bytes()).hexdigest(): p.name for p in ASSETS.glob("*.jpg")
}


def icc_description(colorspace):
    """Return the profile description of an ICCBased colour space, or the colour space name."""
    if isinstance(colorspace, pikepdf.Array) and colorspace[0] == "/ICCBased":
        data = colorspace[1].read_bytes()
        # 'desc' tag: find it in the tag table and decode the ASCII or Unicode description.
        count = int.from_bytes(data[128:132], "big")
        for i in range(count):
            entry = data[132 + 12 * i : 144 + 12 * i]
            if entry[:4] == b"desc":
                offset = int.from_bytes(entry[4:8], "big")
                kind = data[offset : offset + 4]
                if kind == b"desc":
                    length = int.from_bytes(data[offset + 8 : offset + 12], "big")
                    return data[offset + 12 : offset + 12 + length - 1].decode("latin-1")
                if kind == b"mluc":
                    rec = data[offset + 16 : offset + 28]
                    length = int.from_bytes(rec[4:8], "big")
                    start = offset + int.from_bytes(rec[8:12], "big")
                    return data[start : start + length].decode("utf-16-be")
        return "ICC (no description)"
    return str(colorspace)


def walk_resources(resources, seen, report, depth=0):
    if resources is None or depth > 8:
        return
    for name, gs in (resources.get("/ExtGState") or {}).items():
        notes = []
        for key in ("/CA", "/ca"):
            if key in gs and float(gs[key]) < 1:
                notes.append(f"{key}={float(gs[key]):.2f}")
        if "/SMask" in gs and gs["/SMask"] != "/None":
            notes.append("SMask")
        if "/BM" in gs and gs["/BM"] not in ("/Normal", "/Compatible"):
            notes.append(f"BM={gs['/BM']}")
        if notes:
            report["transparency"].append(f"ExtGState {name}: {', '.join(notes)}")
    for name, xobj in (resources.get("/XObject") or {}).items():
        key = xobj.objgen
        if key in seen:
            continue
        seen.add(key)
        if xobj.get("/Subtype") == "/Image":
            filt = xobj.get("/Filter")
            raw = xobj.read_raw_bytes()
            source = SOURCE_HASHES.get(hashlib.md5(raw).hexdigest()) if filt == "/DCTDecode" else None
            report["images"].append(
                f"{int(xobj.Width)}x{int(xobj.Height)} {filt} {icc_description(xobj.get('/ColorSpace'))}"
                + (" +SMask" if "/SMask" in xobj else "")
                + (f" == source {source}" if source else "")
                + f" ({len(raw) // 1024} KB)"
            )
            if "/SMask" in xobj:
                report["transparency"].append(f"image {name} has SMask")
        elif xobj.get("/Subtype") == "/Form":
            group = xobj.get("/Group")
            if group is not None and group.get("/S") == "/Transparency":
                report["transparency"].append(f"form {name} transparency group")
            walk_resources(xobj.get("/Resources"), seen, report, depth + 1)


for path in sys.argv[1:]:
    pdf = pikepdf.open(path)
    print(f"== {path}  (PDF {pdf.pdf_version}, {len(pdf.pages)} pages)")
    for index, page in enumerate(pdf.pages, 1):
        report = {"transparency": [], "images": []}
        group = page.obj.get("/Group")
        if group is not None and group.get("/S") == "/Transparency":
            report["transparency"].append("page transparency group")
        walk_resources(page.obj.get("/Resources"), set(), report)
        print(f"  page {index}: transparency: {'; '.join(report['transparency']) or 'none'}")
        for image in report["images"]:
            print(f"    image {image}")
