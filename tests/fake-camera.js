import QRCode from 'qrcode';
import { writeFileSync } from 'node:fs';

// Skriver en Y4M-video (det format Chromes falska kamera läser) med QR-koderna bredvid varandra på vit botten
export function writeQrVideo(file, texts, { width = 640, height = 480, scale = 6 } = {}) {
  const y = new Uint8Array(width * height).fill(235);
  let x0 = 20;
  for (const text of texts) {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: 'L' });
    const y0 = Math.floor((height - modules.size * scale) / 2);
    for (let r = 0; r < modules.size; r++)
      for (let c = 0; c < modules.size; c++)
        if (modules.get(r, c))
          for (let dy = 0; dy < scale; dy++)
            y.fill(16, (y0 + r * scale + dy) * width + x0 + c * scale, (y0 + r * scale + dy) * width + x0 + (c + 1) * scale);
    x0 += (modules.size + 8) * scale;
  }
  const uv = new Uint8Array((width / 2) * (height / 2) * 2).fill(128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, uv]);
  writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]));
}
