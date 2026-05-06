/**
 * Editly AI Editor: Kling Motion Control Video Generation
 * Async task-based API with JWT authentication (Access Key + Secret Key).
 * Docs: https://kling.ai/document-api/apiReference/model/motionControl
 * Base URL: https://api.klingai.com
 */

var KlingVideo = (function () {
  'use strict';

  var API_BASE = 'https://api.klingai.com/v1';
  var POLL_INTERVALS = [10000, 15000, 20000, 30000, 30000]; // escalating poll times
  var MIN_DURATION = 3;
  var MAX_DURATION = 30;

  // ==================== JWT TOKEN GENERATION ====================

  /**
   * Generate a JWT token for Kling API auth using HS256.
   * RFC 7519 compliant. Header: {alg: HS256, typ: JWT}
   * Payload: {iss: accessKey, exp: now+1800, nbf: now-5}
   * @param {string} accessKey - Kling Access Key (AK)
   * @param {string} secretKey - Kling Secret Key (SK)
   * @returns {string} JWT token
   */
  function generateJWT(accessKey, secretKey) {
    var crypto = require('crypto');
    var now = Math.floor(Date.now() / 1000);

    var header = { alg: 'HS256', typ: 'JWT' };
    var payload = {
      iss: accessKey,
      exp: now + 1800,  // 30 min expiry
      nbf: now - 5      // valid from 5s ago
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

  // ==================== API CALLS ====================

  /**
   * Submit a Motion Control video generation task.
   * POST /v1/videos/motion-control
   *
   * Required fields per Kling docs:
   *   - image_url: string (URL or raw base64 without data URI prefix)
   *   - video_url: string (URL or raw base64 without data URI prefix)
   *   - character_orientation: "video" | "image"
   *
   * Optional fields:
   *   - model_name: "kling-v2-6" (default) or "kling-v3"
   *   - prompt: string (max 2500 chars)
   *   - keep_original_sound: "yes" | "no" (default "yes")
   *   - callback_url: string (not used, we poll instead)
   *   - external_task_id: string
   *
   * @param {object} opts
   * @param {string} opts.accessKey - Kling Access Key
   * @param {string} opts.secretKey - Kling Secret Key
   * @param {string} opts.referenceImageBase64 - AI-generated image (raw base64, no prefix)
   * @param {string} opts.videoFilePath - Local path to the source video chunk
   * @param {string} opts.prompt - Effect description
   * @param {number} opts.duration - Duration in seconds (3-30)
   * @returns {Promise<{success: boolean, taskId?: string, error?: string}>}
   */
  function submitTask(opts) {
    var url = API_BASE + '/videos/motion-control';
    var token = generateJWT(opts.accessKey, opts.secretKey);

    // Read video file as raw base64 (no data URI prefix, per Kling docs)
    var fs = require('fs');
    var videoBuffer = fs.readFileSync(opts.videoFilePath);
    var videoBase64 = videoBuffer.toString('base64');

    // Clamp duration to valid range
    var duration = Math.max(MIN_DURATION, Math.min(opts.duration || 5, MAX_DURATION));

    // Build request body per Kling Motion Control spec
    var body = {
      model_name: 'kling-v2-6',
      image_url: opts.referenceImageBase64,         // Raw base64, no data: prefix
      video_url: videoBase64,                        // Raw base64, no data: prefix
      character_orientation: 'video',                // Match motion from video (supports up to 30s)
      prompt: opts.prompt || '',
      keep_original_sound: 'yes'                     // String, not boolean
    };

    console.log('[Kling] Submitting motion-control task');
    console.log('[Kling] Duration: ' + duration + 's, model: ' + body.model_name);
    console.log('[Kling] Image base64 length: ' + (opts.referenceImageBase64 || '').length);
    console.log('[Kling] Video base64 length: ' + videoBase64.length);

    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.timeout = 180000; // 3 min for large base64 uploads

      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            var resp = JSON.parse(xhr.responseText);
            console.log('[Kling] Submit response:', JSON.stringify(resp).substring(0, 300));

            // Kling response: { code: 0, message: "...", data: { task_id: "..." } }
            var taskId = null;
            if (resp.data && resp.data.task_id) taskId = resp.data.task_id;
            else if (resp.task_id) taskId = resp.task_id;

            if (taskId) {
              console.log('[Kling] Task submitted: ' + taskId);
              resolve({ success: true, taskId: taskId });
            } else if (resp.code && resp.code !== 0) {
              resolve({ success: false, error: 'Kling error ' + resp.code + ': ' + (resp.message || 'Unknown') });
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
      xhr.ontimeout = function () { reject(new Error('Kling API submit timed out (3 min)')); };
      xhr.send(JSON.stringify(body));
    });
  }

  /**
   * Poll a task until completion or failure.
   * GET /v1/videos/motion-control/{task_id}
   *
   * Response shape: { code: 0, data: { task_id, task_status, task_status_msg, task_result: { videos: [{url, duration}] } } }
   *
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

        // Generate fresh JWT for each poll (tokens expire in 30 min)
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
                // Extract video URL: data.task_result.videos[0].url
                var videoUrl = null;
                if (taskData.task_result && taskData.task_result.videos) {
                  var videos = taskData.task_result.videos;
                  if (videos.length > 0 && videos[0].url) {
                    videoUrl = videos[0].url;
                  }
                }
                if (!videoUrl) {
                  console.log('[Kling] Full response for debug: ' + JSON.stringify(resp).substring(0, 500));
                }
                resolve({ success: true, videoUrl: videoUrl });
              } else if (status === 'failed' || status === 'error') {
                var errMsg = taskData.task_status_msg || taskData.error || 'Task failed';
                resolve({ success: false, error: errMsg });
              } else {
                // Still processing (status: submitted, processing, etc.)
                pollCount++;
                var interval = POLL_INTERVALS[Math.min(pollCount, POLL_INTERVALS.length - 1)];
                setTimeout(poll, interval);
              }
            } catch (e) {
              console.warn('[Kling] Poll parse error, retrying...');
              pollCount++;
              setTimeout(poll, 15000);
            }
          } else {
            console.warn('[Kling] Poll HTTP ' + xhr.status + ', retrying...');
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
   * Note: Kling video URLs are temporary (24h), download immediately.
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
