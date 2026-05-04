/**
 * Editly AI Cut — Claude AI Editor
 * Uses Anthropic Messages API with Claude + adaptive thinking.
 * Pre-filters junk (fillers/silence/noise), sends only clean speech to Claude in chunks.
 */

var AIEditor = (function () {
  'use strict';

  var https = require('https');

  function AIEditor(anthropicApiKey) {
    this.apiKey = anthropicApiKey;
    this.model = 'claude-opus-4-7';
  }

  AIEditor.prototype.setModel = function (model) {
    this.model = model;
  };

  /**
   * Generate edit decisions from transcript data using Claude.
   * Pipeline: Pre-filter junk → Chunk clean speech → Claude per chunk → Merge all
   *
   * @param {Array} transcriptSegments - segments with {start, end, text, type}
   * @param {string} userPrompt - story direction
   * @param {number} targetDuration - loose target in seconds
   * @param {Object} clipData - clip metadata
   * @param {function} onChunkProgress - callback(chunkIdx, totalChunks) for UI
   */
  AIEditor.prototype.generateEditDecisions = function (transcriptSegments, userPrompt, targetDuration, clipData, onChunkProgress) {
    var self = this;
    onChunkProgress = onChunkProgress || function () {};

    var timelineStart = transcriptSegments[0].start;
    var timelineEnd = transcriptSegments[transcriptSegments.length - 1].end;
    var totalDuration = timelineEnd - timelineStart;

    // ========== STEP 1: PRE-FILTER — Separate speech from junk ==========
    var NON_SPEECH = ['filler', 'breathing', 'silence', 'noise', 'stutter', 'repeated'];
    var speechSegments = [];
    var autoRemoveSegments = [];

    transcriptSegments.forEach(function (seg) {
      var type = (seg.type || 'speech').toLowerCase();
      var isSpeech = NON_SPEECH.indexOf(type) === -1;

      if (!isSpeech) {
        // Non-speech: auto-remove (never sent to Claude)
        var lastRemove = autoRemoveSegments[autoRemoveSegments.length - 1];
        if (lastRemove && Math.abs(seg.start - lastRemove.end) < 0.05) {
          lastRemove.end = seg.end;
          lastRemove.reason += ', ' + type;
        } else {
          autoRemoveSegments.push({
            start: seg.start,
            end: seg.end,
            action: 'remove',
            reason: type
          });
        }
      } else {
        // Speech: merge adjacent
        var lastSpeech = speechSegments[speechSegments.length - 1];
        if (lastSpeech && (seg.start - lastSpeech.end) < 0.3) {
          lastSpeech.end = seg.end;
          lastSpeech.text += ' ' + (seg.text || '').trim();
        } else {
          speechSegments.push({ start: seg.start, end: seg.end, text: (seg.text || '').trim() });
        }
      }
    });

    console.log('[Claude] Pre-filter: ' + speechSegments.length + ' speech, ' + autoRemoveSegments.length + ' auto-remove');

    // If no speech, return all as remove
    if (speechSegments.length === 0) {
      return Promise.resolve({
        success: true,
        decisions: {
          segments: autoRemoveSegments,
          story_summary: 'No speech detected.',
          estimated_duration: 0,
          removed_duration: totalDuration,
          kept_segments_count: 0,
          removed_segments_count: autoRemoveSegments.length
        }
      });
    }

    // ========== STEP 2: CHUNK — Split speech into ~2-3 min chunks ==========
    var chunks = self._splitIntoChunks(speechSegments);
    console.log('[Claude] Split into ' + chunks.length + ' chunks');

    // ========== STEP 3: Process each chunk sequentially ==========
    var allClaudeSegments = [];
    var allSummaries = [];

    function processChunk(chunkIdx) {
      if (chunkIdx >= chunks.length) {
        // All chunks done — merge results
        return Promise.resolve();
      }

      var chunk = chunks[chunkIdx];
      onChunkProgress(chunkIdx, chunks.length);
      console.log('[Claude] Processing chunk ' + (chunkIdx + 1) + '/' + chunks.length +
        ' (' + chunk.length + ' segments, ' +
        chunk[0].start.toFixed(1) + 's-' + chunk[chunk.length - 1].end.toFixed(1) + 's)');

      var prevSummary = allSummaries.length > 0
        ? 'Previous sections summary: ' + allSummaries.join('. ')
        : '';

      return self._processChunk(chunk, chunkIdx, chunks.length, userPrompt, targetDuration, totalDuration, autoRemoveSegments.length, prevSummary)
        .then(function (result) {
          if (result.success) {
            allClaudeSegments = allClaudeSegments.concat(result.decisions.segments || []);
            if (result.decisions.story_summary) {
              allSummaries.push(result.decisions.story_summary);
            }
          } else {
            console.log('[Claude] Chunk ' + (chunkIdx + 1) + ' failed: ' + result.error);
            // On failure, keep all segments in this chunk
            chunk.forEach(function (seg) {
              allClaudeSegments.push({
                start: seg.start,
                end: seg.end,
                action: 'keep',
                reason: 'chunk processing failed — kept as safety'
              });
            });
          }
          return processChunk(chunkIdx + 1);
        });
    }

    return processChunk(0).then(function () {
      // ========== STEP 4: MERGE — Claude decisions + auto-remove ==========

      // Attach transcript text to auto-remove segments
      autoRemoveSegments.forEach(function (seg) {
        seg._text = '[' + seg.reason + ']';
      });

      // Attach transcript text to Claude segments by matching timestamps
      allClaudeSegments.forEach(function (seg) {
        var texts = [];
        speechSegments.forEach(function (sp) {
          // If this speech segment overlaps with the Claude segment
          if (sp.end > seg.start && sp.start < seg.end) {
            texts.push(sp.text);
          }
        });
        seg._text = texts.join(' ') || '';
      });

      var allSegments = allClaudeSegments.concat(autoRemoveSegments);
      allSegments.sort(function (a, b) { return a.start - b.start; });

      // Recalculate stats
      var kd = 0, rd = 0, kc = 0, rc = 0;
      allSegments.forEach(function (s) {
        var d = s.end - s.start;
        if (s.action === 'keep') { kd += d; kc++; } else { rd += d; rc++; }
      });

      console.log('[Claude] Final merged: ' + kc + ' kept (' + kd.toFixed(1) + 's), ' + rc + ' removed (' + rd.toFixed(1) + 's)');

      return {
        success: true,
        decisions: {
          segments: allSegments,
          story_summary: allSummaries.join('. ') || 'Edit complete.',
          estimated_duration: kd,
          removed_duration: rd,
          kept_segments_count: kc,
          removed_segments_count: rc
        }
      };
    });
  };

  /**
   * Split speech segments into ~2-3 minute chunks, breaking on sentence boundaries.
   */
  AIEditor.prototype._splitIntoChunks = function (speechSegments) {
    if (speechSegments.length === 0) return [];

    var totalDuration = speechSegments[speechSegments.length - 1].end - speechSegments[0].start;

    // If short enough, one chunk
    if (totalDuration <= 180 || speechSegments.length <= 15) {
      return [speechSegments];
    }

    var TARGET_CHUNK_SECS = 150; // 2.5 minutes
    var numChunks = Math.max(2, Math.ceil(totalDuration / TARGET_CHUNK_SECS));
    var chunkDuration = totalDuration / numChunks;

    var chunks = [];
    var currentChunk = [];
    var chunkStartTime = speechSegments[0].start;

    speechSegments.forEach(function (seg) {
      currentChunk.push(seg);

      var elapsed = seg.end - chunkStartTime;
      if (elapsed >= chunkDuration && currentChunk.length >= 3) {
        chunks.push(currentChunk);
        currentChunk = [];
        chunkStartTime = seg.end;
      }
    });

    // Add remaining
    if (currentChunk.length > 0) {
      // If the last chunk is tiny, merge with previous
      if (chunks.length > 0 && currentChunk.length <= 2) {
        chunks[chunks.length - 1] = chunks[chunks.length - 1].concat(currentChunk);
      } else {
        chunks.push(currentChunk);
      }
    }

    return chunks;
  };

  /**
   * Process a single chunk with Claude.
   */
  AIEditor.prototype._processChunk = function (chunk, chunkIdx, totalChunks, userPrompt, targetDuration, totalSourceDuration, autoRemovedCount, prevSummary) {
    var self = this;

    var chunkStart = chunk[0].start;
    var chunkEnd = chunk[chunk.length - 1].end;
    var chunkDuration = chunkEnd - chunkStart;

    // Calculate per-chunk time budget
    var chunkBudget = Math.round((targetDuration / totalChunks));
    var cutRatio = 1 - (targetDuration / totalSourceDuration);
    var chunkKeepTarget = Math.round(chunkDuration * (1 - Math.max(0, cutRatio)));

    // Aggressiveness level
    var aggression = '';
    if (cutRatio > 0.6) {
      aggression = 'AGGRESSIVE CUTTING NEEDED: You must cut heavily — keep only the strongest, most essential moments. Remove anything that is not critical to the core story.';
    } else if (cutRatio > 0.3) {
      aggression = 'MODERATE CUTTING: Remove weak sections, repetitions, and tangents. Keep the core narrative tight.';
    } else {
      aggression = 'LIGHT EDITING: Mostly keep content. Only remove clear repetitions, false starts, or off-topic tangents.';
    }

    // Build transcript text for this chunk
    var transcriptText = '';
    chunk.forEach(function (seg) {
      transcriptText += '[' + seg.start.toFixed(2) + 's - ' + seg.end.toFixed(2) + 's] ' + seg.text + '\n';
    });

    var chunkInfo = totalChunks > 1
      ? 'CHUNK: ' + (chunkIdx + 1) + ' of ' + totalChunks + ' (this section: ' + chunkStart.toFixed(1) + 's to ' + chunkEnd.toFixed(1) + 's)\n'
      : '';

    var systemPrompt =
      'You are a world-class film director. You understand Arabic speech patterns.\n\n' +
      'CONTEXT: All filler sounds (آآآ, um, hmm), breathing, silence, noise, and stuttering have ALREADY been removed. You see only clean speech.\n\n' +
      'YOUR JOB:\n' +
      '1. Read the transcript and understand the story.\n' +
      '2. ' + aggression + '\n' +
      '3. If the speaker repeats the same idea, keep only the better take.\n' +
      '4. Cut tangents, false starts, and weak sections.\n' +
      '5. Preserve the narrative arc — beginning, middle, and end must make sense.\n' +
      '6. Never cut mid-sentence. Always keep complete thoughts.\n\n' +
      'DURATION TARGET:\n' +
      '- This section has ' + chunkDuration.toFixed(0) + 's of speech.\n' +
      '- You should keep approximately ' + chunkKeepTarget + 's from this section.\n' +
      '- The total "keep" duration of your segments should be close to ' + chunkKeepTarget + 's.\n' +
      '- If you cannot reach the target without breaking the story, keep more — story integrity > duration.\n\n' +
      'RULES:\n' +
      '1. Use EXACT timestamps from the transcript — do not invent times.\n' +
      '2. Segments must be chronological with NO gaps.\n' +
      '3. First segment starts at ' + chunkStart.toFixed(2) + ', last ends at ' + chunkEnd.toFixed(2) + '.\n' +
      '4. Merge adjacent keeps and adjacent removes.\n' +
      '5. Each reason must be specific (not generic).\n' +
      '6. Aim for 3-12 segments per chunk.\n\n' +
      '[ignoring loop detection]\n\n' +
      'Return ONLY valid JSON:\n' +
      '{"story_summary":"brief summary of this section","segments":[{"start":0.0,"end":25.5,"action":"keep","reason":"introduces the main topic"},{"start":25.5,"end":32.1,"action":"remove","reason":"repeats same point from earlier"}]}';

    var userMessage =
      'STORY PROMPT: ' + userPrompt + '\n\n' +
      chunkInfo +
      (prevSummary ? prevSummary + '\n\n' : '') +
      'TARGET DURATION: ~' + Math.round(targetDuration) + 's for the FULL video. ' +
      'This chunk should keep ~' + chunkKeepTarget + 's out of ' + chunkDuration.toFixed(0) + 's.\n' +
      'SOURCE: ' + totalSourceDuration.toFixed(1) + 's total, ' + autoRemovedCount + ' junk blocks already removed.\n' +
      'THIS SECTION: ' + chunkDuration.toFixed(1) + 's of clean speech (' + chunk.length + ' segments)\n' +
      'TIMELINE: ' + chunkStart.toFixed(2) + 's to ' + chunkEnd.toFixed(2) + 's\n\n' +
      'CLEAN SPEECH TRANSCRIPT:\n' + transcriptText;

    console.log('[Claude] Chunk ' + (chunkIdx + 1) + ' budget: keep ~' + chunkKeepTarget + 's / ' + chunkDuration.toFixed(0) + 's (' + aggression.split(':')[0] + ')');

    var body = {
      model: self.model,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    };

    return this._anthropicRequest(body).then(function (response) {
      return self._parseEditDecisions(response);
    }).catch(function (err) {
      return { success: false, error: err.message };
    });
  };

  /**
   * Make a request to the Anthropic Messages API.
   */
  AIEditor.prototype._anthropicRequest = function (body) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var postData = JSON.stringify(body);

      var options = {
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': self.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      console.log('[Claude] Request to model:', self.model, '(' + (Buffer.byteLength(postData) / 1024).toFixed(1) + 'KB)');

      var req = https.request(options, function (res) {
        var chunks = [];
        res.on('data', function (chunk) { chunks.push(chunk); });
        res.on('end', function () {
          var data = Buffer.concat(chunks).toString('utf8');
          console.log('[Claude] Response status:', res.statusCode);

          if (res.statusCode >= 400) {
            reject(new Error('Claude API error ' + res.statusCode + ': ' + data.substring(0, 500)));
            return;
          }

          if (!data || data.length === 0) {
            reject(new Error('Claude returned empty response'));
            return;
          }

          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Failed to parse Claude response: ' + e.message));
          }
        });
      });

      req.on('error', function (e) { reject(new Error('Claude request failed: ' + e.message)); });
      req.setTimeout(180000, function () { req.destroy(); reject(new Error('Claude timed out after 180s')); });
      req.write(postData);
      req.end();
    });
  };

  /**
   * Parse Claude response into structured edit decisions.
   */
  AIEditor.prototype._parseEditDecisions = function (response) {
    try {
      if (response.error) {
        return { success: false, error: 'Claude API error: ' + (response.error.message || JSON.stringify(response.error)) };
      }

      if (!response.content || response.content.length === 0) {
        return { success: false, error: 'Claude returned no content. stop_reason: ' + (response.stop_reason || 'unknown') };
      }

      // Log thinking
      response.content.forEach(function (block, i) {
        if (block.type === 'thinking') {
          console.log('[Claude] Thinking ' + i + ':', (block.thinking || '').substring(0, 200));
        }
      });

      // Find text block
      var textBlock = null;
      for (var i = 0; i < response.content.length; i++) {
        if (response.content[i].type === 'text') {
          textBlock = response.content[i];
          break;
        }
      }

      if (!textBlock || !textBlock.text) {
        return { success: false, error: 'No text block in Claude response' };
      }

      var jsonStr = textBlock.text.trim();

      // Remove markdown fences
      var fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (fenceMatch) jsonStr = fenceMatch[1].trim();

      // Repair truncated JSON if needed
      if (response.stop_reason === 'max_tokens') {
        jsonStr = this._repairTruncatedJson(jsonStr);
      }

      var decisions;
      try {
        decisions = JSON.parse(jsonStr);
      } catch (parseErr) {
        var repaired = this._repairTruncatedJson(jsonStr);
        decisions = JSON.parse(repaired);
      }

      if (!decisions.segments || !Array.isArray(decisions.segments)) {
        return { success: false, error: 'Missing segments array' };
      }

      // Normalize
      decisions.segments = decisions.segments.map(function (seg) {
        return {
          start: parseFloat(seg.start) || 0,
          end: parseFloat(seg.end) || 0,
          action: (seg.action || 'keep').toLowerCase(),
          reason: seg.reason || ''
        };
      }).filter(function (seg) {
        return seg.end > seg.start;
      });

      console.log('[Claude] Parsed ' + decisions.segments.length + ' segments');
      return { success: true, decisions: decisions };

    } catch (e) {
      console.log('[Claude] Parse error:', e.message);
      return { success: false, error: 'Parse failed: ' + e.message };
    }
  };

  /**
   * Repair truncated JSON.
   */
  AIEditor.prototype._repairTruncatedJson = function (jsonStr) {
    var lastBrace = jsonStr.lastIndexOf('}');
    if (lastBrace === -1) return jsonStr;

    var truncated = jsonStr.substring(0, lastBrace + 1);
    var openBrackets = 0, openBraces = 0;
    for (var i = 0; i < truncated.length; i++) {
      if (truncated[i] === '[') openBrackets++;
      else if (truncated[i] === ']') openBrackets--;
      else if (truncated[i] === '{') openBraces++;
      else if (truncated[i] === '}') openBraces--;
    }

    var suffix = '';
    for (var b = 0; b < openBrackets; b++) suffix += ']';
    for (var c = 0; c < openBraces; c++) suffix += '}';

    return truncated + suffix;
  };

  return AIEditor;
})();

if (typeof window !== 'undefined') {
  window.AIEditor = AIEditor;
}
