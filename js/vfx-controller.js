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
      valid: true, clip: clip, duration: duration,
      taskCount: splits.length, splits: splits, needsSplit: splits.length > 1
    };
  }

  /**
   * Extract first frame from a video clip using ffmpeg.
   */
  function extractFrame(mediaPath, seekTime, outputPath) {
    return new Promise(function (resolve, reject) {
      var exec = require('child_process').exec;
      var cmd = '/opt/homebrew/bin/ffmpeg -y -ss ' + seekTime.toFixed(3) +
        ' -i "' + mediaPath + '" -frames:v 1 -q:v 2 "' + outputPath + '"';
      exec(cmd, function (err) {
        if (err) {
          var cmd2 = cmd.replace('/opt/homebrew/bin/', '/usr/local/bin/');
          exec(cmd2, function (err2) {
            if (err2) reject(new Error('ffmpeg frame extraction failed'));
            else resolve(true);
          });
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * Extract a video chunk using ffmpeg.
   */
  function extractVideoChunk(mediaPath, startTime, duration, outputPath, maxPixels) {
    return new Promise(function (resolve, reject) {
      var exec = require('child_process').exec;
      var scaleFilter = '';
      if (maxPixels) {
        // Scale down proportionally if source exceeds pixel budget
        // Uses expression: if(w*h > maxPixels, scale so w*h = maxPixels, keep original)
        scaleFilter = ' -vf "scale=iw*min(1\\,sqrt(' + maxPixels + '/(iw*ih))):ih*min(1\\,sqrt(' + maxPixels + '/(iw*ih))):flags=lanczos" -c:v libx264 -preset fast -crf 18 -c:a aac';
      } else {
        scaleFilter = ' -c copy';
      }
      var cmd = '/opt/homebrew/bin/ffmpeg -y -ss ' + startTime.toFixed(3) +
        ' -i "' + mediaPath + '" -t ' + duration.toFixed(3) +
        scaleFilter + ' "' + outputPath + '"';
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
   * Run the full VFX preview pipeline.
   */
  function generatePreview(opts) {
    var fs = require('fs');
    var outputDir = opts.outputDir || require('os').tmpdir() + '/editly_vfx';
    try { fs.mkdirSync(outputDir, { recursive: true }); } catch (e) {}

    var framePath = outputDir + '/frame_' + Date.now() + '.jpg';
    var seekTime = opts.clip.inPoint || opts.clip.startTime || 0;

    if (opts.onProgress) opts.onProgress({ step: 'frame', detail: 'Extracting first frame...' });

    return extractFrame(opts.mediaPath, seekTime, framePath)
      .then(function () {
        if (opts.onProgress) opts.onProgress({ step: 'gemini', detail: 'Generating AI image...' });
        var base64Image = GeminiImage.loadImageAsBase64(framePath);
        return GeminiImage.generate(opts.geminiApiKey, base64Image, opts.prompt, opts.imageModel);
      })
      .then(function (result) {
        if (!result.success) throw new Error(result.error || 'Image generation failed');

        // Save preview image next to project file
        var safeName = (opts.clip.clipName || opts.clip.name || 'preview').replace(/[^a-zA-Z0-9_-]/g, '_');
        var previewPath = outputDir + '/VFX_Preview_' + safeName + '_' + Date.now().toString(36) + '.png';
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
   * Now also stores a small thumbnail of the reference image.
   */
  function createTask(opts) {
    // Create a small thumbnail data URI for the queue display
    var thumbDataUri = 'data:image/png;base64,' + (opts.imageBase64 || '').substring(0, 200);
    // Store the full base64 for the actual API call, but also a usable thumbnail
    if (opts.imageBase64) {
      thumbDataUri = 'data:image/png;base64,' + opts.imageBase64;
    }

    var task = {
      id: 'vfx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      clipName: opts.clipName || 'Clip',
      chunkIndex: opts.chunkIndex || 0,
      totalChunks: opts.totalChunks || 1,
      timelineStart: opts.timelineStart, // Where on the sequence timeline to place result
      startTime: opts.startTime,         // Media seek time for ffmpeg extraction
      endTime: opts.endTime,
      duration: opts.duration,
      prompt: opts.prompt,
      imageBase64: opts.imageBase64,
      thumbDataUri: thumbDataUri,
      mediaPath: opts.mediaPath,
      // Model selection
      model: opts.model || 'kling-v3',
      ratio: opts.ratio || '16:9',
      extraImagePaths: opts.extraImagePaths || [],
      // API keys
      klingAccessKey: opts.klingAccessKey,
      klingSecretKey: opts.klingSecretKey,
      seedanceApiKey: opts.seedanceApiKey,
      beebleApiKey: opts.beebleApiKey,
      status: 'queued',
      progress: 0,
      taskId: null,
      videoPath: null,
      error: null,
      createdAt: Date.now()
    };
    queue.push(task);
    return task;
  }

  /**
   * Process a single task through the full pipeline (Kling or Seedance).
   */
  function processTask(task, onUpdate, evalScript) {
    var fs = require('fs');

    function updateTask(updates) {
      for (var key in updates) task[key] = updates[key];
      if (onUpdate) onUpdate(task);
    }

    var isSeedance = task.model === 'seedance-2';
    var isBeeble = task.model === 'beeble';
    var modelLabel = isBeeble ? 'Beeble' : (isSeedance ? 'Seedance' : 'Kling');

    // Step 0: Get project folder
    updateTask({ status: 'extracting', progress: 5 });

    return evalScript('getProjectFolder()')
      .then(function (projResult) {
        var outputDir;
        if (projResult && projResult.success && projResult.folder) {
          outputDir = projResult.folder + '/Editly_VFX';
        } else {
          outputDir = require('os').tmpdir() + '/editly_vfx';
        }
        try { fs.mkdirSync(outputDir, { recursive: true }); } catch (e) {}
        return outputDir;
      })
      .then(function (outputDir) {
        // Step 1: Extract video chunk
        updateTask({ status: 'extracting', progress: 10 });
        var chunkPath = outputDir + '/chunk_' + task.id + '.mp4';
        // Beeble: source must be under 2,770,000 pixels — downscale if needed
        var maxPixels = isBeeble ? 2700000 : null;

        return extractVideoChunk(task.mediaPath, task.startTime, task.duration, chunkPath, maxPixels)
          .then(function () {
            // Step 2: Submit to API
            updateTask({ status: 'submitting', progress: 15 });

            if (isBeeble) {
              // ---------- BEEBLE SWITCHX ----------
              return BeebleVideo.submitTask({
                apiKey: task.beebleApiKey,
                prompt: task.prompt,
                referenceImageBase64: task.imageBase64,
                videoFilePath: chunkPath,
                onProgress: function (p) {
                  updateTask({ progress: Math.min(25, task.progress + 2) });
                  if (p.detail) console.log('[VFX][Beeble] ' + p.detail);
                }
              });
            } else if (isSeedance) {
              // ---------- SEEDANCE 2.0 ----------
              return SeedanceVideo.submitTask({
                apiKey: task.seedanceApiKey,
                prompt: task.prompt,
                referenceImageBase64: task.imageBase64,
                extraImagePaths: task.extraImagePaths || [],
                videoFilePath: chunkPath,
                duration: Math.max(4, Math.min(task.duration, 15)),
                ratio: task.ratio || '16:9',
                onProgress: function (p) {
                  updateTask({ progress: Math.min(25, task.progress + 2) });
                  if (p.detail) console.log('[VFX][Seedance] ' + p.detail);
                }
              });
            } else {
              // ---------- KLING 3.0 ----------
              return KlingVideo.submitTask({
                accessKey: task.klingAccessKey,
                secretKey: task.klingSecretKey,
                referenceImageBase64: task.imageBase64,
                videoFilePath: chunkPath,
                prompt: task.prompt,
                duration: Math.max(3, Math.min(task.duration, 30)),
                onProgress: function (p) {
                  updateTask({ progress: Math.min(25, task.progress + 2) });
                  if (p.detail) console.log('[VFX][Kling] ' + p.detail);
                }
              });
            }
          })
          .then(function (submitResult) {
            if (!submitResult.success) throw new Error(submitResult.error);
            task.taskId = submitResult.taskId;
            console.log('[VFX][' + modelLabel + '] Task submitted, ID: ' + submitResult.taskId);

            // Step 3: Poll until done
            updateTask({ status: 'processing', progress: 30 });

            if (isBeeble) {
              return BeebleVideo.pollTask(task.beebleApiKey, submitResult.taskId, function (pollData) {
                var pct = 30 + Math.round((pollData.progress || 0) * 0.5);
                updateTask({ progress: Math.min(pct, 80) });
              });
            } else if (isSeedance) {
              return SeedanceVideo.pollTask(task.seedanceApiKey, submitResult.taskId, function (pollData) {
                var pct = 30 + Math.round((pollData.progress || 0) * 0.5);
                updateTask({ progress: Math.min(pct, 80) });
              });
            } else {
              return KlingVideo.pollTask(task.klingAccessKey, task.klingSecretKey, submitResult.taskId, function (pollData) {
                var pct = 30 + Math.round((pollData.progress || 0) * 0.5);
                updateTask({ progress: Math.min(pct, 80) });
              });
            }
          })
          .then(function (pollResult) {
            if (!pollResult.success) throw new Error(pollResult.error || 'Generation failed');
            if (!pollResult.videoUrl) throw new Error('No video URL returned from ' + modelLabel);

            // Step 4: Download video
            updateTask({ status: 'downloading', progress: 85 });
            var safeName = (task.clipName || 'clip').replace(/[^a-zA-Z0-9_-]/g, '_');
            var timestamp = Date.now().toString(36);
            var prefix = isBeeble ? 'BX_' : (isSeedance ? 'SD_' : 'VFX_');
            var videoPath = outputDir + '/' + prefix + safeName + '_' + (task.chunkIndex + 1) + '_' + timestamp + '.mp4';
            task.videoPath = videoPath;

            // Use Kling's download helper (it's just an HTTPS download)
            return KlingVideo.downloadVideo(pollResult.videoUrl, videoPath);
          })
          .then(function () {
            // Step 5: Import into Premiere Pro
            updateTask({ status: 'importing', progress: 95 });
            var timelinePos = task.timelineStart || task.startTime;
            console.log('[VFX] Importing video: ' + task.videoPath + ' at timeline position ' + timelinePos + 's');

            var escapedPath = task.videoPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            return evalScript("importAndPlaceAbove('" + escapedPath + "', " + timelinePos + ")");
          })
          .then(function (importResult) {
            console.log('[VFX] Import result:', JSON.stringify(importResult));
            if (importResult && importResult.debug) {
              console.log('[VFX] Import debug:', importResult.debug.join(' | '));
            }
            if (importResult && importResult.error) {
              throw new Error('Import failed: ' + importResult.error);
            }
            updateTask({ status: 'done', progress: 100 });
          });
      })
      .catch(function (err) {
        console.error('[VFX] Task error: ' + err.message);
        updateTask({ status: 'error', error: err.message });
      });
  }

  /**
   * Process all queued tasks sequentially.
   * Fixed: properly chains tasks even after errors, resets isProcessing flag.
   */
  function processQueue(onUpdate, evalScript) {
    if (isProcessing) return Promise.resolve();
    isProcessing = true;

    function next() {
      // Find next queued task
      var nextTask = null;
      for (var i = 0; i < queue.length; i++) {
        if (queue[i].status === 'queued') {
          nextTask = queue[i];
          break;
        }
      }

      if (!nextTask) {
        isProcessing = false;
        return Promise.resolve();
      }

      // Process this task, then continue to next regardless of success/error
      return processTask(nextTask, onUpdate, evalScript)
        .then(function () {
          return next(); // Continue to next task
        });
    }

    return next().then(function () {
      isProcessing = false;
    }).catch(function () {
      isProcessing = false;
    });
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

  /**
   * Cancel a queued task (only if not yet processing).
   */
  function cancelTask(taskId) {
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].id === taskId && queue[i].status === 'queued') {
        queue.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Open the folder containing a task's video file in Finder.
   */
  function showInFolder(taskId) {
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].id === taskId && queue[i].videoPath) {
        var exec = require('child_process').exec;
        exec('open -R "' + queue[i].videoPath + '"');
        return true;
      }
    }
    // Fallback: open the temp directory
    var tempDir = require('os').tmpdir() + '/editly_vfx';
    require('child_process').exec('open "' + tempDir + '"');
    return true;
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
    cancelTask: cancelTask,
    showInFolder: showInFolder,
    extractFrame: extractFrame,
    extractVideoChunk: extractVideoChunk
  };
})();
