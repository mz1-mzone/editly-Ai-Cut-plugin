/**
 * Editly AI Editor: Kling Motion Control Video Generation
 * Async task-based API with JWT authentication (Access Key + Secret Key).
 * Base URL: https://api-singapore.klingai.com
 */

var KlingVideo = (function () {
  'use strict';

  var API_BASE = 'https://api-singapore.klingai.com/v1';
  var POLL_INTERVALS = [10000, 15000, 20000, 30000, 30000]; // escalating poll times
  var MIN_DURATION = 3;
  var MAX_DURATION = 30;

  // ==================== JWT TOKEN GENERATION ====================

  /**
   * Generate a JWT token for Kling API auth using HS256.
   * @param {string} accessKey - Kling Access Key (AK)
   * @param {string} secretKey - Kling Secret Key (SK)
   * @returns {string} JWT token
   */
  function generateJWT(accessKey, secretKey) {
    var crypto = require('crypto');
    var now = Math.floor(Date.now() / 1000);

    // Header
    var header = { alg: 'HS256', typ: 'JWT' };

    // Payload
    var payload = {
      iss: accessKey,
      exp: now + 1800,  // 30 min expiry
      nbf: now - 5      // valid from 5s ago
    };

    // Base64url encode
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

    // HMAC-SHA256 signature
    var signature = crypto
      .createHmac('sha256', secretKey)
      .update(signingInput)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    return signingInput + '.' + signature;
  }

  // ==================== FILE HOSTING (temp HTTP server) ====================

  /**
   * Start a temporary local HTTP server to serve files to Kling API.
   * Kling requires URLs for image/video, so we serve them locally.
   * Returns a promise with the server info.
   * @param {string} filePath - File to serve
   * @param {number} port - Port to use
   * @returns {{url: string, close: function}}
   */
  function serveFile(filePath, port) {
    // Since Kling needs publicly accessible URLs, we'll use base64 data URIs
    // or upload to a temporary file hosting service.
    // For now, we'll encode as base64 and use inline data.
    var fs = require('fs');
    var buffer = fs.readFileSync(filePath);
    var ext = filePath.split('.').pop().toLowerCase();
    var mime = ext === 'mp4' ? 'video/mp4' : ext === 'mov' ? 'video/quicktime' :
               ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
    return {
      base64: buffer.toString('base64'),
      mime: mime,
      dataUri: 'data:' + mime + ';base64,' + buffer.toString('base64')
    };
  }

  // ==================== API CALLS ====================

  /**
   * Submit a Motion Control video generation task.
   * @param {object} opts
   * @param {string} opts.accessKey - Kling Access Key
   * @param {string} opts.secretKey - Kling Secret Key
   * @param {string} opts.referenceImageBase64 - AI-generated image (from Gemini), base64
   * @param {string} opts.videoFilePath - Local path to the source video chunk
   * @param {string} opts.prompt - Effect description
   * @param {number} opts.duration - Duration in seconds (3-30)
   * @returns {Promise<{success: boolean, taskId?: string, error?: string}>}
   */
  function submitTask(opts) {
    var url = API_BASE + '/videos/motion-control';
    var token = generateJWT(opts.accessKey, opts.secretKey);

    // Read video file
    var videoData = serveFile(opts.videoFilePath, 0);

    // Clamp duration to valid range
    var duration = Math.max(MIN_DURATION, Math.min(opts.duration || 5, MAX_DURATION));

    var body = {
      model_name: 'kling-v2-6',
      image: 'data:image/png;base64,' + opts.referenceImageBase64,
      video: videoData.dataUri,
      prompt: opts.prompt || '',
      duration: String(duration),
      keep_original_sound: true
    };

    console.log('[Kling] Submitting motion-control task, duration: ' + duration + 's');

    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.timeout = 120000; // 2 min for large uploads

      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            var resp = JSON.parse(xhr.responseText);
            console.log('[Kling] Response:', JSON.stringify(resp).substring(0, 200));

            // Parse task_id from various response shapes
            var taskId = null;
            if (resp.data && resp.data.task_id) taskId = resp.data.task_id;
            else if (resp.task_id) taskId = resp.task_id;

            if (taskId) {
              console.log('[Kling] Task submitted: ' + taskId);
              resolve({ success: true, taskId: taskId });
            } else {
              resolve({ success: false, error: 'No task_id in response: ' + JSON.stringify(resp).substring(0, 200) });
            }
          } catch (e) {
            reject(new Error('Parse error: ' + e.message));
          }
        } else {
          var errMsg = 'Kling API error ' + xhr.status;
          try {
            var errBody = JSON.parse(xhr.responseText);
            if (errBody.message) errMsg += ': ' + errBody.message;
            else if (errBody.error) errMsg += ': ' + (errBody.error.message || errBody.error);
          } catch (e) {
            errMsg += ': ' + xhr.responseText.substring(0, 200);
          }
          reject(new Error(errMsg));
        }
      };

      xhr.onerror = function () { reject(new Error('Network error calling Kling API')); };
      xhr.ontimeout = function () { reject(new Error('Kling API submit timed out (2 min)')); };
      xhr.send(JSON.stringify(body));
    });
  }

  /**
   * Poll a task until completion or failure.
   * @param {string} accessKey
   * @param {string} secretKey
   * @param {string} taskId
   * @param {function} onProgress - Called with status updates
   * @returns {Promise<{success: boolean, videoUrl?: string, error?: string}>}
   */
  function pollTask(accessKey, secretKey, taskId, onProgress) {
    var url = API_BASE + '/videos/motion-control/' + taskId;
    var pollCount = 0;
    var maxPolls = 120; // ~30 min max

    return new Promise(function (resolve, reject) {
      function poll() {
        if (pollCount >= maxPolls) {
          reject(new Error('Task timed out after ' + maxPolls + ' polls'));
          return;
        }

        // Generate fresh JWT for each poll (in case of expiry)
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
              var progress = taskData.progress || taskData.task_progress || 0;

              console.log('[Kling] Poll #' + pollCount + ': ' + status + ' (' + progress + '%)');

              if (onProgress) {
                onProgress({ status: status, progress: progress, pollCount: pollCount });
              }

              if (status === 'completed' || status === 'succeed') {
                // Extract video URL from response
                var videoUrl = null;
                if (taskData.task_result && taskData.task_result.videos) {
                  var videos = taskData.task_result.videos;
                  if (videos.length > 0 && videos[0].url) {
                    videoUrl = videos[0].url;
                  }
                } else if (taskData.output && taskData.output.video_url) {
                  videoUrl = taskData.output.video_url;
                } else if (taskData.video_url) {
                  videoUrl = taskData.video_url;
                }
                resolve({ success: true, videoUrl: videoUrl });
              } else if (status === 'failed' || status === 'error') {
                var errMsg = taskData.task_status_msg || taskData.error || 'Task failed';
                resolve({ success: false, error: errMsg });
              } else {
                // Still processing, poll again
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
   * @param {string} videoUrl - Remote URL
   * @param {string} outputPath - Local file path
   * @returns {Promise<boolean>}
   */
  function downloadVideo(videoUrl, outputPath) {
    return new Promise(function (resolve, reject) {
      var https = require('https');
      var http = require('http');
      var fs = require('fs');
      var client = videoUrl.indexOf('https') === 0 ? https : http;

      var file = fs.createWriteStream(outputPath);
      client.get(videoUrl, function (response) {
        // Follow redirects
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
   * @param {number} duration - Total clip duration in seconds
   * @param {number} maxChunk - Max seconds per chunk (default 30)
   * @returns {Array<{start: number, end: number, index: number, duration: number}>}
   */
  function calculateSplits(duration, maxChunk) {
    maxChunk = maxChunk || MAX_DURATION;
    var chunks = [];
    var start = 0;
    var idx = 0;
    while (start < duration) {
      var end = Math.min(start + maxChunk, duration);
      var chunkDur = end - start;
      // Kling min is 3s. If last chunk < 3s, merge with previous
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
    submitTask: submitTask,
    pollTask: pollTask,
    downloadVideo: downloadVideo,
    calculateSplits: calculateSplits
  };
})();
