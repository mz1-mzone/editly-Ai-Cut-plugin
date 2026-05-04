/**
 * Editly AI Cut — Audio Utilities
 * File handling helpers for the CEP Node.js environment.
 */

var AudioUtils = (function () {
  'use strict';

  var fs = require('fs');
  var path = require('path');

  return {
    /**
     * Read a file and return its base64 encoding.
     */
    readFileAsBase64: function (filePath) {
      return new Promise(function (resolve, reject) {
        fs.readFile(filePath, function (err, data) {
          if (err) return reject(err);
          resolve(data.toString('base64'));
        });
      });
    },

    /**
     * Get file size in bytes.
     */
    getFileSize: function (filePath) {
      try {
        var stats = fs.statSync(filePath);
        return stats.size;
      } catch (e) {
        return -1;
      }
    },

    /**
     * Check if a file exists.
     */
    fileExists: function (filePath) {
      try {
        fs.accessSync(filePath, fs.constants.F_OK);
        return true;
      } catch (e) {
        return false;
      }
    },

    /**
     * Delete temp files.
     */
    cleanupTempFiles: function (filePaths) {
      filePaths.forEach(function (fp) {
        try {
          if (fs.existsSync(fp)) {
            fs.unlinkSync(fp);
          }
        } catch (e) {
          console.warn('Failed to delete temp file:', fp, e.message);
        }
      });
    },

    /**
     * Wait for a file to appear on disk (e.g., after AME export).
     * Polls every second for up to maxWaitSeconds.
     */
    waitForFile: function (filePath, maxWaitSeconds) {
      maxWaitSeconds = maxWaitSeconds || 120;
      var intervalMs = 1000;
      var elapsed = 0;

      return new Promise(function (resolve, reject) {
        var check = setInterval(function () {
          elapsed += intervalMs / 1000;

          if (fs.existsSync(filePath)) {
            // Wait a bit more to ensure file is fully written
            setTimeout(function () {
              var size = 0;
              try { size = fs.statSync(filePath).size; } catch (e) {}
              if (size > 0) {
                clearInterval(check);
                resolve({ path: filePath, size: size, waitedSeconds: elapsed });
              }
            }, 500);
          }

          if (elapsed >= maxWaitSeconds) {
            clearInterval(check);
            reject(new Error('Timed out waiting for file: ' + filePath));
          }
        }, intervalMs);
      });
    },

    /**
     * Format bytes to human-readable string.
     */
    formatBytes: function (bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1048576).toFixed(1) + ' MB';
    }
  };
})();

if (typeof window !== 'undefined') {
  window.AudioUtils = AudioUtils;
}
