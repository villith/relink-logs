"""Print the exported symbol names of a PE file.

Usage: py scripts/dump-exports.py target/release/hook.dll
Used to verify hook.dll exports DirectInput8Create (the dinput8-proxy entry
point the game imports under Proton). No third-party deps.
"""
import struct
import sys

path = sys.argv[1]
with open(path, "rb") as f:
    data = f.read()

e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
assert data[e_lfanew:e_lfanew + 4] == b"PE\0\0", "not a PE file"
coff = e_lfanew + 4
num_sections = struct.unpack_from("<H", data, coff + 2)[0]
opt_size = struct.unpack_from("<H", data, coff + 16)[0]
opt = coff + 20
assert struct.unpack_from("<H", data, opt)[0] == 0x20B, "not PE32+"
dirs = opt + 112

sections = []
sec = opt + opt_size
for i in range(num_sections):
    off = sec + i * 40
    vsz, va = struct.unpack_from("<II", data, off + 8)
    rsz, raw = struct.unpack_from("<II", data, off + 16)
    sections.append((va, vsz, raw, rsz))

def rva2off(rva):
    for va, vsz, raw, rsz in sections:
        if va <= rva < va + max(vsz, rsz):
            return raw + (rva - va)
    raise ValueError(f"rva {rva:#x} not in any section")

export_rva = struct.unpack_from("<I", data, dirs)[0]
if not export_rva:
    sys.exit("no export directory")
exp = rva2off(export_rva)
num_names = struct.unpack_from("<I", data, exp + 24)[0]
names = rva2off(struct.unpack_from("<I", data, exp + 32)[0])
for i in range(num_names):
    name_off = rva2off(struct.unpack_from("<I", data, names + i * 4)[0])
    print(data[name_off:data.index(b"\0", name_off)].decode())
