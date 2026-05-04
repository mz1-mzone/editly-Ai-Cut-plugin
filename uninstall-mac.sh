#!/bin/bash
# ============================================
# Editly AI Editor Mac Uninstaller
# ============================================

INSTALL_DIR="/Library/Application Support/Adobe/CEP/extensions/EditlyPlugin"
USER_INSTALL="$HOME/Library/Application Support/Adobe/CEP/extensions/EditlyPlugin"

echo ""
echo "╔═══════════════════════════════════════╗"
echo "║     Editly AI Editor Uninstaller       ║"
echo "╚═══════════════════════════════════════╝"
echo ""

FOUND=false

if [ -d "$INSTALL_DIR" ]; then
    echo "Found installation at: $INSTALL_DIR"
    sudo rm -rf "$INSTALL_DIR"
    echo "✅ Removed."
    FOUND=true
fi

if [ -d "$USER_INSTALL" ]; then
    echo "Found installation at: $USER_INSTALL"
    rm -rf "$USER_INSTALL"
    echo "✅ Removed."
    FOUND=true
fi

if [ "$FOUND" = false ]; then
    echo "❌ Editly AI Editor not found. Already uninstalled?"
fi

# Clean up pkg receipt
sudo pkgutil --forget com.editly.aicut.pkg 2>/dev/null

echo ""
echo "Done! Restart Premiere Pro to complete removal."
echo ""
