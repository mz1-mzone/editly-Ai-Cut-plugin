/**
 * Editly AI Cut — ElevenLabs Speech-to-Text
 * Uses ElevenLabs Scribe API directly for audio transcription.
 */

var TranscriptionPipeline = (function () {
  'use strict';

  var fs = require('fs');
  var path = require('path');
  var https = require('https');

  function TranscriptionPipeline(elevenLabsApiKey) {
    this.apiKey = elevenLabsApiKey;
  }

  /**
   * Transcribe audio using ElevenLabs Scribe v2.
   * Sends the WAV file as multipart/form-data.
   * Returns timestamped transcript segments.
   */
  TranscriptionPipeline.prototype.transcribe = function (filePath, model, timelineOffset) {
    var self = this;
    timelineOffset = timelineOffset || 0;

    return new Promise(function (resolve, reject) {
      // Read the audio file
      var fileData;
      try {
        fileData = fs.readFileSync(filePath);
      } catch (e) {
        reject(new Error('Cannot read audio file: ' + e.message));
        return;
      }

      var fileName = path.basename(filePath);
      var boundary = '----EditlyBoundary' + Date.now();

      // Build multipart form data
      var bodyParts = [];

      // model_id field
      bodyParts.push(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="model_id"\r\n\r\n' +
        'scribe_v2\r\n'
      );

      // timestamps_granularity field — request word-level timestamps
      bodyParts.push(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="timestamps_granularity"\r\n\r\n' +
        'word\r\n'
      );

      // file field header
      var fileHeader =
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="file"; filename="' + fileName + '"\r\n' +
        'Content-Type: audio/wav\r\n\r\n';

      var fileFooter = '\r\n--' + boundary + '--\r\n';

      // Combine all parts
      var headerBuffer = Buffer.from(bodyParts.join('') + fileHeader, 'utf8');
      var footerBuffer = Buffer.from(fileFooter, 'utf8');
      var bodyBuffer = Buffer.concat([headerBuffer, fileData, footerBuffer]);

      var options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/speech-to-text',
        method: 'POST',
        headers: {
          'xi-api-key': self.apiKey,
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': bodyBuffer.length
        }
      };

      console.log('[ElevenLabs] Sending ' + (fileData.length / 1024 / 1024).toFixed(1) + 'MB audio for transcription...');

      var req = https.request(options, function (res) {
        var data = '';
        res.on('data', function (chunk) { data += chunk; });
        res.on('end', function () {
          console.log('[ElevenLabs] Response status:', res.statusCode);
          console.log('[ElevenLabs] Response body (first 500 chars):', data.substring(0, 500));

          if (res.statusCode >= 400) {
            reject(new Error('ElevenLabs API error ' + res.statusCode + ': ' + data.substring(0, 300)));
            return;
          }

          try {
            var result = JSON.parse(data);
            var segments = self._parseElevenLabsResponse(result, timelineOffset);
            resolve(segments);
          } catch (e) {
            reject(new Error('Failed to parse ElevenLabs response: ' + e.message));
          }
        });
      });

      req.on('error', function (e) {
        reject(new Error('ElevenLabs request failed: ' + e.message));
      });

      req.setTimeout(180000, function () {
        req.destroy();
        reject(new Error('ElevenLabs request timed out after 180 seconds'));
      });

      req.write(bodyBuffer);
      req.end();
    });
  };

  /**
   * Parse ElevenLabs Scribe response into our standard segment format.
   * Response schema: { language_code, language_probability, text, words[], transcription_id }
   * Or multichannel: { transcripts: [{ language_code, text, words[] }] }
   * Word schema: { text, start, end, type: 'word'|'spacing'|'audio_event', speaker_id }
   */
  TranscriptionPipeline.prototype._parseElevenLabsResponse = function (result, offset) {
    var segments = [];

    // Handle multichannel response — merge all transcripts
    var words = [];
    var fullText = '';
    var languageCode = 'unknown';

    if (result.transcripts && result.transcripts.length > 0) {
      result.transcripts.forEach(function (transcript) {
        if (transcript.words) words = words.concat(transcript.words);
        if (transcript.text) fullText += (fullText ? ' ' : '') + transcript.text;
        if (transcript.language_code) languageCode = transcript.language_code;
      });
    } else {
      words = result.words || [];
      fullText = result.text || '';
      languageCode = result.language_code || 'unknown';
    }

    console.log('[ElevenLabs] Parsed ' + words.length + ' words, language: ' + languageCode);

    if (words.length > 0) {
      // Filter to only actual words (skip 'spacing' and 'audio_event')
      var actualWords = words.filter(function (w) {
        return w.type === 'word' && w.start !== null && w.start !== undefined;
      });

      console.log('[ElevenLabs] ' + actualWords.length + ' actual words after filtering');

      // ---- FILLER DETECTION ----
      // Focused on: AAAA sounds + breathing + BTS cues
      var FILLER_PATTERNS = [
        // "AAAA" type sounds — all spellings ElevenLabs might use
        'a', 'aa', 'aaa', 'aaaa', 'aaaaa',
        'ah', 'ahh', 'ahhh', 'ahhhh',
        'uh', 'uhh', 'uhhh',
        'um', 'umm', 'ummm', 'uhm',
        'oh', 'ohh', 'ohhh',
        'eh', 'ehh', 'ehhh',
        'er', 'err', 'errr', 'erm',
        'hm', 'hmm', 'hmmm', 'hmmmm',
        'mm', 'mmm', 'mmmm',
        'uh huh', 'uh-huh', 'mhm', 'mhmm',
        // Arabic fillers
        'آآآ', 'اممم', 'هممم', 'اه', 'آه',
        // BTS: Single-word director cues
        'action', 'cut', 'rolling', 'speed', 'marker', 'slate',
        'clap', 'take', 'reset', 'again', 'go', 'ready', 'ok', 'okay',
        // BTS: Arabic false starts / director cues
        'لا', 'خلاص', 'وقف', 'يلا', 'بس', 'طيب', 'تمام', 'اوكي',
        // Countdown numbers (standalone)
        'one', 'two', 'three', 'four', 'five',
        'واحد', 'اثنين', 'ثلاثة', 'أربعة', 'خمسة'
      ];

      // BTS: Multi-word patterns (checked against adjacent words)
      var BTS_PHRASES = [
        'one two three', 'three two one',
        'one two', 'two one', 'three two',
        'two three', 'one two three four', 'ready go',
        'واحد اثنين ثلاثة', 'ثلاثة اثنين واحد'
      ];

      // Catch ANY repeated vowel/nasal sound (2+ repeats): aa, oo, ee, mm, hh
      var REPEATED_SOUND_REGEX = /^([aeiouhm])\1{1,}$/i;

      // First pass: detect BTS phrases in adjacent words
      var btsRanges = [];
      for (var p = 0; p < actualWords.length; p++) {
        for (var phraseLen = 4; phraseLen >= 2; phraseLen--) {
          if (p + phraseLen > actualWords.length) continue;
          var phraseWords = [];
          for (var pw = 0; pw < phraseLen; pw++) {
            phraseWords.push((actualWords[p + pw].text || '').toLowerCase().replace(/[.,!?؟،;:'"]/g, '').trim());
          }
          var phrase = phraseWords.join(' ');
          var isPhrase = false;
          for (var bp = 0; bp < BTS_PHRASES.length; bp++) {
            if (phrase === BTS_PHRASES[bp]) { isPhrase = true; break; }
          }
          if (isPhrase) {
            for (var m = 0; m < phraseLen; m++) {
              actualWords[p + m]._isFiller = true;
            }
            btsRanges.push(phrase);
            p += phraseLen - 1;
            break;
          }
        }
      }

      if (btsRanges.length > 0) {
        console.log('[ElevenLabs] Detected BTS phrases: ' + btsRanges.join(', '));
      }

      var fillerCount = 0;
      actualWords.forEach(function (w) {
        if (w._isFiller) { fillerCount++; return; } // already marked by BTS phrase pass
        if (!w.text) return;
        var lower = w.text.toLowerCase().replace(/[.,!?؟،;:'"]/g, '').trim();
        if (!lower) return;

        var isFiller = false;

        // 1. Known filler sounds + BTS cues
        if (FILLER_PATTERNS.indexOf(lower) >= 0) {
          isFiller = true;
        }

        // 2. Any repeated vowel/nasal: aa, ooo, mmmm, hhh, eee
        if (!isFiller && REPEATED_SOUND_REGEX.test(lower)) {
          isFiller = true;
        }

        if (isFiller) {
          w._isFiller = true;
          fillerCount++;
        }
      });

      console.log('[ElevenLabs] Detected ' + fillerCount + ' filler words/sounds');

      if (actualWords.length === 0) {
        return {
          success: true, segments: [], totalSegments: 0,
          language: languageCode, fullText: fullText
        };
      }

      // Sort by start time
      actualWords.sort(function (a, b) { return a.start - b.start; });

      // Build segments with explicit silence/breathing detection
      var SILENCE_THRESHOLD = 0.2; // seconds — catches short breaths too
      var currentSegment = { start: null, end: null, words: [] };
      var sentenceEnders = ['.', '!', '?', '،', '。', '؟'];

      for (var i = 0; i < actualWords.length; i++) {
        var word = actualWords[i];
        var wordStart = word.start + offset;
        var wordEnd = (word.end || word.start) + offset;
        var wordText = word.text || '';

        // Check for silence gap BEFORE this word
        if (currentSegment.end !== null) {
          var gap = wordStart - currentSegment.end;
          if (gap > SILENCE_THRESHOLD) {
            // Flush current segment first
            if (currentSegment.words.length > 0) {
              segments.push({
                start: currentSegment.start,
                end: currentSegment.end,
                text: currentSegment.words.join(' '),
                type: 'speech'
              });
            }
            // Insert explicit silence segment
            segments.push({
              start: currentSegment.end,
              end: wordStart,
              text: '[silence ' + gap.toFixed(1) + 's]',
              type: 'silence'
            });
            currentSegment = { start: null, end: null, words: [] };
          }
        }

        // Handle filler words — create separate [FILLER] segment
        if (word._isFiller) {
          // Flush current speech segment first
          if (currentSegment.words.length > 0) {
            segments.push({
              start: currentSegment.start,
              end: currentSegment.end,
              text: currentSegment.words.join(' ')
            });
            currentSegment = { start: null, end: null, words: [] };
          }
          // Add filler as its own tagged segment
          segments.push({
            start: wordStart,
            end: wordEnd,
            text: wordText,
            type: 'filler'
          });
          continue;
        }

        // Initialize or continue segment
        if (currentSegment.start === null) {
          currentSegment.start = wordStart;
        }
        currentSegment.end = wordEnd;
        currentSegment.words.push(wordText);

        // Break on sentence end or every ~10 words
        var lastChar = wordText.charAt(wordText.length - 1);
        var isSentenceEnd = sentenceEnders.indexOf(lastChar) >= 0;
        var isLastWord = (i === actualWords.length - 1);

        if (isSentenceEnd || currentSegment.words.length >= 10 || isLastWord) {
          if (currentSegment.words.length > 0) {
            segments.push({
              start: currentSegment.start,
              end: currentSegment.end,
              text: currentSegment.words.join(' '),
              type: 'speech'
            });
          }
          currentSegment = { start: null, end: null, words: [] };
        }
      }

      // Check for trailing silence at end
      var lastWord = actualWords[actualWords.length - 1];
      var audioDuration = result.audio_duration_secs || 0;
      if (audioDuration > 0) {
        var trailingGap = (audioDuration + offset) - (lastWord.end + offset);
        if (trailingGap > SILENCE_THRESHOLD) {
          segments.push({
            start: lastWord.end + offset,
            end: audioDuration + offset,
            text: '[silence ' + trailingGap.toFixed(1) + 's]',
            type: 'silence'
          });
        }
      }

      // Check for leading silence
      if (actualWords[0].start > SILENCE_THRESHOLD) {
        segments.unshift({
          start: offset,
          end: actualWords[0].start + offset,
          text: '[silence ' + actualWords[0].start.toFixed(1) + 's]',
          type: 'silence'
        });
      }

    } else if (fullText) {
      var dur = result.audio_duration_secs || 60;
      segments.push({
        start: offset,
        end: offset + dur,
        text: fullText.trim(),
        type: 'speech'
      });
    }

    // Sort by start time
    segments.sort(function (a, b) { return a.start - b.start; });

    var silenceCount = segments.filter(function (s) { return s.text.indexOf('[SILENCE') === 0; }).length;
    console.log('[ElevenLabs] Final segments: ' + segments.length + ' (' + silenceCount + ' silence gaps detected)');
    if (segments.length > 0) {
      console.log('[ElevenLabs] First segment:', JSON.stringify(segments[0]).substring(0, 200));
      console.log('[ElevenLabs] Last segment:', JSON.stringify(segments[segments.length - 1]).substring(0, 200));
    }

    return {
      success: true,
      segments: segments,
      totalSegments: segments.length,
      language: languageCode,
      fullText: fullText || segments.map(function (s) { return s.text; }).join(' ')
    };
  };

  return TranscriptionPipeline;
})();

if (typeof window !== 'undefined') {
  window.TranscriptionPipeline = TranscriptionPipeline;
}
