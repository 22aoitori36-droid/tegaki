# 依存なしでPNGアイコンを生成（ノート＋ペン）
import struct, zlib, os, math
def png(path, n):
    S = n / 512
    def inside_rr(x, y, x0, y0, x1, y1, r):
        if x < x0 or x > x1 or y < y0 or y > y1: return False
        cx = min(max(x, x0 + r), x1 - r); cy = min(max(y, y0 + r), y1 - r)
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    def seg_d(x, y, ax, ay, bx, by):
        dx, dy = bx - ax, by - ay
        t = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
        return math.hypot(x - ax - t * dx, y - ay - t * dy)
    rows = []
    for py in range(n):
        row = bytearray([0])
        for px in range(n):
            x, y = (px + .5) / S, (py + .5) / S
            c = (255, 159, 10)                       # 背景 オレンジ
            if inside_rr(x, y, 110, 80, 402, 432, 28):
                c = (255, 255, 255)                  # 紙
                if 150 < x < 362 and any(abs(y - ly) < 4 for ly in (170, 230, 290, 350)):
                    c = (205, 214, 228)              # 罫線
                # 手書きの波線
                wy = 232 + 22 * math.sin((x - 150) / 26)
                if 150 < x < 330 and abs(y - wy) < 9: c = (40, 40, 52)
            if seg_d(x, y, 300, 420, 440, 140) < 22: c = (52, 120, 246)   # ペン軸
            if seg_d(x, y, 300, 420, 290, 448) < 9: c = (40, 40, 52)      # ペン先
            row += bytes(c)
        rows.append(bytes(row))
    raw = zlib.compress(b''.join(rows), 9)
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', n, n, 8, 2, 0, 0, 0)) + chunk(b'IDAT', raw) + chunk(b'IEND', b'')
    open(path, 'wb').write(data)
d = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icons')
png(os.path.join(d, 'icon-192.png'), 192); png(os.path.join(d, 'icon-512.png'), 512); png(os.path.join(d, 'apple-touch-icon.png'), 180)
