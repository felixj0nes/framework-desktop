/**
 * generate-assets.js
 *
 * Generates build assets that cannot be checked in as binary files:
 *   - build/dmg-background.png  (540×380 @2x = 1080×760px)
 *   - build/icon.ico             (multi-size from build/icon.png — Windows)
 *   - build/icon.icns            (multi-size from build/icon.png — macOS)
 *
 * Run before building:  node build/generate-assets.js
 *
 * Requirements:
 *   npm install sharp  (run once: npm install --save-dev sharp)
 *
 * Code signing assets (icon.ico, icon.icns) require the script below — or
 * you can use an online converter and drop the files into build/ manually.
 */

const path = require('path')
const fs = require('fs')

// ── Pure Node.js BMP writer (no dependencies) ──────────────────────────────
// Creates a 24-bit uncompressed BMP. pixels = flat array of {r,g,b} objects,
// top-to-bottom, left-to-right order.
function writeBMP(width, height, pixels) {
  const rowPad  = (4 - (width * 3) % 4) % 4  // padding bytes per row
  const rowSize = width * 3 + rowPad
  const pixData = rowSize * height
  const fileSize = 14 + 40 + pixData
  const buf = Buffer.alloc(fileSize, 0)

  // ── File header (14 bytes) ──────────────────────────────────────────
  buf.write('BM', 0)
  buf.writeUInt32LE(fileSize, 2)
  buf.writeUInt32LE(14 + 40, 10)  // pixel data offset

  // ── DIB header / BITMAPINFOHEADER (40 bytes) ────────────────────────
  buf.writeUInt32LE(40, 14)       // header size
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(-height, 22)   // negative = top-down scan order
  buf.writeUInt16LE(1, 26)        // colour planes
  buf.writeUInt16LE(24, 28)       // bits per pixel (24-bit RGB)
  // remaining DIB fields are 0 (no compression, auto image size, etc.)

  // ── Pixel data (BGR, bottom-up because negative height used) ────────
  let offset = 14 + 40
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = pixels[y * width + x] || { r: 0xF9, g: 0xFA, b: 0xFB }
      buf[offset++] = px.b
      buf[offset++] = px.g
      buf[offset++] = px.r
    }
    offset += rowPad
  }
  return buf
}

// Renders the Framework logomark onto a pixel array at position (ox, oy).
// markSize: outer square size in pixels.
function renderLogomark(pixels, width, ox, oy, markSize) {
  const tint   = { r: 0xDB, g: 0xBE, b: 0xFE }  // DBEAFE
  const ink    = { r: 0x11, g: 0x18, b: 0x27 }  // 111827
  const blue   = { r: 0x3B, g: 0x82, b: 0xF6 }  // 3B82F6
  const bdr    = { r: 0xE5, g: 0xE7, b: 0xEB }  // E5E7EB

  const pad    = Math.round(markSize * 0.22)
  const barH   = Math.max(2, Math.round(markSize * 0.1))
  const barGap = Math.max(2, Math.round(markSize * 0.07))
  const barW   = markSize - pad * 2

  // Blue-tint background square
  for (let dy = 0; dy < markSize; dy++) {
    for (let dx = 0; dx < markSize; dx++) {
      pixels[(oy + dy) * width + (ox + dx)] = { ...tint }
    }
  }

  const startY = oy + pad
  const startX = ox + pad

  // Bar 1 — full width, ink
  for (let dy = 0; dy < barH; dy++)
    for (let dx = 0; dx < barW; dx++)
      pixels[(startY + dy) * width + (startX + dx)] = { ...ink }

  // Bar 2 — 60%, blue
  const b2y = startY + barH + barGap
  for (let dy = 0; dy < barH; dy++)
    for (let dx = 0; dx < Math.round(barW * 0.6); dx++)
      pixels[(b2y + dy) * width + (startX + dx)] = { ...blue }

  // Bar 3 — 78%, border grey
  const b3y = b2y + barH + barGap
  for (let dy = 0; dy < barH; dy++)
    for (let dx = 0; dx < Math.round(barW * 0.78); dx++)
      pixels[(b3y + dy) * width + (startX + dx)] = { ...bdr }
}

