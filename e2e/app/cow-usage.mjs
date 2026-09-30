// How much disk space a folder uses of its own: the bytes of its files that
// are not shared with any other file (a copy-on-write clone shares all of
// its blocks with its source until one of them is written).
//
// Free space of the whole disk is no measure of that: any other process
// writing to the disk moves it. `du` is no measure either: it counts a
// clone's shared blocks as if they were its own. So the file system is
// asked per file:
//
//   macOS (APFS)          getattrlist ATTR_CMNEXT_PRIVATESIZE: the bytes of
//                         the file no clone shares
//   Linux (XFS, btrfs)    FIEMAP: the extents not flagged SHARED
//
// Both calls go through python3 (ctypes / fcntl), which macOS and Linux
// runners have; Node has no binding for either. Windows (ReFS) is not
// covered: N17 compares the clusters of a clone and its source there.

import { spawnSync } from "node:child_process";
import { platform } from "node:os";

const SCRIPT = String.raw`
import ctypes, ctypes.util, errno, fcntl, json, os, stat, struct, sys

def darwin_private(path):
    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    class AttrList(ctypes.Structure):
        _fields_ = [("bitmapcount", ctypes.c_ushort), ("reserved", ctypes.c_uint16),
                    ("commonattr", ctypes.c_uint32), ("volattr", ctypes.c_uint32),
                    ("dirattr", ctypes.c_uint32), ("fileattr", ctypes.c_uint32),
                    ("forkattr", ctypes.c_uint32)]
    ATTR_CMN_RETURNED_ATTRS = 0x80000000
    ATTR_CMNEXT_PRIVATESIZE = 0x00000008
    FSOPT_NOFOLLOW = 0x1
    FSOPT_ATTR_CMN_EXTENDED = 0x20
    def private(p):
        al = AttrList(5, 0, ATTR_CMN_RETURNED_ATTRS, 0, 0, 0, ATTR_CMNEXT_PRIVATESIZE)
        buf = ctypes.create_string_buffer(64)
        if libc.getattrlist(os.fsencode(p), ctypes.byref(al), buf, 64, FSOPT_NOFOLLOW | FSOPT_ATTR_CMN_EXTENDED) != 0:
            e = ctypes.get_errno()
            raise OSError(e, os.strerror(e), p)
        returned = struct.unpack_from("5I", buf, 4)
        if not returned[4] & ATTR_CMNEXT_PRIVATESIZE:
            raise OSError(errno.ENOTSUP, "the file system does not report a private size", p)
        return struct.unpack_from("q", buf, 24)[0]
    return private

def linux_private(path):
    FS_IOC_FIEMAP = 0xC020660B
    FIEMAP_FLAG_SYNC = 0x1
    FIEMAP_EXTENT_LAST = 0x1
    FIEMAP_EXTENT_SHARED = 0x2000
    HEADER, EXTENT, COUNT = 32, 56, 256
    def private(p):
        total = 0
        start = 0
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            while True:
                buf = bytearray(struct.pack("=QQIIII", start, 0xFFFFFFFFFFFFFFFF - start, FIEMAP_FLAG_SYNC, 0, COUNT, 0))
                buf += bytearray(EXTENT * COUNT)
                fcntl.ioctl(fd, FS_IOC_FIEMAP, buf, True)
                mapped = struct.unpack_from("=I", buf, 20)[0]
                if mapped == 0:
                    return total
                last = False
                for i in range(mapped):
                    at = HEADER + i * EXTENT
                    logical, _physical, length = struct.unpack_from("=QQQ", buf, at)
                    flags = struct.unpack_from("=I", buf, at + 40)[0]
                    if not flags & FIEMAP_EXTENT_SHARED:
                        total += length
                    start = logical + length
                    last = last or bool(flags & FIEMAP_EXTENT_LAST)
                if last:
                    return total
        finally:
            os.close(fd)
    return private

root = sys.argv[1]
private = darwin_private(root) if sys.platform == "darwin" else linux_private(root)
files = size = own = 0
for folder, dirs, names in os.walk(root):
    for name in names:
        p = os.path.join(folder, name)
        st = os.lstat(p)
        if not stat.S_ISREG(st.st_mode):
            continue
        files += 1
        size += st.st_size
        own += private(p)
print(json.dumps({"files": files, "bytes": size, "privateBytes": own}))
`;

/**
 * { files, bytes, privateBytes } of the regular files under `dir`:
 * `bytes` is their size, `privateBytes` the part of it only they hold.
 * Throws where the file system cannot tell (or on Windows).
 */
export function ownDiskUsage(dir) {
  if (platform() === "win32") throw new Error("ownDiskUsage: not on Windows (compare clusters instead)");
  const res = spawnSync("python3", ["-c", SCRIPT, dir], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (res.error) throw new Error(`ownDiskUsage: could not run python3: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`ownDiskUsage(${dir}) failed: ${(res.stderr || res.stdout).trim()}`);
  return JSON.parse(res.stdout);
}
