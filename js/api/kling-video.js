/**
 * Editly AI Editor: Kling Motion Control Video Generation
 * Async task-based API for generating AI VFX videos.
 */

var KlingVideo = (function () {
  'use strict';

  var API_BASE = 'https://api.klingai.com/v1';
  var POLL_INTERVALS = [10000, 15000, 20000, 30000, 30000]; // escalating poll times

  /**
   * Submit a Motion Control video generation task.
   * @param {object} opts
   * @param {string} opts.apiKey - Kling API key
   * @param {string} opts.referenceImageBase64 - AI-generated image (from Gemini)
   * @param {string} opts.videoFilePath - Local path to the source video chunk
   * @param {string} opts.prompt - Effect description
   * @param {number} opts.duration - Duration in seconds (max 30)
   * @returns {Promise<{success: boolean, taskId?: string, error?: string}>}
   */
  function submitTask(opts) {
    var url = API_BASE + '/videos/motion-control';

    // Read video file as base64
    var fs = require('fs');
    var videoBuffer = fs.readFileSync(opts.videoFilePath);
    var videoBase64 = videoBuffer.toString('base64');
    var videoExt = opts.videoFilePath.split('.').pop().toLowerCase();
    var videoMime = videoExt === 'mp4' ? 'video/mp4' : 'video/' + videoExt;

    var body = {
      model: 'kling-v3-motion-control',
      reference_image: 'data:image/png;base64,' + opts.referenceImageBase64,
      reference_video: 'data:' + videoMime + ';base64,' + videoBase64,
      prompt: opts.prompt || '',
      duration: Math.min(opts.duration || 10, 30),
      mode: 'pro',
      audio: 'keep'
    };

    console.log('[Kling] Submitting task, duration: ' + body.duration + 's');

    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Authorization', 'Bearer ' + opts.apiKey);
      xhr.timeout = 60000;

      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            var resp = JSON.parse(xhr.responseText);
            if (resp.data && resp.data.task_id) {
              console.log('[Kling] Task submitted: ' + resp.data.task_id);
              resolve({ success: true, taskId: resp.data.task_id });
            } else if (resp.task_id) {
              resolve({ success: true, taskId: resp.task_id });
            } else {
              resolve({ success: false, error: 'No task_id in response' });
            }
          } catch (e) {
            reject(new Error('Parse error: ' + e.message));
          }
        } else {
          var errMsg = 'Kling API error ' + xhr.status;
          try {
            var errBody = JSON.parse(xhr.responseText);
            if (errBody.message) errMsg += ': ' + errBody.message;
          } catch (e) {}
          reject(new Error(errMsg));
        }
      };

      xhr.onerror = function () { reject(new Error('Network error calling Kling API')); };
      xhr.ontimeout = function () { reject(new Error('Kling API submit timed out')); };
      xhr.send(JSON.stringify(body));
    });
  }

  /**
   * Poll a task until completion or failure.
   * @param {string} apiKey
   * @param {string} taskId
   * @param {function} onProgress - Called with status updates
   * @returns {Promise<{success: boolean, videoUrl?: string, error?: string}>}
   */
  function pollTask(apiKey, taskId, onProgress) {
    var url = API_BASE + '/tasks/' + taskId;
    var pollCount = 0;
    var maxPolls = 120; // ~30 min max

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
              var status = (resp.data && resp.data.status) || resp.status || 'unknown';
              var progress = (resp.data && resp.data.progress) || resp.progress || 0;

              console.log('[Kling] Poll #' + pollCount + ': ' + status + ' (' + progress + '%)');

              if (onProgress) {
                onProgress({ status: status, progress: progress, pollCount: pollCount });
              }

              if (status === 'completed' || status === 'succeed') {
                var videoUrl = null;
                if (resp.data && resp.data.output && resp.data.output.video_url) {
                  videoUrl = resp.data.output.video_url;
                } else if (resp.data && resp.data.video_url) {
                  videoUrl = resp.data.video_url;
                } else if (resp.output && resp.output.video_url) {
                  videoUrl = resp.output.video_url;
                }
                resolve({ success: true, videoUrl: videoUrl });
              } else if (status === 'failed' || status === 'error') {
                var errMsg = (resp.data && resp.data.error) || resp.error || 'Task failed';
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
   * Calculate 30-second split points for a clip.
   * @param {number} duration - Total clip duration in seconds
   * @param {number} maxChunk - Max seconds per chunk (default 30)
   * @returns {Array<{start: number, end: number, index: number}>}
   */
  function calculateSplits(duration, maxChunk) {
    maxChunk = maxChunk || 30;
    var chunks = [];
    var start = 0;
    var idx = 0;
    while (start < duration) {
      var end = Math.min(start + maxChunk, duration);
      chunks.push({ start: start, end: end, index: idx, duration: end - start });
      start = end;
      idx++;
    }
    return chunks;
  }

  return {
    submitTask: submitTask,
    pollTask: pollTask,
    downloadVideo: downloadVideo,
    calculateSplits: calculateSplits
  };
})();
