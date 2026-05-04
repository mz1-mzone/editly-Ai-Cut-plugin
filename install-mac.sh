#!/bin/bash
# ============================================
# Editly AI Editor Mac Installer
# One-command install for Adobe Premiere Pro
# ============================================

set -e

PLUGIN_NAME="EditlyPlugin"
CEP_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
INSTALL_DIR="$CEP_DIR/$PLUGIN_NAME"
REPO_URL="https://github.com/mz1-mzone/editly-Ai-Cut-plugin.git"

echo ""
echo "╔═══════════════════════════════════════╗"
echo "║     Editly AI Editor Installer         ║"
echo "║     AI-Powered Video Editor           ║"
echo "╚═══════════════════════════════════════╝"
echo ""

# Check for git
if ! command -v git &> /dev/null; then
    echo "❌ git is not installed."
    echo "   Install it: xcode-select --install"
    exit 1
fi

# Check for ffmpeg
if ! command -v /usr/local/bin/ffmpeg &> /dev/null; then
    echo "⚠️  ffmpeg not found at /usr/local/bin/ffmpeg"
    echo "   Install it: brew install ffmpeg"
    echo "   (Continuing anyway the plugin needs ffmpeg to work)"
    echo ""
fi

# Create CEP extensions directory if needed
mkdir -p "$CEP_DIR"

# Install or update
if [ -d "$INSTALL_DIR/.git" ]; then
    echo "🔄 Updating existing installation..."
    cd "$INSTALL_DIR"
    git pull origin main
    echo ""
    echo "✅ Updated successfully!"
else
    if [ -d "$INSTALL_DIR" ]; then
        echo "⚠️  Existing install found (non-git). Backing up..."
        mv "$INSTALL_DIR" "${INSTALL_DIR}_backup_$(date +%s)"
    fi

    echo "📥 Downloading plugin..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    echo ""
    echo "✅ Installed successfully!"
fi

# Enable unsigned CEP extensions (required for custom plugins)
echo ""
echo "🔧 Enabling unsigned extensions..."
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1

echo ""
echo "═══════════════════════════════════════"
echo "✅ Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Restart Adobe Premiere Pro"
echo "  2. Go to: Window → Extensions → Editly AI Editor"
echo "  3. Click ⚙ Settings and enter your API keys:"
echo "     • ElevenLabs API Key (for transcription)"
echo "     • Anthropic API Key (for AI editing)"
echo ""
echo "  The plugin auto-updates from GitHub!"
echo "═══════════════════════════════════════"
echo ""
