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
  // sharp doesn't natively write .ico — generate PNGs at each size then
  // use the ico package or an online tool. We write the largest PNG as a
  // fallback; electron-builder will use icon.png if icon.ico is absent.
  const icoSizes = [16, 32, 48, 64, 128, 256]
  const icoFrames = []
  for (const size of icoSizes) {
    const buf = await sharp(srcIcon).resize(size, size).png().toBuffer()
    icoFrames.push({ size, buf })
    // Also save individual PNGs for manual ICO assembly
    await sharp(srcIcon)
      .resize(size, size)
      .png()
      .toFile(path.join(buildDir, `icon-${size}.png`))
  }
  console.log('✓ icon PNG sizes generated (16–256px) — assemble into icon.ico manually or via ico-package')
  console.log('  Tip: npm install --save-dev png-to-ico')
  console.log('  Then: node -e "require(\'png-to-ico\')([...]).then(b => require(\'fs\').writeFileSync(\'build/icon.ico\', b))"')

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

  console.log('\nAll assets generated successfully.')
}

run().catch(e => { console.error(e); process.exit(1) })
