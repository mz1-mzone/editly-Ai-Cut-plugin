/**
 * Editly AI Editor — Gemini Chunked Audio Mapper
 *
 * Splits audio into smart 2-3 minute chunks, sends each to Gemini
 * for forensic-level audio analysis. Detects every filler, breath,
 * silence, noise, and stutter with 0.2s precision.
 *
 * Pipeline: Audio → FFmpeg smart chunks → Gemini per chunk → Stitch
 */

var AudioAnalyzer = (function () {
  'use strict';

  var https = require('https');
  var fs = require('fs');
  var url = require('url');
  var childProcess = require('child_process');

  var FFMPEG_PATH = '/usr/local/bin/ffmpeg';
  var FFPROBE_PATH = '/usr/local/bin/ffprobe';
  var TARGET_CHUNK = 150; // 2.5 min sweet spot

  function AudioAnalyzer(geminiApiKey) {
    this.apiKey = geminiApiKey;
    this.model = 'gemini-3.1-pro-preview';
  }

  /**
   * Map audio by splitting into smart chunks and analyzing each with Gemini.
   *
   * @param {string} audioPath - Path to the WAV audio file
   * @param {number} timelineOffset - Timeline offset in seconds
   * @param {function} onProgress - callback(chunkIdx, totalChunks, message)
   * @returns {Promise<Object>} { success, segments[], totalSegments, language, counts }
   */
  AudioAnalyzer.prototype.mapAudio = function (audioPath, timelineOffset, onProgress) {
    var self = this;
    timelineOffset = timelineOffset || 0;
    onProgress = onProgress || function () {};

    return self._getAudioDuration(audioPath).then(function (duration) {
      if (duration <= 0) {
        return { success: false, error: 'Could not determine audio duration' };
      }

      console.log('[GeminiMap] Duration: ' + duration.toFixed(1) + 's');

      // Smart chunking: evenly divide so each chunk is 2-3 min
      var numChunks = Math.max(1, Math.round(duration / TARGET_CHUNK));
      var chunkSize = duration / numChunks;
      console.log('[GeminiMap] ' + numChunks + ' chunks × ' + chunkSize.toFixed(0) + 's each');

      // Create temp dir
      var tempDir = audioPath.replace(/[^\/]+$/, '') + 'gemini_chunks_' + Date.now();
      try { fs.mkdirSync(tempDir, { recursive: true }); } catch (e) {}

      var chunks = [];
      for (var i = 0; i < numChunks; i++) {
        chunks.push({
          index: i,
          startSec: i * chunkSize,
          duration: (i === numChunks - 1) ? (duration - i * chunkSize) : chunkSize,
          path: tempDir + '/chunk_' + i + '.wav'
        });
      }

      // Process sequentially
      var allSegments = [];
      var detectedLanguage = 'unknown';

      function processChunk(idx) {
        if (idx >= chunks.length) {
          self._cleanup(tempDir, chunks);
          allSegments.sort(function (a, b) { return a.start - b.start; });

          var counts = {};
          allSegments.forEach(function (s) { counts[s.type] = (counts[s.type] || 0) + 1; });
          console.log('[GeminiMap] ✓ Total: ' + allSegments.length + ' segments:', JSON.stringify(counts));

          return {
            success: true,
            segments: allSegments,
            totalSegments: allSegments.length,
            language: detectedLanguage,
            counts: counts
          };
        }

        var chunk = chunks[idx];
        var label = (idx + 1) + '/' + numChunks;
        onProgress(idx, numChunks, 'Mapping chunk ' + label);
        console.log('[GeminiMap] Chunk ' + label + ' [' + chunk.startSec.toFixed(0) + 's-' + (chunk.startSec + chunk.duration).toFixed(0) + 's]');

        return self._extractChunk(audioPath, chunk).then(function (ok) {
          if (!ok) {
            console.log('[GeminiMap] Extract failed for chunk ' + label);
            return processChunk(idx + 1);
          }

          return self._analyzeChunk(chunk, timelineOffset).then(function (result) {
            if (result.success && result.segments.length > 0) {
              allSegments = allSegments.concat(result.segments);
              if (result.language && result.language !== 'unknown') detectedLanguage = result.language;
              console.log('[GeminiMap] Chunk ' + label + ': ' + result.segments.length + ' segments');
            } else {
              console.log('[GeminiMap] Chunk ' + label + ': failed (' + (result.error || 'empty') + ')');
            }
            return processChunk(idx + 1);
          });
        });
      }

      return processChunk(0);
    });
  };

  // ==================== FFMPEG ====================

  AudioAnalyzer.prototype._getAudioDuration = function (audioPath) {
    return new Promise(function (resolve) {
      try {
        var out = childProcess.execSync(
          FFPROBE_PATH + ' -v error -show_entries format=duration -of csv=p=0 "' + audioPath + '"',
          { encoding: 'utf8', timeout: 10000 }
        ).trim();
        var d = parseFloat(out);
        resolve(isNaN(d) ? 0 : d);
      } catch (e) {
        try { resolve(fs.statSync(audioPath).size / 96000); } catch (e2) { resolve(0); }
      }
    });
  };

  AudioAnalyzer.prototype._extractChunk = function (audioPath, chunk) {
    return new Promise(function (resolve) {
      try {
        childProcess.execSync(
          FFMPEG_PATH + ' -y -ss ' + chunk.startSec + ' -i "' + audioPath + '" -t ' + chunk.duration +
          ' -acodec pcm_s16le -ar 16000 -ac 1 "' + chunk.path + '"',
          { encoding: 'utf8', timeout: 30000, stdio: 'pipe' }
        );
        resolve(fs.existsSync(chunk.path));
      } catch (e) { resolve(false); }
    });
  };

  AudioAnalyzer.prototype._cleanup = function (tempDir, chunks) {
    try {
      chunks.forEach(function (c) { try { fs.unlinkSync(c.path); } catch (e) {} });
      fs.rmdirSync(tempDir);
    } catch (e) {}
  };

  // ==================== GEMINI ====================

  AudioAnalyzer.prototype._analyzeChunk = function (chunk, timelineOffset) {
    var self = this;
    var offset = chunk.startSec + timelineOffset;

    var prompt =
      'You are a forensic audio analyst. Listen to EVERY millisecond.\n\n' +
      'Create a segment for EVERY distinct sound. Be EXTREMELY granular:\n\n' +
      'TYPES:\n' +
      '- "speech": Meaningful spoken words. Transcribe exactly in original language.\n' +
      '- "filler": ANY hesitation: آآ, اااا, أه, اه, هم, هممم, يعني (filler), um, uh, أوكي (stalling), طيب (stalling). Even 0.2s!\n' +
      '- "breathing": ANY audible breath — inhale, exhale, sigh. Even subtle!\n' +
      '- "silence": Any gap with no sound, even 0.3s.\n' +
      '- "noise": Background sounds, rustling, wind, clicks, pops, mouth sounds.\n' +
      '- "stutter": Repeated/stuttered words.\n' +
      '- "repeated": Same idea said before in this clip.\n\n' +
      'BE PARANOID:\n' +
      '- Between EVERY sentence there is usually a breath. FIND IT.\n' +
      '- "أوكي" or "طيب" used to stall = FILLER.\n' +
      '- Segments can be 0.2s. Short = GOOD for fillers/breaths.\n' +
      '- Speech = individual sentences (2-10s), NOT long blocks.\n' +
      '- NEVER combine speech + non-speech in one segment.\n' +
      '- Cover start to end, no gaps, no overlaps.\n' +
      '- Do NOT translate.\n\n' +
      'Return JSON:\n' +
      '{"language":"ar","segments":[{"start":0.0,"end":0.3,"type":"noise","text":"rustling"},{"start":0.3,"end":2.1,"type":"speech","text":"..."},{"start":2.1,"end":2.4,"type":"breathing","text":"inhale"}]}';

    var audioData;
    try { audioData = fs.readFileSync(chunk.path); } catch (e) {
      return Promise.resolve({ success: false, error: 'Cannot read chunk' });
    }

    var body = JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'audio/wav', data: audioData.toString('base64') } },
          { text: prompt }
        ]
      }],
      generationConfig: { response_mime_type: 'application/json', temperature: 0.1, max_output_tokens: 65536 }
    });

    return new Promise(function (resolve) {
      var req = https.request({
        hostname: 'generativelanguage.googleapis.com', port: 443,
        path: '/v1beta/models/' + self.model + ':generateContent?key=' + self.apiKey,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, function (res) {
        var chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          var data = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            resolve({ success: false, error: 'API error ' + res.statusCode });
            return;
          }
          try {
            var resp = JSON.parse(data);
            if (!resp.candidates || !resp.candidates.length) {
              resolve({ success: false, error: 'No candidates' });
              return;
            }
            var text = resp.candidates[0].content.parts[0].text;
            var raw = JSON.parse(text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
            var parsed = Array.isArray(raw) ? raw[0] : raw;

            var segs = [];
            (parsed.segments || []).forEach(function (s) {
              if (s.start !== undefined && s.end !== undefined) {
                segs.push({
                  start: parseFloat(s.start) + offset,
                  end: parseFloat(s.end) + offset,
                  type: s.type || 'speech',
                  text: (s.text || '').trim()
                });
              }
            });
            resolve({ success: true, segments: segs, language: parsed.language || 'unknown' });
          } catch (e) {
            resolve({ success: false, error: 'Parse: ' + e.message });
          }
        });
      });
      req.on('error', function (e) { resolve({ success: false, error: e.message }); });
      req.setTimeout(180000, function () { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
      req.write(body);
      req.end();
    });
  };

  return AudioAnalyzer;
})();

if (typeof window !== 'undefined') window.AudioAnalyzer = AudioAnalyzer;
