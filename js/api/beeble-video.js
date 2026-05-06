/**
 * Editly AI Editor: Beeble.ai SwitchX Video Generation
 * Background replacement with automatic alpha matting.
 * Endpoint: https://api.beeble.ai/v1
 * Auth: x-api-key header
 * No duration limit — processes full source video.
 */

var BeebleVideo = (function () {
  'use strict';

  var API_BASE = 'https://api.beeble.ai/v1';
  var POLL_INTERVALS = [5000, 5000, 8000, 10000, 10000, 15000];

  // ==================== UPLOAD TO BEEBLE ====================

  /**
   * Upload a local file to Beeble via presigned URL.
   * 1. POST /v1/uploads {filename} → {upload_url, beeble_uri}
   * 2. PUT file binary to upload_url
   * 3. Return beeble_uri
   */
  function uploadToBeeble(apiKey, filePath) {
    var fs = require('fs');
    var path = require('path');
    var https = require('https');
    var urlMod = require('url');

    var fileName = path.basename(filePath);
    var fileData = fs.readFileSync(filePath);
    var ext = path.extname(fileName).toLowerCase();

    // Determine content type
    var contentTypeMap = {
      '.mp4': 'video/mp4', '.mov': 'video/quicktime',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'
    };
    var contentType = contentTypeMap[ext] || 'application/octet-stream';

    console.log('[Beeble] Uploading ' + fileName + ' (' + (fileData.length / 1024 / 1024).toFixed(1) + ' MB)...');

    // Step 1: Get presigned upload URL
    return new Promise(function (resolve, reject) {
      var body = JSON.stringify({ filename: fileName });
      var parsed = urlMod.parse(API_BASE + '/uploads');

      var options = {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'Content-Length': Buffer.byteLength(body)
        }
      };

      var req = https.request(options, function (res) {
        var chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          try {
            var resp = JSON.parse(Buffer.concat(chunks).toString());
            if (resp.upload_url && resp.beeble_uri) {
              console.log('[Beeble] Got presigned URL, beeble_uri: ' + resp.beeble_uri);
              resolve({ uploadUrl: resp.upload_url, beebleUri: resp.beeble_uri });
            } else {
              reject(new Error('No upload_url in response: ' + JSON.stringify(resp).substring(0, 200)));
            }
          } catch (e) {
            reject(new Error('Upload URL parse error: ' + e.message));
          }
        });
      });
      req.on('error', function (err) { reject(new Error('Upload URL request error: ' + err.message)); });
      req.write(body);
      req.end();
    })
    .then(function (uploadInfo) {
      // Step 2: PUT file binary to presigned URL
      return new Promise(function (resolve, reject) {
        var parsed = urlMod.parse(uploadInfo.uploadUrl);
        var options = {
          hostname: parsed.hostname,
          port: 443,
          path: parsed.path,
          method: 'PUT',
          headers: {
            'Content-Type': contentType,
            'Content-Length': fileData.length
          }
        };

        console.log('[Beeble] Uploading file binary (' + fileData.length + ' bytes)...');

        var req = https.request(options, function (res) {
          var chunks = [];
          res.on('data', function (c) { chunks.push(c); });
          res.on('end', function () {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              console.log('[Beeble] File uploaded successfully');
              resolve(uploadInfo.beebleUri);
            } else {
              var respText = Buffer.concat(chunks).toString().substring(0, 200);
              reject(new Error('Beeble PUT failed (' + res.statusCode + '): ' + respText));
            }
          });
        });
        req.on('error', function (err) { reject(new Error('Beeble PUT error: ' + err.message)); });
        req.write(fileData);
        req.end();
      });
    });
  }

  // ==================== API CALLS ====================

  /**
   * Submit a Beeble SwitchX generation task.
   *
   * @param {object} opts
   * @param {string} opts.apiKey - Beeble API key
   * @param {string} opts.prompt - Text prompt
   * @param {string} opts.referenceImageBase64 - AI-generated preview (raw base64, no prefix)
   * @param {string} opts.videoFilePath - Source video chunk file path
   * @param {function} opts.onProgress - Progress callback
   * @returns {Promise<{success: boolean, taskId?: string, error?: string}>}
   */
  function submitTask(opts) {
    var onProgress = opts.onProgress || function () {};

    // Step 1: Upload source video to Beeble
    onProgress({ detail: 'Uploading video to Beeble...' });

    return uploadToBeeble(opts.apiKey, opts.videoFilePath)
      .then(function (sourceUri) {
        onProgress({ detail: 'Submitting to Beeble SwitchX...' });

        // Use data URI for reference image (avoids upload)
        var refImageUri = 'data:image/png;base64,' + opts.referenceImageBase64;

        var body = {
          generation_type: 'video',
          source_uri: sourceUri,
          reference_image_uri: refImageUri,
          alpha_mode: 'auto',
          max_resolution: 1080,
          prompt: opts.prompt || 'Change the background'
        };

        console.log('[Beeble] Submitting SwitchX task');
        console.log('[Beeble] source_uri: ' + sourceUri);

        return new Promise(function (resolve, reject) {
          var xhr = new XMLHttpRequest();
          xhr.open('POST', API_BASE + '/switchx/generations', true);
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.setRequestHeader('x-api-key', opts.apiKey);
          xhr.timeout = 60000;

          xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                var resp = JSON.parse(xhr.responseText);
                console.log('[Beeble] Submit response: ' + JSON.stringify(resp).substring(0, 300));

                if (resp.id) {
                  resolve({ success: true, taskId: resp.id });
                } else {
                  resolve({ success: false, error: 'No job ID: ' + JSON.stringify(resp).substring(0, 200) });
                }
              } catch (e) {
                reject(new Error('Parse error: ' + e.message));
              }
            } else {
              var errMsg = 'Beeble API error ' + xhr.status;
              try {
                var errBody = JSON.parse(xhr.responseText);
                if (errBody.message) errMsg += ': ' + errBody.message;
                else if (errBody.error) errMsg += ': ' + (typeof errBody.error === 'string' ? errBody.error : JSON.stringify(errBody.error));
                else if (errBody.detail) errMsg += ': ' + errBody.detail;
              } catch (e) {
                errMsg += ': ' + xhr.responseText.substring(0, 200);
              }
              reject(new Error(errMsg));
            }
          };

          xhr.onerror = function () { reject(new Error('Network error calling Beeble API')); };
          xhr.ontimeout = function () { reject(new Error('Beeble API timed out')); };
          xhr.send(JSON.stringify(body));
        });
      });
  }

  /**
   * Poll a Beeble job until completion.
   * GET /v1/switchx/generations/{id}
   * Statuses: in_queue, processing, completed, failed
   */
  function pollTask(apiKey, jobId, onProgress) {
    var url = API_BASE + '/switchx/generations/' + jobId;
    var pollCount = 0;
    var maxPolls = 200; // No duration limit, may take longer

    return new Promise(function (resolve, reject) {
      function poll() {
        if (pollCount >= maxPolls) {
          reject(new Error('Beeble task timed out after ' + maxPolls + ' polls'));
          return;
        }

        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('x-api-key', apiKey);
        xhr.timeout = 15000;

        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              var resp = JSON.parse(xhr.responseText);
              var status = (resp.status || 'unknown').toLowerCase();
              var progress = resp.progress || 0;

              console.log('[Beeble] Poll #' + pollCount + ': status=' + status + ' progress=' + progress + '%');

              if (onProgress) {
                onProgress({ status: status, progress: progress, pollCount: pollCount });
              }

              if (status === 'completed') {
                var videoUrl = null;
                if (resp.output && resp.output.render) {
                  videoUrl = resp.output.render;
                }
                console.log('[Beeble] Completed! render URL: ' + (videoUrl || 'NONE'));
                resolve({ success: true, videoUrl: videoUrl });
              } else if (status === 'failed') {
                var errMsg = resp.error || 'Beeble job failed';
                resolve({ success: false, error: errMsg });
              } else {
                // in_queue or processing — keep polling
                pollCount++;
                var interval = POLL_INTERVALS[Math.min(pollCount, POLL_INTERVALS.length - 1)];
                setTimeout(poll, interval);
              }
            } catch (e) {
              pollCount++;
              setTimeout(poll, 10000);
            }
          } else {
            pollCount++;
            setTimeout(poll, 10000);
          }
        };

        xhr.onerror = function () { pollCount++; setTimeout(poll, 10000); };
        xhr.ontimeout = function () { pollCount++; setTimeout(poll, 10000); };
        xhr.send();
      }

      poll();
    });
  }

  return {
    uploadToBeeble: uploadToBeeble,
    submitTask: submitTask,
    pollTask: pollTask
  };
})();
