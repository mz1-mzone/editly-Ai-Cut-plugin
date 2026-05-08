/**
 * Editly AI Editor — FFmpeg Silence Detection
 * Analyzes audio waveform to detect silence at the signal level.
 * This catches pauses that transcription completely misses.
 */

var SilenceDetector = (function () {
  'use strict';

  var childProcess = require('child_process');

  /**
   * Detect silence regions in an audio file using ffmpeg silencedetect filter.
   * @param {string} audioPath - Path to the audio file
   * @param {number} timelineOffset - Timeline offset in seconds
   * @param {object} options - Detection options
   * @returns {Promise<Array>} Array of { start, end, duration } silence regions
   */
  function detectSilence(audioPath, timelineOffset, options) {
    timelineOffset = timelineOffset || 0;
    options = options || {};

    var noiseLevel = options.noiseLevel || '-35dB'; // Threshold for silence
    var minDuration = options.minDuration || 0.3;   // Minimum silence duration in seconds

    return new Promise(function (resolve, reject) {
      var cmd = '/usr/local/bin/ffmpeg -i "' + audioPath + '" ' +
        '-af silencedetect=noise=' + noiseLevel + ':d=' + minDuration + ' ' +
        '-f null - 2>&1';

      console.log('[SilenceDetect] Running: ' + cmd);

      childProcess.exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, function (error, stdout, stderr) {
        var output = (stdout || '') + (stderr || '');

        // Parse silence_start and silence_end from ffmpeg output
        var silenceRegions = [];
        var lines = output.split('\n');
        var currentStart = null;

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];

          // Match: [silencedetect @ 0x...] silence_start: 5.234
          var startMatch = line.match(/silence_start:\s*([\d.]+)/);
          if (startMatch) {
            currentStart = parseFloat(startMatch[1]);
          }

          // Match: [silencedetect @ 0x...] silence_end: 6.891 | silence_duration: 1.657
          var endMatch = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
          if (endMatch && currentStart !== null) {
            var silenceEnd = parseFloat(endMatch[1]);
            var silenceDuration = parseFloat(endMatch[2]);

            silenceRegions.push({
              start: currentStart + timelineOffset,
              end: silenceEnd + timelineOffset,
              duration: silenceDuration
            });
            currentStart = null;
          }
        }

        console.log('[SilenceDetect] Found ' + silenceRegions.length + ' silence regions');

        if (silenceRegions.length > 0) {
          var totalSilence = silenceRegions.reduce(function (sum, r) { return sum + r.duration; }, 0);
          console.log('[SilenceDetect] Total silence: ' + totalSilence.toFixed(1) + 's');
          console.log('[SilenceDetect] Longest: ' + Math.max.apply(null, silenceRegions.map(function (r) { return r.duration; })).toFixed(1) + 's');
        }

        resolve(silenceRegions);
      });
    });
  }

  return {
    detectSilence: detectSilence
  };
})();

if (typeof window !== 'undefined') {
  window.SilenceDetector = SilenceDetector;
}
