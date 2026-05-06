/**
 * Editly AI Editor: Kling Motion Control Video Generation
 * Async task-based API with JWT authentication (Access Key + Secret Key).
 * Docs: https://kling.ai/document-api/apiReference/model/motionControl
 * Base URL: https://api.klingai.com
 *
 * Kling requires publicly accessible URLs for image_url and video_url.
 * We use tmpfiles.org (free, no-auth, 60min expiry) to host files temporarily.
 */

var KlingVideo = (function () {
  'use strict';

  var API_BASE = 'https://api.klingai.com/v1';
  var UPLOAD_URL = 'https://tmpfiles.org/api/v1/upload';
  var POLL_INTERVALS = [10000, 15000, 20000, 30000, 30000];
  var MIN_DURATION = 3;
  var MAX_DURATION = 30;

  // ==================== JWT TOKEN GENERATION ====================

  function generateJWT(accessKey, secretKey) {
    var crypto = require('crypto');
    var now = Math.floor(Date.now() / 1000);

    var header = { alg: 'HS256', typ: 'JWT' };
    var payload = {
      iss: accessKey,
      exp: now + 1800,
      nbf: now - 5
    };

    function base64url(obj) {
      var str = typeof obj === 'string' ? obj : JSON.stringify(obj);
      return Buffer.from(str)
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    }

    var headerB64 = base64url(header);
    var payloadB64 = base64url(payload);
    var signingInput = headerB64 + '.' + payloadB64;

    var signature = crypto
      .createHmac('sha256', secretKey)
      .update(signingInput)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    return signingInput + '.' + signature;
  }

  // ==================== FILE UPLOAD (tmpfiles.org) ====================

  /**
   * Upload a local file to tmpfiles.org and get a direct download URL.
   * tmpfiles.org response: { status: "success", data: { url: "https://tmpfiles.org/XXXXX/file.ext" } }
   * Direct download URL: replace tmpfiles.org/ with tmpfiles.org/dl/
   *
   * @param {string} filePath - Local file path
   * @returns {Promise<string>} - Public download URL
   */
  function uploadFile(filePath) {
    return new Promise(function (resolve, reject) {
      var fs = require('fs');
      var path = require('path');
      var https = require('https');
      var url = require('url');

      var fileName = path.basename(filePath);
      var fileData = fs.readFileSync(filePath);
      var boundary = '----EditlyBoundary' + Date.now();

      // Build multipart form data
      var bodyParts = [];
      bodyParts.push(Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="file"; filename="' + fileName + '"\r\n' +
        'Content-Type: application/octet-stream\r\n\r\n'
      ));
      bodyParts.push(fileData);
      bodyParts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));

      var body = Buffer.concat(bodyParts);

      var parsed = url.parse(UPLOAD_URL);
      var options = {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.path,
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': body.length
        }
      };

      console.log('[Kling] Uploading ' + fileName + ' (' + (fileData.length / 1024 / 1024).toFixed(1) + ' MB) to tmpfiles.org...');

      var req = https.request(options, function (res) {
        var chunks = [];
        res.on('data', function (chunk) { chunks.push(chunk); });
        res.on('end', function () {
          try {
            var responseText = Buffer.concat(chunks).toString();
            var resp = JSON.parse(responseText);

            if (resp.status === 'success' && resp.data && resp.data.url) {
              // Convert page URL to direct download URL
              // tmpfiles.org/12345/file.mp4 → tmpfiles.org/dl/12345/file.mp4
              var directUrl = resp.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
              console.log('[Kling] Uploaded: ' + directUrl);
              resolve(directUrl);
            } else {
              reject(new Error('Upload failed: ' + responseText.substring(0, 200)));
            }
          } catch (e) {
            reject(new Error('Upload response parse error: ' + e.message));
          }
        });
      });

      req.on('error', function (err) {
        reject(new Error('Upload network error: ' + err.message));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Save base64 image data to a temporary file.
   * @param {string} base64Data - Raw base64 image data
   * @param {string} ext - File extension (e.g. 'png', 'jpg')
   * @returns {string} - Path to temp file
   */
  function saveBase64ToTempFile(base64Data, ext) {
    var fs = require('fs');
    var os = require('os');
    var tempDir = os.tmpdir() + '/editly_vfx';
    try { fs.mkdirSync(tempDir, { recursive: true }); } catch (e) {}
    var filePath = tempDir + '/upload_' + Date.now() + '.' + (ext || 'png');
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    return filePath;
  }

  // ==================== API CALLS ====================

  /**
   * Submit a Motion Control video generation task.
   * POST /v1/videos/motion-control
   *
   * Steps:
   * 1. Upload reference image to tmpfiles.org → get image_url
   * 2. Upload video chunk to tmpfiles.org → get video_url
   * 3. Submit to Kling with both URLs
   *
   * @param {object} opts
   * @param {string} opts.accessKey
   * @param {string} opts.secretKey
   * @param {string} opts.referenceImageBase64 - AI image (raw base64)
   * @param {string} opts.videoFilePath - Local path to video chunk
   * @param {string} opts.prompt
   * @param {number} opts.duration - Duration in seconds (3-30)
   * @param {function} opts.onProgress - Progress callback
   * @returns {Promise<{success: boolean, taskId?: string, error?: string}>}
   */
  function submitTask(opts) {
    var onProgress = opts.onProgress || function () {};

    // Step 1: Save image base64 to temp file
    onProgress({ detail: 'Preparing image...' });
    var imageTempPath = saveBase64ToTempFile(opts.referenceImageBase64, 'png');

    // Step 2: Upload both files to get URLs
    onProgress({ detail: 'Uploading image...' });

    return uploadFile(imageTempPath)
      .then(function (imageUrl) {
        onProgress({ detail: 'Uploading video...' });
        return uploadFile(opts.videoFilePath).then(function (videoUrl) {
          return { imageUrl: imageUrl, videoUrl: videoUrl };
        });
      })
      .then(function (urls) {
        onProgress({ detail: 'Submitting to Kling AI...' });

        var token = generateJWT(opts.accessKey, opts.secretKey);
        var duration = Math.max(MIN_DURATION, Math.min(opts.duration || 5, MAX_DURATION));

        var body = {
          model_name: 'kling-v3',
          image_url: urls.imageUrl,
          video_url: urls.videoUrl,
          character_orientation: 'image',
          mode: 'pro',
          prompt: opts.prompt || '',
          keep_original_sound: 'yes',
          callback_url: '',
          external_task_id: ''
        };

        console.log('[Kling] Submitting motion-control task');
        console.log('[Kling] image_url: ' + urls.imageUrl);
        console.log('[Kling] video_url: ' + urls.videoUrl);

        return new Promise(function (resolve, reject) {
          var xhr = new XMLHttpRequest();
          xhr.open('POST', API_BASE + '/videos/motion-control', true);
          xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
          xhr.setRequestHeader('Authorization', 'Bearer ' + token);
          xhr.timeout = 60000;

          xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                var resp = JSON.parse(xhr.responseText);
                console.log('[Kling] Submit response:', JSON.stringify(resp).substring(0, 300));

                var taskId = null;
                if (resp.data && resp.data.task_id) taskId = resp.data.task_id;
                else if (resp.task_id) taskId = resp.task_id;

                if (taskId) {
                  resolve({ success: true, taskId: taskId });
                } else if (resp.code && resp.code !== 0) {
                  resolve({ success: false, error: 'Kling error ' + resp.code + ': ' + (resp.message || 'Unknown') });
                } else {
                  resolve({ success: false, error: 'No task_id: ' + JSON.stringify(resp).substring(0, 200) });
                }
              } catch (e) {
                reject(new Error('Parse error: ' + e.message));
              }
            } else {
              var errMsg = 'Kling API error ' + xhr.status;
              try {
                var errBody = JSON.parse(xhr.responseText);
                if (errBody.message) errMsg += ': ' + errBody.message;
              } catch (e) {
                errMsg += ': ' + xhr.responseText.substring(0, 200);
              }
              reject(new Error(errMsg));
            }
          };

          xhr.onerror = function () { reject(new Error('Network error calling Kling API')); };
          xhr.ontimeout = function () { reject(new Error('Kling API timed out')); };
          xhr.send(JSON.stringify(body));
        });
      });
  }

  /**
   * Poll a task until completion or failure.
   * GET /v1/videos/motion-control/{task_id}
   */
  function pollTask(accessKey, secretKey, taskId, onProgress) {
    var url = API_BASE + '/videos/motion-control/' + taskId;
    var pollCount = 0;
    var maxPolls = 120;

    return new Promise(function (resolve, reject) {
      function poll() {
        if (pollCount >= maxPolls) {
          reject(new Error('Task timed out after ' + maxPolls + ' polls'));
          return;
        }

        var token = generateJWT(accessKey, secretKey);

        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.timeout = 15000;

        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              var resp = JSON.parse(xhr.responseText);
              var taskData = resp.data || resp;
              var status = (taskData.task_status || taskData.status || 'unknown').toLowerCase();
              var progress = taskData.task_progress || taskData.progress || 0;

              console.log('[Kling] Poll #' + pollCount + ': status=' + status);

              if (onProgress) {
                onProgress({ status: status, progress: progress, pollCount: pollCount });
              }

              if (status === 'completed' || status === 'succeed') {
                var videoUrl = null;
                if (taskData.task_result && taskData.task_result.videos) {
                  var videos = taskData.task_result.videos;
                  if (videos.length > 0 && videos[0].url) {
                    videoUrl = videos[0].url;
                  }
                }
                resolve({ success: true, videoUrl: videoUrl });
              } else if (status === 'failed' || status === 'error') {
                var errMsg = taskData.task_status_msg || taskData.error || 'Task failed';
                resolve({ success: false, error: errMsg });
              } else {
                pollCount++;
                var interval = POLL_INTERVALS[Math.min(pollCount, POLL_INTERVALS.length - 1)];
                setTimeout(poll, interval);
              }
            } catch (e) {
              pollCount++;
              setTimeout(poll, 15000);
            }
          } else {
            pollCount++;
            setTimeout(poll, 15000);
          }
        };

        xhr.onerror = function () { pollCount++; setTimeout(poll, 15000); };
        xhr.ontimeout = function () { pollCount++; setTimeout(poll, 15000); };
        xhr.send();
      }

      poll();
    });
  }

  /**
   * Download a video from URL to a local file.
   */
  function downloadVideo(videoUrl, outputPath) {
    return new Promise(function (resolve, reject) {
      var https = require('https');
      var http = require('http');
      var fs = require('fs');
      var client = videoUrl.indexOf('https') === 0 ? https : http;

      var file = fs.createWriteStream(outputPath);
      client.get(videoUrl, function (response) {
        if (response.statusCode === 301 || response.statusCode === 302) {
          downloadVideo(response.headers.location, outputPath).then(resolve).catch(reject);
          return;
        }
        response.pipe(file);
        file.on('finish', function () {
          file.close();
          console.log('[Kling] Video downloaded to: ' + outputPath);
          resolve(true);
        });
      }).on('error', function (err) {
        fs.unlink(outputPath, function () {});
        reject(new Error('Download failed: ' + err.message));
      });
    });
  }

  /**
   * Calculate split points for a clip (min 3s, max 30s per chunk).
   */
  function calculateSplits(duration, maxChunk) {
    maxChunk = maxChunk || MAX_DURATION;
    var chunks = [];
    var start = 0;
    var idx = 0;
    while (start < duration) {
      var end = Math.min(start + maxChunk, duration);
      var chunkDur = end - start;
      if (chunkDur < MIN_DURATION && chunks.length > 0) {
        chunks[chunks.length - 1].end = end;
        chunks[chunks.length - 1].duration = chunks[chunks.length - 1].end - chunks[chunks.length - 1].start;
      } else {
        chunks.push({ start: start, end: end, index: idx, duration: chunkDur });
        idx++;
      }
      start = end;
    }
    return chunks;
  }

  return {
    generateJWT: generateJWT,
    uploadFile: uploadFile,
    submitTask: submitTask,
    pollTask: pollTask,
    downloadVideo: downloadVideo,
    calculateSplits: calculateSplits
  };
})();
