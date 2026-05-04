/**
 * Editly AI Cut — Claude AI Editor
 * Uses Anthropic Messages API directly with Claude Opus 4.7 + adaptive thinking.
 */

var AIEditor = (function () {
  'use strict';

  var https = require('https');

  function AIEditor(anthropicApiKey) {
    this.apiKey = anthropicApiKey;
    this.model = 'claude-opus-4-7';
  }

  /**
   * Set the Claude model to use.
   */
  AIEditor.prototype.setModel = function (model) {
    this.model = model;
  };

  /**
   * Generate edit decisions from transcript data using Claude.
   */
  AIEditor.prototype.generateEditDecisions = function (transcriptSegments, userPrompt, targetDuration, clipData) {
    var self = this;

    var timelineStart = transcriptSegments[0].start;
    var timelineEnd = transcriptSegments[transcriptSegments.length - 1].end;
    var totalDuration = timelineEnd - timelineStart;

    // ========== PRE-MERGE: Combine adjacent non-speech into blocks ==========
    // This prevents Claude from outputting 30+ identical "remove filler" segments
    var NON_SPEECH = ['filler', 'breathing', 'silence', 'noise', 'stutter', 'repeated'];
    var merged = [];
    var autoRemoveSegments = [];

    transcriptSegments.forEach(function (seg) {
      var type = (seg.type || 'speech').toLowerCase();
      var isSpeech = NON_SPEECH.indexOf(type) === -1;

      if (!isSpeech) {
        // Non-speech: auto-remove (don't send to Claude at all)
        var lastRemove = autoRemoveSegments[autoRemoveSegments.length - 1];
        if (lastRemove && Math.abs(seg.start - lastRemove.end) < 0.05) {
          // Merge with previous non-speech block
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
        // Speech: send to Claude for story decisions
        var lastSpeech = merged[merged.length - 1];
        if (lastSpeech && (seg.start - lastSpeech.end) < 0.3) {
          // Merge adjacent speech segments
          lastSpeech.end = seg.end;
          lastSpeech.text += ' ' + (seg.text || '').trim();
        } else {
          merged.push({ start: seg.start, end: seg.end, text: (seg.text || '').trim() });
        }
      }
    });

    console.log('[Claude] Speech segments: ' + merged.length + ', auto-remove blocks: ' + autoRemoveSegments.length);

    // If no speech, return all as remove
    if (merged.length === 0) {
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

    // Build transcript for Claude — speech segments only
    var transcriptText = '';
    merged.forEach(function (seg) {
      transcriptText += '[' + seg.start.toFixed(2) + 's - ' + seg.end.toFixed(2) + 's] ' + seg.text + '\n';
    });

    var systemPrompt =
      'You are a world-class film director. You understand Arabic speech patterns.\n\n' +
      'CONTEXT: All filler sounds (آآآ, um, hmm), breathing, silence, noise, and stuttering have ALREADY been removed from this transcript. You see only clean speech.\n\n' +
      'YOUR JOB:\n' +
      '1. Read the transcript and understand the story.\n' +
      '2. If the speaker repeats the same idea, keep only the better version.\n' +
      '3. Cut tangents and weak sections.\n' +
      '4. When in doubt, KEEP.\n\n' +
      'RULES:\n' +
      '1. Use EXACT timestamps from the transcript.\n' +
      '2. Segments must be chronological, NO gaps between them.\n' +
      '3. Merge adjacent keeps and adjacent removes.\n' +
      '4. First segment starts at ' + merged[0].start.toFixed(2) + ', last ends at ' + merged[merged.length - 1].end.toFixed(2) + '.\n' +
      '5. Each reason must be unique and specific.\n' +
      '6. Aim for 5-20 total segments.\n\n' +
      '[ignoring loop detection]\n\n' +
      'Return ONLY valid JSON:\n' +
      '{"story_summary":"...","segments":[{"start":0.0,"end":25.5,"action":"keep","reason":"strong story opening"},{"start":25.5,"end":32.1,"action":"remove","reason":"off-topic tangent about unrelated subject"},{"start":32.1,"end":55.0,"action":"keep","reason":"emotional core of the story"}],"estimated_duration":60,"removed_duration":10,"kept_segments_count":3,"removed_segments_count":1}';

    var userMessage =
      'STORY PROMPT: ' + userPrompt +
      '\n\nDURATION: ~' + Math.round(targetDuration) + 's suggested (loose guide — keep the story intact).' +
      '\nSOURCE: ' + totalDuration.toFixed(1) + 's total (' + autoRemoveSegments.length + ' junk blocks already removed)' +
      '\nTIMELINE: ' + merged[0].start.toFixed(2) + 's to ' + merged[merged.length - 1].end.toFixed(2) + 's' +
      '\n\nCLEAN SPEECH TRANSCRIPT:\n' + transcriptText;

    var body = {
      model: self.model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    };

    return this._anthropicRequest(body).then(function (response) {
      var result = self._parseEditDecisions(response);
      if (!result.success) return result;

      // Merge Claude's speech decisions with auto-removed junk
      var claudeSegments = result.decisions.segments || [];
      var allSegments = claudeSegments.concat(autoRemoveSegments);
      allSegments.sort(function (a, b) { return a.start - b.start; });

      // Recalculate stats
      var kd = 0, rd = 0, kc = 0, rc = 0;
      allSegments.forEach(function (s) {
        var d = s.end - s.start;
        if (s.action === 'keep') { kd += d; kc++; } else { rd += d; rc++; }
      });

      result.decisions.segments = allSegments;
      result.decisions.estimated_duration = kd;
      result.decisions.removed_duration = rd;
      result.decisions.kept_segments_count = kc;
      result.decisions.removed_segments_count = rc;

      console.log('[Claude] Final: ' + kc + ' kept (' + kd.toFixed(1) + 's), ' + rc + ' removed (' + rd.toFixed(1) + 's)');
      return result;
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

      console.log('[Claude] Sending request to model:', self.model);
      console.log('[Claude] Request size:', (Buffer.byteLength(postData) / 1024).toFixed(1) + 'KB');

      var req = https.request(options, function (res) {
        var chunks = [];
        res.on('data', function (chunk) { chunks.push(chunk); });
        res.on('end', function () {
          var data = Buffer.concat(chunks).toString('utf8');
          console.log('[Claude] Response status:', res.statusCode);
          console.log('[Claude] Response size:', data.length, 'chars');
          console.log('[Claude] Response (first 500 chars):', data.substring(0, 500));

          if (res.statusCode >= 400) {
            console.log('[Claude] Error response:', data.substring(0, 800));
            reject(new Error('Claude API error ' + res.statusCode + ': ' + data.substring(0, 500)));
            return;
          }

          if (!data || data.length === 0) {
            reject(new Error('Claude returned empty response'));
            return;
          }

          try {
            var parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) {
            console.log('[Claude] FULL raw response:', data.substring(0, 2000));
            reject(new Error('Failed to parse Claude API response: ' + e.message));
          }
        });
      });

      req.on('error', function (e) {
        reject(new Error('Claude request failed: ' + e.message));
      });

      req.setTimeout(180000, function () {
        req.destroy();
        reject(new Error('Claude request timed out after 180s'));
      });

      req.write(postData);
      req.end();
    });
  };

  /**
   * Parse the Claude response into structured edit decisions.
   * Response format: { content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "..." }] }
   */
  AIEditor.prototype._parseEditDecisions = function (response) {
    try {
      console.log('[Claude] Response keys:', Object.keys(response));

      // Check for API-level errors
      if (response.error) {
        return {
          success: false,
          error: 'Claude API error: ' + (response.error.message || JSON.stringify(response.error))
        };
      }

      // Check content exists
      if (!response.content || response.content.length === 0) {
        console.log('[Claude] No content! Full response:', JSON.stringify(response).substring(0, 1000));
        return {
          success: false,
          error: 'Claude returned no content. stop_reason: ' + (response.stop_reason || 'unknown')
        };
      }

      // Log thinking if present
      response.content.forEach(function (block, i) {
        if (block.type === 'thinking') {
          console.log('[Claude] Thinking block ' + i + ' (first 300 chars):', (block.thinking || '').substring(0, 300));
        }
      });

      // Find the text block (the actual response)
      var textBlock = null;
      for (var i = 0; i < response.content.length; i++) {
        if (response.content[i].type === 'text') {
          textBlock = response.content[i];
          break;
        }
      }

      if (!textBlock || !textBlock.text) {
        console.log('[Claude] No text block found! Content types:', response.content.map(function (b) { return b.type; }));
        return {
          success: false,
          error: 'Claude response has no text block. stop_reason: ' + (response.stop_reason || 'unknown')
        };
      }

      var content = textBlock.text;
      console.log('[Claude] Text content length:', content.length);
      console.log('[Claude] Text (first 300):', content.substring(0, 300));
      console.log('[Claude] Text (last 200):', content.substring(content.length - 200));
      console.log('[Claude] stop_reason:', response.stop_reason);

      // Check if response was cut off
      if (response.stop_reason === 'max_tokens') {
        console.log('[Claude] WARNING: Response was truncated!');
      }

      // Clean the content
      var jsonStr = content.trim();

      // Remove markdown fences if present
      var fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
      }

      // If truncated, try to repair
      if (response.stop_reason === 'max_tokens') {
        jsonStr = this._repairTruncatedJson(jsonStr);
      }

      var decisions;
      try {
        decisions = JSON.parse(jsonStr);
      } catch (parseErr) {
        console.log('[Claude] JSON parse failed, attempting repair...');
        var repaired = this._repairTruncatedJson(jsonStr);
        decisions = JSON.parse(repaired);
      }

      // Validate structure
      if (!decisions.segments || !Array.isArray(decisions.segments)) {
        return {
          success: false,
          error: 'AI response missing segments array'
        };
      }

      // Normalize segments
      decisions.segments = decisions.segments.map(function (seg) {
        return {
          start: parseFloat(seg.start) || 0,
          end: parseFloat(seg.end) || 0,
          action: (seg.action || 'keep').toLowerCase(),
          reason: seg.reason || ''
        };
      });

      // Filter invalid
      decisions.segments = decisions.segments.filter(function (seg) {
        return seg.end > seg.start;
      });

      // Calculate stats
      var keepDuration = 0, removeDuration = 0, keepCount = 0, removeCount = 0;
      decisions.segments.forEach(function (seg) {
        var dur = seg.end - seg.start;
        if (seg.action === 'keep') { keepDuration += dur; keepCount++; }
        else { removeDuration += dur; removeCount++; }
      });

      decisions.estimated_duration = keepDuration;
      decisions.removed_duration = removeDuration;
      decisions.kept_segments_count = keepCount;
      decisions.removed_segments_count = removeCount;
      decisions.story_summary = decisions.story_summary || 'Edit complete';

      console.log('[Claude] ✓ Parsed', decisions.segments.length, 'segments. Keep:', keepCount, 'Remove:', removeCount);

      return { success: true, decisions: decisions };

    } catch (e) {
      console.log('[Claude] Parse error:', e.message);
      console.log('[Claude] Parse stack:', e.stack);
      var rawText = '';
      try {
        for (var j = 0; j < response.content.length; j++) {
          if (response.content[j].type === 'text') {
            rawText = response.content[j].text;
            break;
          }
        }
      } catch (x) {}
      console.log('[Claude] Raw text that failed:', rawText.substring(0, 500));
      return {
        success: false,
        error: 'Failed to parse AI edit decisions: ' + e.message,
        rawContent: rawText
      };
    }
  };

  /**
   * Attempt to repair truncated JSON.
   */
  AIEditor.prototype._repairTruncatedJson = function (jsonStr) {
    console.log('[Claude] Attempting JSON repair...');

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

    var repaired = truncated + suffix;
    console.log('[Claude] Repaired JSON (added', suffix.length, 'closing chars)');
    return repaired;
  };

  /**
   * Format seconds into MM:SS display.
   */
  AIEditor.prototype._formatTime = function (seconds) {
    var mins = Math.floor(seconds / 60);
    var secs = Math.floor(seconds % 60);
    return (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
  };

  return AIEditor;
})();

if (typeof window !== 'undefined') {
  window.AIEditor = AIEditor;
}
