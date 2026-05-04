/**
 * Editly AI Editor — GitHub Auto-Updater
 * Checks for new commits on main branch and auto-updates the plugin.
 *
 * How it works:
 * 1. Reads version.json for the last known commit SHA
 * 2. Fetches latest commit from GitHub API (no auth needed for public repos)
 * 3. If different, downloads the repo as ZIP and extracts over current install
 * 4. Updates version.json with new SHA
 */

var Updater = (function () {
  'use strict';

  var https = require('https');
  var fs = require('fs');
  var path = require('path');
  var childProcess = require('child_process');

  var REPO = 'mz1-mzone/editly-Ai-Cut-plugin';
  var BRANCH = 'main';
  var API_URL = '/repos/' + REPO + '/commits/' + BRANCH;

  function Updater(extensionPath) {
    this.extensionPath = extensionPath;
    this.versionFile = path.join(extensionPath, 'version.json');
  }

  /**
   * Check for updates and apply if available.
   * @param {function} onStatus - callback(message, type) for UI feedback
   * @returns {Promise<{updated: boolean, message: string}>}
   */
  Updater.prototype.checkAndUpdate = function (onStatus) {
    var self = this;
    onStatus = onStatus || function () {};

    return new Promise(function (resolve) {
      // Read current version
      var currentCommit = 'initial';
      try {
        var versionData = JSON.parse(fs.readFileSync(self.versionFile, 'utf8'));
        currentCommit = versionData.commit || 'initial';
      } catch (e) {
        console.log('[Updater] No version.json found, will update');
      }

      onStatus('Checking for updates...', 'info');
      console.log('[Updater] Current commit: ' + currentCommit);

      // Fetch latest commit from GitHub
      self._fetchLatestCommit().then(function (latestSha) {
        if (!latestSha) {
          console.log('[Updater] Could not reach GitHub, skipping update');
          resolve({ updated: false, message: 'Could not check for updates' });
          return;
        }

        console.log('[Updater] Latest commit: ' + latestSha);

        if (currentCommit === latestSha) {
          console.log('[Updater] Already up to date');
          resolve({ updated: false, message: 'Already up to date' });
          return;
        }

        // New version available — update via git pull or ZIP download
        onStatus('Update found! Downloading...', 'info');
        console.log('[Updater] New version available, updating...');

        self._performUpdate(latestSha).then(function (success) {
          if (success) {
            // Save new version
            try {
              fs.writeFileSync(self.versionFile, JSON.stringify({
                commit: latestSha,
                updated_at: new Date().toISOString().split('T')[0],
                repo: REPO
              }, null, 2), 'utf8');
            } catch (e) {
              console.log('[Updater] Could not save version.json:', e.message);
            }

            onStatus('Updated! Restart Premiere to apply.', 'success');
            resolve({ updated: true, message: 'Updated! Restart Premiere Pro to apply changes.' });
          } else {
            resolve({ updated: false, message: 'Update download failed' });
          }
        });
      });
    });
  };

  /**
   * Fetch the latest commit SHA from GitHub.
   */
  Updater.prototype._fetchLatestCommit = function () {
    return new Promise(function (resolve) {
      var options = {
        hostname: 'api.github.com',
        port: 443,
        path: API_URL,
        method: 'GET',
        headers: {
          'User-Agent': 'EditlyAICut-Updater/1.0',
          'Accept': 'application/vnd.github.v3+json'
        }
      };

      var req = https.request(options, function (res) {
        var data = '';
        res.on('data', function (chunk) { data += chunk; });
        res.on('end', function () {
          try {
            var parsed = JSON.parse(data);
            resolve(parsed.sha || null);
          } catch (e) {
            resolve(null);
          }
        });
      });

      req.on('error', function () { resolve(null); });
      req.setTimeout(10000, function () { req.destroy(); resolve(null); });
      req.end();
    });
  };

  /**
   * Perform the update — try git pull first, fall back to ZIP download.
   */
  Updater.prototype._performUpdate = function (commitSha) {
    var self = this;

    // Try git pull if .git exists
    var gitDir = path.join(self.extensionPath, '.git');
    if (fs.existsSync(gitDir)) {
      return self._gitPull();
    }

    // Otherwise download ZIP
    return self._downloadZip(commitSha);
  };

  /**
   * Git pull (if installed via git clone).
   */
  Updater.prototype._gitPull = function () {
    var self = this;
    return new Promise(function (resolve) {
      try {
        childProcess.execSync('git -C "' + self.extensionPath + '" pull origin ' + BRANCH, {
          encoding: 'utf8',
          timeout: 30000,
          stdio: 'pipe'
        });
        console.log('[Updater] git pull successful');
        resolve(true);
      } catch (e) {
        console.log('[Updater] git pull failed:', e.message);
        resolve(false);
      }
    });
  };

  /**
   * Download repo as ZIP and extract (fallback for non-git installs).
   */
  Updater.prototype._downloadZip = function (commitSha) {
    var self = this;
    var zipUrl = 'https://github.com/' + REPO + '/archive/refs/heads/' + BRANCH + '.zip';
    var tmpZip = path.join(self.extensionPath, '_update_' + Date.now() + '.zip');

    return new Promise(function (resolve) {
      self._downloadFile(zipUrl, tmpZip).then(function (downloaded) {
        if (!downloaded) { resolve(false); return; }

        try {
          // Extract ZIP — overwrites existing files
          childProcess.execSync('unzip -o "' + tmpZip + '" -d "' + self.extensionPath + '/_update_tmp"', {
            encoding: 'utf8', timeout: 30000, stdio: 'pipe'
          });

          // Move extracted files (repo extracts into a subfolder)
          var extractedDir = path.join(self.extensionPath, '_update_tmp', 'editly-Ai-Cut-plugin-' + BRANCH);
          if (fs.existsSync(extractedDir)) {
            // Copy each file/folder from extracted to extension root
            var items = fs.readdirSync(extractedDir);
            items.forEach(function (item) {
              // Skip settings and version
              if (item === 'config') return;
              if (item === 'version.json') return;

              var src = path.join(extractedDir, item);
              var dest = path.join(self.extensionPath, item);

              // Use cp -r for robust copy
              try {
                childProcess.execSync('cp -r "' + src + '" "' + dest + '"', {
                  encoding: 'utf8', timeout: 10000, stdio: 'pipe'
                });
              } catch (e) {
                console.log('[Updater] Copy failed for ' + item + ':', e.message);
              }
            });
          }

          // Cleanup
          try { childProcess.execSync('rm -rf "' + tmpZip + '" "' + self.extensionPath + '/_update_tmp"', { stdio: 'pipe' }); } catch (e) {}

          console.log('[Updater] ZIP update successful');
          resolve(true);
        } catch (e) {
          console.log('[Updater] ZIP extraction failed:', e.message);
          try { fs.unlinkSync(tmpZip); } catch (e2) {}
          resolve(false);
        }
      });
    });
  };

  /**
   * Download a file, following redirects.
   */
  Updater.prototype._downloadFile = function (fileUrl, destPath) {
    return new Promise(function (resolve) {
      var urlObj = require('url').parse(fileUrl);
      var options = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.path,
        method: 'GET',
        headers: { 'User-Agent': 'EditlyAICut-Updater/1.0' }
      };

      var req = https.request(options, function (res) {
        // Follow redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          var redirect = require('url').parse(res.headers.location);
          var req2 = https.request({
            hostname: redirect.hostname,
            port: 443,
            path: redirect.path,
            method: 'GET',
            headers: { 'User-Agent': 'EditlyAICut-Updater/1.0' }
          }, function (res2) {
            var fileStream = fs.createWriteStream(destPath);
            res2.pipe(fileStream);
            fileStream.on('finish', function () { fileStream.close(); resolve(true); });
          });
          req2.on('error', function () { resolve(false); });
          req2.setTimeout(60000, function () { req2.destroy(); resolve(false); });
          req2.end();
          return;
        }

        var fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on('finish', function () { fileStream.close(); resolve(true); });
      });

      req.on('error', function () { resolve(false); });
      req.setTimeout(60000, function () { req.destroy(); resolve(false); });
      req.end();
    });
  };

  return Updater;
})();

if (typeof window !== 'undefined') {
  window.Updater = Updater;
}