async function run() {
  let sharp
  try {
    sharp = require('sharp')
  } catch {
    console.error('sharp not installed. Run: npm install --save-dev sharp')
    process.exit(1)
  }

  const buildDir = path.join(__dirname)
  const srcIcon = path.join(buildDir, 'icon.png')

  if (!fs.existsSync(srcIcon)) {
    console.error('build/icon.png not found')
    process.exit(1)
  }

  // ── DMG background (1080×760 @2x for Retina — electron-builder uses this size) ──
  const dmgBgSvg = fs.readFileSync(path.join(buildDir, 'dmg-background.svg'))
  await sharp(Buffer.from(dmgBgSvg))
    .resize(1080, 760)
    .png()
    .toFile(path.join(buildDir, 'dmg-background.png'))
  console.log('✓ dmg-background.png generated (1080×760)')

  // ── icon.ico (Windows — 16, 32, 48, 64, 128, 256) ──
  const icoSizes = [16, 32, 48, 64, 128, 256]
  const icoPngPaths = []
  for (const size of icoSizes) {
    const dest = path.join(buildDir, `icon-${size}.png`)
    await sharp(srcIcon).resize(size, size).png().toFile(dest)
    icoPngPaths.push(dest)
  }
  try {
    const pngToIcoMod = require('png-to-ico')
    const pngToIco = pngToIcoMod.default || pngToIcoMod.imagesToIco || pngToIcoMod
    const icoBuffer = await pngToIco(icoPngPaths)
    fs.writeFileSync(path.join(buildDir, 'icon.ico'), icoBuffer)
    console.log('✓ icon.ico generated (16, 32, 48, 64, 128, 256px)')
  } catch {
    console.warn('  icon.ico — skipped (png-to-ico not available). Run: npm install --save-dev png-to-ico')
  }
  // Clean up intermediate PNGs
  for (const p of icoPngPaths) { try { fs.unlinkSync(p) } catch {} }

  // ── icon.icns (macOS) ──
  // iconutil (macOS only) is required for .icns.
  // On CI (macos-latest runner) this script runs automatically.
  if (process.platform === 'darwin') {
    const { execSync } = require('child_process')
    const iconsetDir = path.join(buildDir, 'icon.iconset')
    if (!fs.existsSync(iconsetDir)) fs.mkdirSync(iconsetDir)

    const icnsSizes = [16, 32, 64, 128, 256, 512, 1024]
    for (const size of icnsSizes) {
      await sharp(srcIcon).resize(size, size).png()
        .toFile(path.join(iconsetDir, `icon_${size}x${size}.png`))
      // Retina (@2x) version
      if (size * 2 <= 1024) {
        await sharp(srcIcon).resize(size * 2, size * 2).png()
          .toFile(path.join(iconsetDir, `icon_${size}x${size}@2x.png`))
      }
    }
    execSync(`iconutil -c icns "${iconsetDir}" -o "${path.join(buildDir, 'icon.icns')}"`)
    fs.rmSync(iconsetDir, { recursive: true })
    console.log('✓ icon.icns generated')
  } else {
    console.log('  icon.icns — skipped (requires macOS iconutil). Will be generated on macOS CI runner.')
  }

  // ── NSIS installer branding bitmaps ──────────────────────────────────
  // installerHeaderBitmap: 150×57px — shown at top of each installer page
  {
    const W = 150, H = 57
    const bg = { r: 0xF9, g: 0xFA, b: 0xFB }
    const pixels = new Array(W * H).fill(null).map(() => ({ ...bg }))
    const markSize = 33
    const ox = 12, oy = Math.round((H - markSize) / 2)
    renderLogomark(pixels, W, ox, oy, markSize)
    fs.writeFileSync(path.join(buildDir, 'installer-header.bmp'), writeBMP(W, H, pixels))
    console.log('✓ installer-header.bmp generated (150×57)')
  }

  // installerSidebar: 164×314px — shown on Welcome and Finish pages
  {
    const W = 164, H = 314
    const bg = { r: 0xF9, g: 0xFA, b: 0xFB }
    const pixels = new Array(W * H).fill(null).map(() => ({ ...bg }))
    const markSize = 60
    const ox = Math.round((W - markSize) / 2)
    const oy = Math.round(H * 0.28)
    renderLogomark(pixels, W, ox, oy, markSize)
    fs.writeFileSync(path.join(buildDir, 'installer-sidebar.bmp'), writeBMP(W, H, pixels))
    console.log('✓ installer-sidebar.bmp generated (164×314)')
  }

  console.log('\nAll assets generated successfully.')
}

run().catch(e => { console.error(e); process.exit(1) })
