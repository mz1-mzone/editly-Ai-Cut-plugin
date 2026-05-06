/**
 * Editly AI Editor: VFX Pipeline Controller
 * Orchestrates: Frame Extract → Gemini Image → Preview → Kling Video → Import
 */

var VFXController = (function () {
  'use strict';

  var MAX_CLIP_DURATION = 30; // seconds
  var queue = []; // Array of task objects
  var isProcessing = false;

  /**
   * Validate selected clip and return info.
   * @param {object} clipData - Clip data from getSelectedClips
   * @returns {{valid: boolean, clips: Array, totalDuration: number, taskCount: number, error?: string}}
   */
  function validateClip(clipData) {
    if (!clipData || !clipData.clips || clipData.clips.length === 0) {
      return { valid: false, error: 'No clips selected. Select a clip on the timeline first.' };
    }

    if (clipData.clips.length > 1) {
      return { valid: false, error: 'Please select only one clip for VFX processing.' };
    }

    var clip = clipData.clips[0];
    var duration = clip.duration || (clip.endTime - clip.startTime);
    var splits = KlingVideo.calculateSplits(duration, MAX_CLIP_DURATION);

    return {
      valid: true,
      clip: clip,
      duration: duration,
      taskCount: splits.length,
      splits: splits,
      needsSplit: splits.length > 1
    };
  }

  /**
   * Extract first frame from a video clip using ffmpeg.
   * @param {string} mediaPath - Path to the source media file
   * @param {number} seekTime - Time offset in seconds (the in-point)
   * @param {string} outputPath - Where to save the frame
   * @returns {Promise<boolean>}
   */
  function extractFrame(mediaPath, seekTime, outputPath) {
    return new Promise(function (resolve, reject) {
      var exec = require('child_process').exec;
      var cmd = '/opt/homebrew/bin/ffmpeg -y -ss ' + seekTime.toFixed(3) +
        ' -i "' + mediaPath + '" -frames:v 1 -q:v 2 "' + outputPath + '"';

      console.log('[VFX] Extracting frame: ' + cmd);

      exec(cmd, function (err, stdout, stderr) {
        if (err) {
          // Try /usr/local/bin fallback
          var cmd2 = '/usr/local/bin/ffmpeg -y -ss ' + seekTime.toFixed(3) +
            ' -i "' + mediaPath + '" -frames:v 1 -q:v 2 "' + outputPath + '"';
          exec(cmd2, function (err2) {
            if (err2) {
              reject(new Error('ffmpeg frame extraction failed: ' + err2.message));
            } else {
              resolve(true);
            }
          });
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * Extract a video chunk using ffmpeg.
   * @param {string} mediaPath - Source video
   * @param {number} startTime - Start offset in seconds
   * @param {number} duration - Chunk duration in seconds
   * @param {string} outputPath - Where to save the chunk
   * @returns {Promise<boolean>}
   */
  function extractVideoChunk(mediaPath, startTime, duration, outputPath) {
    return new Promise(function (resolve, reject) {
      var exec = require('child_process').exec;
      var cmd = '/opt/homebrew/bin/ffmpeg -y -ss ' + startTime.toFixed(3) +
        ' -i "' + mediaPath + '" -t ' + duration.toFixed(3) +
        ' -c copy "' + outputPath + '"';

      console.log('[VFX] Extracting chunk: ' + startTime + 's - ' + (startTime + duration) + 's');

      exec(cmd, function (err) {
        if (err) {
          var cmd2 = cmd.replace('/opt/homebrew/bin/', '/usr/local/bin/');
          exec(cmd2, function (err2) {
            if (err2) reject(new Error('ffmpeg chunk extraction failed'));
            else resolve(true);
          });
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * Run the full VFX preview pipeline (steps 1-4).
   * @param {object} opts
   * @param {object} opts.clip - Clip data
   * @param {string} opts.mediaPath - Source media path
   * @param {string} opts.prompt - User's VFX prompt
   * @param {string} opts.geminiApiKey
   * @param {string} opts.imageModel
   * @param {function} opts.onProgress - Progress callback
   * @returns {Promise<{success: boolean, previewPath?: string, imageBase64?: string, error?: string}>}
   */
  function generatePreview(opts) {
    var tempDir = require('os').tmpdir() + '/editly_vfx';
    try { require('fs').mkdirSync(tempDir, { recursive: true }); } catch (e) {}

    var framePath = tempDir + '/frame_' + Date.now() + '.jpg';
    var previewPath = tempDir + '/preview_' + Date.now() + '.png';

    var seekTime = opts.clip.inPoint || opts.clip.startTime || 0;

    if (opts.onProgress) opts.onProgress({ step: 'frame', detail: 'Extracting first frame...' });

    return extractFrame(opts.mediaPath, seekTime, framePath)
      .then(function () {
        if (opts.onProgress) opts.onProgress({ step: 'gemini', detail: 'Generating AI image...' });

        var base64Image = GeminiImage.loadImageAsBase64(framePath);
        return GeminiImage.generate(opts.geminiApiKey, base64Image, opts.prompt, opts.imageModel);
      })
      .then(function (result) {
        if (!result.success) {
          throw new Error(result.error || 'Image generation failed');
        }

        // Save preview image
        GeminiImage.saveBase64ToFile(result.imageBase64, previewPath);

        if (opts.onProgress) opts.onProgress({ step: 'preview', detail: 'Preview ready!' });

        return {
          success: true,
          previewPath: previewPath,
          imageBase64: result.imageBase64,
          text: result.text
        };
      });
  }

  /**
   * Create a queue task for Kling video generation.
   * @param {object} opts
   * @returns {object} task object
   */
  function createTask(opts) {
    var task = {
      id: 'vfx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      clipName: opts.clipName || 'Clip',
      chunkIndex: opts.chunkIndex || 0,
      totalChunks: opts.totalChunks || 1,
      startTime: opts.startTime,
      endTime: opts.endTime,
      duration: opts.duration,
      prompt: opts.prompt,
      imageBase64: opts.imageBase64,
      mediaPath: opts.mediaPath,
      klingAccessKey: opts.klingAccessKey,
      klingSecretKey: opts.klingSecretKey,
      status: 'queued', // queued, extracting, submitting, processing, downloading, importing, done, error
      progress: 0,
      klingTaskId: null,
      videoPath: null,
      error: null,
      createdAt: Date.now()
    };
    queue.push(task);
    return task;
  }

  /**
   * Process a single task through the Kling pipeline.
   * @param {object} task
   * @param {function} onUpdate - Called whenever task state changes
   * @param {function} evalScript - CSInterface evalScript wrapper
   * @returns {Promise}
   */
  function processTask(task, onUpdate, evalScript) {
    var tempDir = require('os').tmpdir() + '/editly_vfx';

    function updateTask(updates) {
      for (var key in updates) task[key] = updates[key];
      if (onUpdate) onUpdate(task);
    }

    // Step 1: Extract video chunk
    updateTask({ status: 'extracting', progress: 10 });
    var chunkPath = tempDir + '/chunk_' + task.id + '.mp4';

    return extractVideoChunk(task.mediaPath, task.startTime, task.duration, chunkPath)
      .then(function () {
        // Step 2: Submit to Kling
        updateTask({ status: 'submitting', progress: 20 });
        return KlingVideo.submitTask({
          accessKey: task.klingAccessKey,
          secretKey: task.klingSecretKey,
          referenceImageBase64: task.imageBase64,
          videoFilePath: chunkPath,
          prompt: task.prompt,
          duration: Math.max(3, Math.min(task.duration, 30))
        });
      })
      .then(function (submitResult) {
        if (!submitResult.success) throw new Error(submitResult.error);
        task.klingTaskId = submitResult.taskId;

        // Step 3: Poll until done
        updateTask({ status: 'processing', progress: 30 });
        return KlingVideo.pollTask(task.klingAccessKey, task.klingSecretKey, submitResult.taskId, function (pollData) {
          var pct = 30 + Math.round((pollData.progress || 0) * 0.5);
          updateTask({ progress: Math.min(pct, 80) });
        });
      })
      .then(function (pollResult) {
        if (!pollResult.success) throw new Error(pollResult.error);
        if (!pollResult.videoUrl) throw new Error('No video URL returned');

        // Step 4: Download video
        updateTask({ status: 'downloading', progress: 85 });
        var videoPath = tempDir + '/vfx_' + task.id + '.mp4';
        task.videoPath = videoPath;

        return KlingVideo.downloadVideo(pollResult.videoUrl, videoPath);
      })
      .then(function () {
        // Step 5: Import into Premiere
        updateTask({ status: 'importing', progress: 95 });

        var escapedPath = task.videoPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        var startSec = task.startTime;
        return evalScript("importAndPlaceAbove('" + escapedPath + "', " + startSec + ")");
      })
      .then(function () {
        updateTask({ status: 'done', progress: 100 });
      })
      .catch(function (err) {
        updateTask({ status: 'error', error: err.message });
        console.error('[VFX] Task error: ' + err.message);
      });
  }

  /**
   * Process all queued tasks sequentially.
   * @param {function} onUpdate
   * @param {function} evalScript
   * @returns {Promise}
   */
  function processQueue(onUpdate, evalScript) {
    if (isProcessing) return Promise.resolve();
    isProcessing = true;

    var pending = queue.filter(function (t) { return t.status === 'queued'; });

    function next(idx) {
      if (idx >= pending.length) {
        isProcessing = false;
        return Promise.resolve();
      }
      return processTask(pending[idx], onUpdate, evalScript)
        .then(function () { return next(idx + 1); });
    }

    return next(0).then(function () { isProcessing = false; });
  }

  /**
   * Get the current queue.
   */
  function getQueue() {
    return queue;
  }

  /**
   * Clear completed/errored tasks from queue.
   */
  function clearDone() {
    queue = queue.filter(function (t) { return t.status !== 'done' && t.status !== 'error'; });
  }

  /**
   * Retry a failed task.
   */
  function retryTask(taskId) {
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].id === taskId && queue[i].status === 'error') {
        queue[i].status = 'queued';
        queue[i].progress = 0;
        queue[i].error = null;
        return true;
      }
    }
    return false;
  }

  return {
    validateClip: validateClip,
    generatePreview: generatePreview,
    createTask: createTask,
    processTask: processTask,
    processQueue: processQueue,
    getQueue: getQueue,
    clearDone: clearDone,
    retryTask: retryTask,
    extractFrame: extractFrame,
    extractVideoChunk: extractVideoChunk
  };
})();
