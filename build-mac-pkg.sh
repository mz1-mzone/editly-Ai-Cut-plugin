#!/bin/bash
# ============================================
# Editly AI Editor — macOS .pkg Builder
# Builds a distributable installer package
# ============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_NAME="EditlyPlugin"
BUNDLE_ID="com.editly.aicut"
VERSION="1.0.0"
PKG_NAME="EditlyAIEditor"
BUILD_DIR="$SCRIPT_DIR/build"
STAGING_DIR="$BUILD_DIR/staging"
SCRIPTS_DIR="$BUILD_DIR/scripts"
INSTALL_LOCATION="/Library/Application Support/Adobe/CEP/extensions/$PLUGIN_NAME"

echo ""
echo "╔═══════════════════════════════════════╗"
echo "║  Editly AI Editor — Package Builder   ║"
echo "║  macOS .pkg Installer                 ║"
echo "╚═══════════════════════════════════════╝"
echo ""

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$STAGING_DIR" "$SCRIPTS_DIR"

echo "📦 Staging plugin files..."

# Copy plugin files to staging (exclude dev/sensitive files)
rsync -a \
  --exclude='.git' \
  --exclude='.gitignore' \
  --exclude='.debug' \
  --exclude='.DS_Store' \
  --exclude='AudioTest' \
  --exclude='config/settings.json' \
  --exclude='build' \
  --exclude='*.pkg' \
  --exclude='*.dmg' \
  --exclude='*.psd' \
  --exclude='*.mp4' \
  --exclude='*.mov' \
  --exclude='*.wav' \
  --exclude='*.mp3' \
  --exclude='build-mac-pkg.sh' \
  "$SCRIPT_DIR/" "$STAGING_DIR/"

# Create settings.json from example if it doesn't exist in staging
if [ ! -f "$STAGING_DIR/config/settings.json" ]; then
  cp "$STAGING_DIR/config/settings.example.json" "$STAGING_DIR/config/settings.json"
fi

echo "📝 Creating install scripts..."

# Post-install script: enable unsigned CEP extensions + set permissions
cat > "$SCRIPTS_DIR/postinstall" << 'POSTINSTALL'
#!/bin/bash
# Enable unsigned CEP extensions for all CSXS versions
for ver in 8 9 10 11 12 13 14 15; do
  defaults write com.adobe.CSXS.$ver PlayerDebugMode 1 2>/dev/null || true
done

# Also set for the current user (some Premiere versions check user defaults)
CURRENT_USER=$(stat -f '%Su' /dev/console 2>/dev/null || echo "$USER")
if [ -n "$CURRENT_USER" ] && [ "$CURRENT_USER" != "root" ]; then
  su "$CURRENT_USER" -c 'for ver in 8 9 10 11 12 13 14 15; do defaults write com.adobe.CSXS.$ver PlayerDebugMode 1 2>/dev/null || true; done'
fi

# Set permissions so the plugin can write settings
INSTALL_DIR="/Library/Application Support/Adobe/CEP/extensions/EditlyPlugin"
chmod -R 755 "$INSTALL_DIR" 2>/dev/null || true
chmod 666 "$INSTALL_DIR/config/settings.json" 2>/dev/null || true
chmod 666 "$INSTALL_DIR/version.json" 2>/dev/null || true

exit 0
POSTINSTALL
chmod +x "$SCRIPTS_DIR/postinstall"

echo "🔨 Building component package..."

# Build component .pkg
pkgbuild \
  --root "$STAGING_DIR" \
  --identifier "$BUNDLE_ID" \
  --version "$VERSION" \
  --install-location "$INSTALL_LOCATION" \
  --scripts "$SCRIPTS_DIR" \
  "$BUILD_DIR/$PKG_NAME-component.pkg"

echo "📋 Creating distribution XML..."

