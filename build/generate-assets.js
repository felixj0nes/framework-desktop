/**
 * generate-assets.js
 *
 * Generates build assets that cannot be checked in as binary files:
 *   - build/dmg-background.png       (1080×760px — macOS DMG background)
 *   - build/icons/icon.png           (512×512, transparent — Linux / fallback)
 *   - build/icons/icon.ico           (multi-size, transparent — Windows)
 *   - build/icons/icon.icns          (multi-size, transparent — macOS; macOS CI only)
 *   - build/installer-header.bmp     (150×57px — NSIS installer header)
 *   - build/installer-sidebar.bmp    (164×314px — NSIS installer sidebar)
 *
 * Source: build/icon-source.svg — 1024×1024 transparent SVG logomark.
 *
 * Run before building:  node build/generate-assets.js
 *
 * Requirements:
 *   npm install --save-dev sharp png-to-ico
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
  const tint   = { r: 0xDB, g: 0xEA, b: 0xFE }  // DBEAFE
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

  // ── Icon source: transparent SVG ────────────────────────────────────────────
  const iconSrc = path.join(buildDir, 'icon-source.svg')
  if (!fs.existsSync(iconSrc)) {
    console.error('build/icon-source.svg not found')
    process.exit(1)
  }
  const iconSvg = fs.readFileSync(iconSrc)

  const iconsDir = path.join(buildDir, 'icons')
  if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true })

  // ── DMG background (1080×760 @2x for Retina — electron-builder uses this size) ──
  const dmgBgSvg = fs.readFileSync(path.join(buildDir, 'dmg-background.svg'))
  await sharp(Buffer.from(dmgBgSvg))
    .resize(1080, 760)
    .png()
    .toFile(path.join(buildDir, 'dmg-background.png'))
  console.log('✓ dmg-background.png generated (1080×760)')

  // ── icons/icon.png (512×512 — transparent, Linux / general fallback) ──
  await sharp(iconSvg)
    .resize(512, 512)
    .png({ compressionLevel: 9 })
    .toFile(path.join(iconsDir, 'icon.png'))
  console.log('✓ icons/icon.png generated (512×512, transparent)')

  // Verify alpha channel is present
  const iconMeta = await sharp(path.join(iconsDir, 'icon.png')).metadata()
  if (!iconMeta.hasAlpha) {
    console.error('ERROR: icons/icon.png does not have an alpha channel — transparency missing')
    process.exit(1)
  }
  console.log('✓ Transparency verified: icons/icon.png has alpha channel')

  // ── icons/icon.ico (Windows — 16, 32, 48, 64, 128, 256 — all transparent) ──
  const icoSizes = [16, 32, 48, 64, 128, 256]
  const icoPngPaths = []
  for (const size of icoSizes) {
    const dest = path.join(iconsDir, `icon-${size}.png`)
    await sharp(iconSvg).resize(size, size).png({ compressionLevel: 9 }).toFile(dest)
    icoPngPaths.push(dest)
  }
  try {
    const pngToIcoMod = require('png-to-ico')
    const pngToIco = pngToIcoMod.default || pngToIcoMod.imagesToIco || pngToIcoMod
    const icoBuffer = await pngToIco(icoPngPaths)
    fs.writeFileSync(path.join(iconsDir, 'icon.ico'), icoBuffer)
    console.log('✓ icons/icon.ico generated (16, 32, 48, 64, 128, 256px, transparent)')
  } catch (e) {
    console.warn('  icons/icon.ico — skipped (png-to-ico not available):', e.message)
  }
  // Clean up intermediate PNGs
  for (const p of icoPngPaths) { try { fs.unlinkSync(p) } catch {} }

  // ── icons/icon.icns (macOS — requires iconutil) ──────────────────────────
  if (process.platform === 'darwin') {
    const { execSync } = require('child_process')
    const iconsetDir = path.join(iconsDir, 'icon.iconset')
    if (!fs.existsSync(iconsetDir)) fs.mkdirSync(iconsetDir)

    const icnsSizes = [16, 32, 64, 128, 256, 512, 1024]
    for (const size of icnsSizes) {
      await sharp(iconSvg).resize(size, size).png({ compressionLevel: 9 })
        .toFile(path.join(iconsetDir, `icon_${size}x${size}.png`))
      if (size * 2 <= 1024) {
        await sharp(iconSvg).resize(size * 2, size * 2).png({ compressionLevel: 9 })
          .toFile(path.join(iconsetDir, `icon_${size}x${size}@2x.png`))
      }
    }
    execSync(`iconutil -c icns "${iconsetDir}" -o "${path.join(iconsDir, 'icon.icns')}"`)
    fs.rmSync(iconsetDir, { recursive: true })
    console.log('✓ icons/icon.icns generated (transparent)')
  } else {
    console.log('  icons/icon.icns — skipped (requires macOS iconutil). Will be generated on macOS CI runner.')
  }

  // ── NSIS installer branding bitmaps ──────────────────────────────────
  // Rendered from SVG via sharp so we get crisp text at correct pixel sizes.

  // installerHeader: 150×57px — shown at top of each installer page
  {
    const W = 150, H = 57
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <rect width="${W}" height="${H}" fill="#F9FAFB"/>
      <!-- Logomark: 33×33 centred vertically, left-aligned with 12px margin -->
      <rect x="12" y="12" width="33" height="33" rx="6" fill="#DBEAFE"/>
      <rect x="20" y="20" width="17" height="3" rx="1" fill="#111827"/>
      <rect x="20" y="27" width="10" height="3" rx="1" fill="#3B82F6"/>
      <rect x="20" y="34" width="13" height="3" rx="1" fill="#E5E7EB"/>
    </svg>`
    const { data, info } = await sharp(Buffer.from(svg))
      .resize(W, H)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const pixels = []
    for (let i = 0; i < info.width * info.height; i++) {
      pixels.push({ r: data[i * 3], g: data[i * 3 + 1], b: data[i * 3 + 2] })
    }
    fs.writeFileSync(path.join(buildDir, 'installer-header.bmp'), writeBMP(W, H, pixels))
    console.log('✓ installer-header.bmp generated (150×57)')
  }

  // installerSidebar: 164×314px — shown on Welcome and Finish pages
  {
    const W = 164, H = 314
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <rect width="${W}" height="${H}" fill="#F9FAFB"/>
      <!-- Logomark: 60×60 centred horizontally at 28% from top -->
      <rect x="52" y="88" width="60" height="60" rx="10" fill="#DBEAFE"/>
      <rect x="65" y="101" width="34" height="5" rx="2" fill="#111827"/>
      <rect x="65" y="111" width="20" height="5" rx="2" fill="#3B82F6"/>
      <rect x="65" y="121" width="26" height="5" rx="2" fill="#E5E7EB"/>
      <!-- Wordmark -->
      <text x="82" y="178" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="bold" fill="#111827" text-anchor="middle" letter-spacing="-0.3">Framework</text>
      <!-- Tagline -->
      <text x="82" y="198" font-family="Arial, Helvetica, sans-serif" font-size="9" fill="#9CA3AF" text-anchor="middle">The system behind the trade.</text>
    </svg>`
    const { data, info } = await sharp(Buffer.from(svg))
      .resize(W, H)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const pixels = []
    for (let i = 0; i < info.width * info.height; i++) {
      pixels.push({ r: data[i * 3], g: data[i * 3 + 1], b: data[i * 3 + 2] })
    }
    fs.writeFileSync(path.join(buildDir, 'installer-sidebar.bmp'), writeBMP(W, H, pixels))
    console.log('✓ installer-sidebar.bmp generated (164×314)')
  }

  console.log('\nAll assets generated successfully.')
}

run().catch(e => { console.error(e); process.exit(1) })
