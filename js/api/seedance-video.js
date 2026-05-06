/**
 * Editly AI Editor: BytePlus Seedance 2.0 Video Generation
 * Async task-based API with Bearer token auth.
 * Endpoint: https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks
 * Model: dreamina-seedance-2-0-260128
 * Duration: 4–15s, Resolution: max 1080p
 */

var SeedanceVideo = (function () {
  'use strict';

  var API_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks';
  var MODEL_NAME = 'dreamina-seedance-2-0-260128';
  var MIN_DURATION = 4;
  var MAX_DURATION = 15;
  var POLL_INTERVALS = [8000, 10000, 15000, 20000, 20000];

  // ==================== RATIO MAPPING ====================

  /**
   * Map sequence dimensions to nearest supported Seedance ratio.
   * Supported: 16:9, 9:16, 1:1, 4:3, 3:4, 21:9
   */
  function mapRatio(width, height) {
    var actual = width / height;
    var ratios = [
      { name: '16:9', value: 16 / 9 },
      { name: '9:16', value: 9 / 16 },
      { name: '1:1', value: 1 },
      { name: '4:3', value: 4 / 3 },
      { name: '3:4', value: 3 / 4 },
      { name: '21:9', value: 21 / 9 }
    ];

    var best = ratios[0];
    var bestDiff = Math.abs(actual - best.value);
    for (var i = 1; i < ratios.length; i++) {
      var diff = Math.abs(actual - ratios[i].value);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = ratios[i];
      }
    }
    return best.name;
  }

  // ==================== FILE UPLOAD (reuse tmpfiles.org) ====================

  /**
   * Upload a local file to tmpfiles.org.
   * Reuses KlingVideo.uploadFile if available, otherwise implements own.
   */
  function uploadFile(filePath) {
    if (typeof KlingVideo !== 'undefined' && KlingVideo.uploadFile) {
      return KlingVideo.uploadFile(filePath);
    }

    // Standalone upload implementation
    return new Promise(function (resolve, reject) {
      var fs = require('fs');
      var path = require('path');
      var https = require('https');
      var url = require('url');

      var fileName = path.basename(filePath);
      var fileData = fs.readFileSync(filePath);
      var boundary = '----SeedanceBoundary' + Date.now();

      var bodyParts = [];
      bodyParts.push(Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="file"; filename="' + fileName + '"\r\n' +
        'Content-Type: application/octet-stream\r\n\r\n'
      ));
      bodyParts.push(fileData);
      bodyParts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));

      var body = Buffer.concat(bodyParts);
      var parsed = url.parse('https://tmpfiles.org/api/v1/upload');

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

      console.log('[Seedance] Uploading ' + fileName + ' (' + (fileData.length / 1024 / 1024).toFixed(1) + ' MB)...');

      var req = https.request(options, function (res) {
        var chunks = [];
        res.on('data', function (chunk) { chunks.push(chunk); });
        res.on('end', function () {
          try {
            var responseText = Buffer.concat(chunks).toString();
            var resp = JSON.parse(responseText);
            if (resp.status === 'success' && resp.data && resp.data.url) {
              var directUrl = resp.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
              console.log('[Seedance] Uploaded: ' + directUrl);
              resolve(directUrl);
            } else {
              reject(new Error('Upload failed: ' + responseText.substring(0, 200)));
            }
          } catch (e) {
            reject(new Error('Upload parse error: ' + e.message));
          }
        });
      });

      req.on('error', function (err) { reject(new Error('Upload error: ' + err.message)); });
      req.write(body);
      req.end();
    });
  }

  /**
   * Save base64 to a temp file and upload it, returning the URL.
   */
  function uploadBase64(base64Data, ext) {
    var fs = require('fs');
    var os = require('os');
    var tempDir = os.tmpdir() + '/editly_vfx';
    try { fs.mkdirSync(tempDir, { recursive: true }); } catch (e) {}
    var filePath = tempDir + '/seedance_upload_' + Date.now() + '.' + (ext || 'png');
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    return uploadFile(filePath);
  }

  // ==================== API CALLS ====================

  /**
   * Submit a Seedance 2.0 video generation task.
   *
   * @param {object} opts
   * @param {string} opts.apiKey - BytePlus ARK API key
   * @param {string} opts.prompt - Text prompt
   * @param {string} opts.referenceImageBase64 - AI-generated preview (raw base64)
   * @param {Array<string>} opts.extraImagePaths - Additional user-uploaded image file paths
   * @param {string} opts.videoFilePath - Source video file path
   * @param {number} opts.duration - Duration in seconds (4-15)
   * @param {string} opts.ratio - Aspect ratio string (e.g. '16:9')
   * @param {function} opts.onProgress - Progress callback
   * @returns {Promise<{success: boolean, taskId?: string, error?: string}>}
   */
  function submitTask(opts) {
    var onProgress = opts.onProgress || function () {};

    // Step 1: Upload files to get public URLs
    // NOTE: We skip the AI-generated preview image for Seedance because
    // its safety filter rejects images containing real human faces.
    // The video reference provides enough visual context.
    var uploadPromises = [];

    // Upload extra user-provided reference images only
    if (opts.extraImagePaths && opts.extraImagePaths.length > 0) {
      onProgress({ detail: 'Uploading reference images...' });
      for (var i = 0; i < opts.extraImagePaths.length; i++) {
        (function (imgPath) {
          uploadPromises.push(
            uploadFile(imgPath).then(function (url) {
              return { type: 'image', url: url, role: 'reference_image' };
            })
          );
        })(opts.extraImagePaths[i]);
      }
    }

    // Upload source video
    onProgress({ detail: 'Uploading video to Seedance...' });
    uploadPromises.push(
      uploadFile(opts.videoFilePath).then(function (url) {
        return { type: 'video', url: url, role: 'reference_video' };
      })
    );

    return Promise.all(uploadPromises)
      .then(function (uploads) {
        onProgress({ detail: 'Submitting to Seedance...' });

        // Build content array per Seedance spec
        var content = [];

        // Text prompt (required, must be first)
        content.push({
          type: 'text',
          text: opts.prompt || 'Generate a creative video'
        });

        // Reference images
        for (var i = 0; i < uploads.length; i++) {
          var u = uploads[i];
          if (u.type === 'image') {
            content.push({
              type: 'image_url',
              role: u.role,
              image_url: { url: u.url }
            });
          }
        }

        // Reference video
        for (var i = 0; i < uploads.length; i++) {
          var u = uploads[i];
          if (u.type === 'video') {
            content.push({
              type: 'video_url',
              role: u.role,
              video_url: { url: u.url }
            });
          }
        }

        var duration = Math.round(Math.max(MIN_DURATION, Math.min(opts.duration || 5, MAX_DURATION)));
        var ratio = opts.ratio || '16:9';

        var body = {
          model: MODEL_NAME,
          content: content,
          duration: duration,
          ratio: ratio,
          generate_audio: false,
          watermark: false
        };

        console.log('[Seedance] Submitting task: duration=' + duration + 's, ratio=' + ratio);
        console.log('[Seedance] Content items: ' + content.length);

        return new Promise(function (resolve, reject) {
          var xhr = new XMLHttpRequest();
          xhr.open('POST', API_BASE, true);
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.setRequestHeader('Authorization', 'Bearer ' + opts.apiKey);
          xhr.timeout = 60000;

          xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                var resp = JSON.parse(xhr.responseText);
                console.log('[Seedance] Submit response:', JSON.stringify(resp).substring(0, 300));

                var taskId = resp.id || resp.task_id || (resp.data && resp.data.task_id);
                if (taskId) {
                  resolve({ success: true, taskId: taskId });
                } else {
                  resolve({ success: false, error: 'No task ID: ' + JSON.stringify(resp).substring(0, 200) });
                }
              } catch (e) {
                reject(new Error('Parse error: ' + e.message));
              }
            } else {
              var errMsg = 'Seedance API error ' + xhr.status;
              try {
                var errBody = JSON.parse(xhr.responseText);
                if (errBody.message) errMsg += ': ' + errBody.message;
                else if (errBody.error) errMsg += ': ' + (errBody.error.message || JSON.stringify(errBody.error));
              } catch (e) {
                errMsg += ': ' + xhr.responseText.substring(0, 200);
              }
              reject(new Error(errMsg));
            }
          };

          xhr.onerror = function () { reject(new Error('Network error calling Seedance API')); };
          xhr.ontimeout = function () { reject(new Error('Seedance API timed out')); };
          xhr.send(JSON.stringify(body));
        });
      });
  }

  /**
   * Poll a Seedance task until completion.
   * GET /api/v3/contents/generations/tasks/{task_id}
   */
  function pollTask(apiKey, taskId, onProgress) {
    var url = API_BASE + '/' + taskId;
    var pollCount = 0;
    var maxPolls = 120;

    return new Promise(function (resolve, reject) {
      function poll() {
        if (pollCount >= maxPolls) {
          reject(new Error('Task timed out after ' + maxPolls + ' polls'));
          return;
        }

        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Authorization', 'Bearer ' + apiKey);
        xhr.timeout = 15000;

        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              var resp = JSON.parse(xhr.responseText);
              var status = (resp.status || resp.state || 'unknown').toLowerCase();
              var progress = resp.progress || 0;

              console.log('[Seedance] Poll #' + pollCount + ': status=' + status);

              if (onProgress) {
                onProgress({ status: status, progress: progress, pollCount: pollCount });
              }

              if (status === 'succeeded' || status === 'completed' || status === 'done') {
                // Extract video URL from content array or direct field
                var videoUrl = null;
                if (resp.content && Array.isArray(resp.content)) {
                  for (var i = 0; i < resp.content.length; i++) {
                    var item = resp.content[i];
                    if (item.video_url) {
                      videoUrl = typeof item.video_url === 'string' ? item.video_url : item.video_url.url;
                      break;
                    }
                  }
                }
                if (!videoUrl && resp.video_url) {
                  videoUrl = typeof resp.video_url === 'string' ? resp.video_url : resp.video_url.url;
                }
                if (!videoUrl && resp.output && resp.output.video_url) {
                  videoUrl = resp.output.video_url;
                }

                resolve({ success: true, videoUrl: videoUrl });
              } else if (status === 'failed' || status === 'error') {
                var errMsg = resp.error || resp.message || 'Task failed';
                if (typeof errMsg === 'object') errMsg = errMsg.message || JSON.stringify(errMsg);
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
   * Calculate split points (4-15s chunks for Seedance).
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
      } else if (chunkDur < MIN_DURATION) {
        // Single chunk too short, pad to minimum
        chunks.push({ start: start, end: start + MIN_DURATION, index: idx, duration: MIN_DURATION });
        idx++;
      } else {
        chunks.push({ start: start, end: end, index: idx, duration: chunkDur });
        idx++;
      }
      start = end;
    }
    return chunks;
  }

  return {
    mapRatio: mapRatio,
    uploadFile: uploadFile,
    uploadBase64: uploadBase64,
    submitTask: submitTask,
    pollTask: pollTask,
    calculateSplits: calculateSplits,
    MIN_DURATION: MIN_DURATION,
    MAX_DURATION: MAX_DURATION
  };
})();