# Create distribution XML for productbuild
cat > "$BUILD_DIR/distribution.xml" << DISTXML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>Editly AI Editor</title>
    <organization>com.editly</organization>
    <domains enable_localSystem="true"/>
    <options customize="never" require-scripts="true" rootVolumeOnly="true" />

    <welcome file="welcome.html" />
    <conclusion file="conclusion.html" />

    <choices-outline>
        <line choice="default">
            <line choice="$BUNDLE_ID"/>
        </line>
    </choices-outline>

    <choice id="default"/>
    <choice id="$BUNDLE_ID" visible="false">
        <pkg-ref id="$BUNDLE_ID"/>
    </choice>

    <pkg-ref id="$BUNDLE_ID"
             version="$VERSION"
             onConclusion="none">$PKG_NAME-component.pkg</pkg-ref>
</installer-gui-script>
DISTXML

# Create welcome HTML
cat > "$BUILD_DIR/welcome.html" << 'WELCOME'
<!DOCTYPE html>
<html>
<head><style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 20px; color: #333; }
h1 { color: #9d5cff; font-size: 24px; }
.feature { margin: 8px 0; padding: 4px 0; }
.badge { display: inline-block; background: #f0e6ff; color: #7c3aed; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; margin-right: 4px; }
</style></head>
<body>
<h1>✨ Editly AI Editor</h1>
<p><strong>AI-Powered Story Editor & VFX Studio for Adobe Premiere Pro</strong></p>
<div class="feature"><span class="badge">AI</span> Claude AI story editing with auto filler detection</div>
<div class="feature"><span class="badge">VFX</span> Kling 3.0 · Seedance 2.0 · Beeble SwitchX</div>
<div class="feature"><span class="badge">IMG</span> Gemini AI image generation</div>
<div class="feature"><span class="badge">🌍</span> Arabic language support</div>
<p style="margin-top: 16px; color: #666; font-size: 13px;">
<strong>Requirements:</strong> Premiere Pro 2022+, ffmpeg (<code>brew install ffmpeg</code>)
</p>
</body>
</html>
WELCOME

# Create conclusion HTML
cat > "$BUILD_DIR/conclusion.html" << 'CONCLUSION'
<!DOCTYPE html>
<html>
<head><style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 20px; color: #333; }
h1 { color: #22c55e; font-size: 24px; }
.step { margin: 10px 0; padding: 8px 12px; background: #f8f9fa; border-radius: 6px; border-left: 3px solid #9d5cff; }
code { background: #e8e8e8; padding: 1px 6px; border-radius: 3px; font-size: 13px; }
</style></head>
<body>
<h1>✅ Installation Complete!</h1>
<div class="step"><strong>Step 1:</strong> Restart Adobe Premiere Pro</div>
<div class="step"><strong>Step 2:</strong> Go to <code>Window → Extensions → Editly AI Editor</code></div>
<div class="step"><strong>Step 3:</strong> Click ⚙ Settings and enter your API keys</div>
<p style="margin-top: 16px; color: #666; font-size: 13px;">
<strong>ffmpeg required:</strong> If not installed, run <code>brew install ffmpeg</code> in Terminal.
</p>
</body>
</html>
CONCLUSION

echo "📦 Building distribution package..."

# Build final distribution .pkg
productbuild \
  --distribution "$BUILD_DIR/distribution.xml" \
  --resources "$BUILD_DIR" \
  --package-path "$BUILD_DIR" \
  "$SCRIPT_DIR/$PKG_NAME.pkg"

echo ""
echo "═══════════════════════════════════════"
echo "✅ Package built: $PKG_NAME.pkg"
echo "   Size: $(du -h "$SCRIPT_DIR/$PKG_NAME.pkg" | cut -f1)"
echo ""
echo "To sign (requires Apple Developer ID):"
echo "  productsign --sign 'Developer ID Installer: YOUR_NAME' \\"
echo "    $PKG_NAME.pkg $PKG_NAME-signed.pkg"
echo ""
echo "To notarize:"
echo "  xcrun notarytool submit $PKG_NAME-signed.pkg \\"
echo "    --apple-id YOUR_APPLE_ID \\"
echo "    --team-id YOUR_TEAM_ID \\"
echo "    --password YOUR_APP_SPECIFIC_PASSWORD --wait"
echo "  xcrun stapler staple $PKG_NAME-signed.pkg"
echo "═══════════════════════════════════════"
echo ""

# Clean up build directory
rm -rf "$BUILD_DIR"
echo "🧹 Build directory cleaned."
