"""Insert a minimal EXIF APP1 segment with the given Orientation tag into a JPEG."""
import struct
import sys

src, dst, orientation = sys.argv[1], sys.argv[2], int(sys.argv[3])
data = open(src, "rb").read()
assert data[:2] == b"\xff\xd8"

# Big-endian TIFF header, IFD0 with a single entry: tag 0x0112 (Orientation), type SHORT, count 1.
tiff = b"MM\x00\x2a" + struct.pack(">I", 8)
tiff += struct.pack(">H", 1) + struct.pack(">HHIHH", 0x0112, 3, 1, orientation, 0) + struct.pack(">I", 0)
payload = b"Exif\x00\x00" + tiff
app1 = b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload

open(dst, "wb").write(data[:2] + app1 + data[2:])
