// 最小限のPDF生成：各ページに JPEG 画像を1枚ずつ全面配置する（A4縦）
export function makePdf(images, pageW = 595.28, pageH = 841.89) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let len = 0;
  const push = (d) => { if (typeof d === 'string') d = enc.encode(d); chunks.push(d); len += d.length; };
  const begin = (n) => { offsets[n] = len; push(`${n} 0 obj\n`); };
  const end = () => push('\nendobj\n');

  push('%PDF-1.4\n%âãÏÓ\n');
  const n = images.length;
  const pageRef = (i) => 3 + i * 3;
  begin(1); push('<< /Type /Catalog /Pages 2 0 R >>'); end();
  begin(2); push(`<< /Type /Pages /Count ${n} /Kids [${images.map((_, i) => `${pageRef(i)} 0 R`).join(' ')}] >>`); end();
  images.forEach((img, i) => {
    const p = pageRef(i), c = p + 1, im = p + 2;
    begin(p);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${c} 0 R >>`);
    end();
    const cs = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
    begin(c); push(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`); end();
    begin(im);
    push(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>\nstream\n`);
    push(img.jpeg);
    push('\nendstream');
    end();
  });
  const total = 2 + n * 3;
  const xref = len;
  let x = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(x);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
