/**
 * Editly AI Editor — Main Application Controller
 * Orchestrates: UI ↔ ExtendScript ↔ ffmpeg ↔ ElevenLabs STT ↔ Claude AI
 */

(function () {
  'use strict';

  // ==================== INITIALIZATION ====================
  var csInterface = new CSInterface();
  var fs = require('fs');
  var path = require('path');
  var childProcess = require('child_process');

  // State
  var stateManager = new TimelineStateManager();
  var transcriber = null;
  var aiEditor = null;
  var currentClipData = null;
  var isProcessing = false;

  // Settings
  var settings = {
    elevenlabs_api_key: '',
    anthropic_api_key: '',
    ai_model: 'claude-opus-4-7',
    gemini_api_key: '',
    kling_access_key: '',
    kling_secret_key: '',
    seedance_api_key: ''
  };

  // VFX state
  var vfxClipData = null;
  var vfxPreviewData = null;
  var vfxIsProcessing = false;
  var vfxUploadedImages = []; // Array of {path, dataUri} for Seedance reference images

  // ==================== DOM REFERENCES ====================
  var els = {
    // Pages
    pageSetup: document.getElementById('pageSetup'),
    pageProcess: document.getElementById('pageProcess'),
    btnBack: document.getElementById('btnBack'),
    // Setup page
    btnRefresh: document.getElementById('btnRefresh'),
    clipInfoContent: document.getElementById('clipInfoContent'),
    promptInput: document.getElementById('promptInput'),
    durationSlider: document.getElementById('durationSlider'),
    durationDisplay: document.getElementById('durationDisplay'),
    btnCreateCut: document.getElementById('btnCreateCut'),
    // Process page
    progressSection: document.getElementById('progressSection'),
    progressSpinner: document.getElementById('progressSpinner'),
    // Transcript review
    transcriptSection: document.getElementById('transcriptSection'),
    transcriptBadge: document.getElementById('transcriptBadge'),
    transcriptSearch: document.getElementById('transcriptSearch'),
    transcriptList: document.getElementById('transcriptList'),
    storySummaryText: document.getElementById('storySummaryText'),
    statKept: document.getElementById('statKept'),
    statRemoved: document.getElementById('statRemoved'),
    statDuration: document.getElementById('statDuration'),
    statSaved: document.getElementById('statSaved'),
    btnApplyCuts: document.getElementById('btnApplyCuts'),
    btnUndo: document.getElementById('btnUndo'),
    // Delete final
    deleteSection: document.getElementById('deleteSection'),
    btnDeleteCuts: document.getElementById('btnDeleteCuts'),
    // Tabs
    tabBtnEditor: document.getElementById('tabBtnEditor'),
    tabBtnVFX: document.getElementById('tabBtnVFX'),
    tabEditor: document.getElementById('tabEditor'),
    tabVFX: document.getElementById('tabVFX'),
    // VFX Setup
    vfxBtnRefresh: document.getElementById('vfxBtnRefresh'),
    vfxClipInfo: document.getElementById('vfxClipInfo'),
    vfxPromptInput: document.getElementById('vfxPromptInput'),
    templateGrid: document.getElementById('templateGrid'),
    vfxBtnGenerate: document.getElementById('vfxBtnGenerate'),
    vfxBtnViewQueue: document.getElementById('vfxBtnViewQueue'),
    vfxModelSelect: document.getElementById('vfxModelSelect'),
    vfxImageUpload: document.getElementById('vfxImageUpload'),
    vfxDropzone: document.getElementById('vfxDropzone'),
    vfxFileInput: document.getElementById('vfxFileInput'),
    vfxUploadThumbs: document.getElementById('vfxUploadThumbs'),
    settingsSeedanceKey: document.getElementById('settingsSeedanceKey'),
    // VFX Preview
    vfxPageSetup: document.getElementById('vfxPageSetup'),
    vfxPagePreview: document.getElementById('vfxPagePreview'),
    vfxPageQueue: document.getElementById('vfxPageQueue'),
    vfxBtnBackToSetup: document.getElementById('vfxBtnBackToSetup'),
    vfxProgressArea: document.getElementById('vfxProgressArea'),
    vfxProgressText: document.getElementById('vfxProgressText'),
    vfxPreviewContainer: document.getElementById('vfxPreviewContainer'),
    vfxPreviewImg: document.getElementById('vfxPreviewImg'),
    vfxPreviewActions: document.getElementById('vfxPreviewActions'),
    vfxPreviewStatus: document.getElementById('vfxPreviewStatus'),
    vfxBtnApprove: document.getElementById('vfxBtnApprove'),
    vfxBtnRegenerate: document.getElementById('vfxBtnRegenerate'),
    // VFX Queue
    vfxBtnBackFromQueue: document.getElementById('vfxBtnBackFromQueue'),
    vfxQueueList: document.getElementById('vfxQueueList'),
    vfxQueueBadge: document.getElementById('vfxQueueBadge'),
    // Settings
    settingsKlingAK: document.getElementById('settingsKlingAK'),
    settingsKlingSK: document.getElementById('settingsKlingSK'),
    btnSettings: document.getElementById('btnSettings'),
    settingsOverlay: document.getElementById('settingsOverlay'),
    btnSettingsClose: document.getElementById('btnSettingsClose'),
    settingsApiKey: document.getElementById('settingsApiKey'),
    settingsSttModel: document.getElementById('settingsSttModel'),
    settingsAiModel: document.getElementById('settingsAiModel'),
    settingsGeminiKey: document.getElementById('settingsGeminiKey'),
    btnSaveSettings: document.getElementById('btnSaveSettings'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    toastContainer: document.getElementById('toastContainer')
  };

  // Current decisions state (user-editable)
  var currentDecisions = null;
  var currentSearchQuery = '';

  // ==================== PAGE NAVIGATION ====================

  function showPage(page) {
    els.pageSetup.classList.remove('active');
    els.pageProcess.classList.remove('active');
    if (page === 'setup') {
      els.pageSetup.classList.add('active');
      els.pageSetup.style.display = '';
      els.pageProcess.style.display = 'none';
    } else {
      els.pageProcess.classList.add('active');
      els.pageProcess.style.display = '';
      els.pageSetup.style.display = 'none';
    }
  }

  // Start on setup page
  showPage('setup');

  // ==================== SETTINGS ====================

  function loadSettings() {
    try {
      var extPath = csInterface.getSystemPath(SystemPath.EXTENSION);
      var configPath = path.join(extPath, 'config', 'settings.json');
      var examplePath = path.join(extPath, 'config', 'settings.example.json');

      // First-run: copy example settings if settings.json doesn't exist
      if (!fs.existsSync(configPath) && fs.existsSync(examplePath)) {
        fs.writeFileSync(configPath, fs.readFileSync(examplePath, 'utf8'), 'utf8');
        console.log('[Settings] Created settings.json from template');
      }

      if (fs.existsSync(configPath)) {
        var data = fs.readFileSync(configPath, 'utf8');
        var loaded = JSON.parse(data);
        settings.elevenlabs_api_key = loaded.elevenlabs_api_key || '';
        settings.anthropic_api_key = loaded.anthropic_api_key || '';
        settings.ai_model = loaded.ai_model || 'claude-opus-4-7';
        settings.gemini_api_key = loaded.gemini_api_key || '';
        settings.kling_access_key = loaded.kling_access_key || '';
        settings.kling_secret_key = loaded.kling_secret_key || '';
        settings.seedance_api_key = loaded.seedance_api_key || '';
      }
    } catch (e) {
      console.warn('Could not load settings:', e.message);
    }

    // Update UI
    els.settingsApiKey.value = settings.elevenlabs_api_key;
    if (els.settingsSttModel) els.settingsSttModel.value = settings.anthropic_api_key;
    if (els.settingsAiModel) els.settingsAiModel.value = settings.ai_model;
    if (els.settingsGeminiKey) els.settingsGeminiKey.value = settings.gemini_api_key;
    if (els.settingsKlingAK) els.settingsKlingAK.value = settings.kling_access_key;
    if (els.settingsKlingSK) els.settingsKlingSK.value = settings.kling_secret_key;
    if (els.settingsSeedanceKey) els.settingsSeedanceKey.value = settings.seedance_api_key;

    updateConnectionStatus();
    initApiClients();
  }

  function saveSettings() {
    settings.elevenlabs_api_key = els.settingsApiKey.value.trim();
    if (els.settingsSttModel) settings.anthropic_api_key = els.settingsSttModel.value.trim();
    if (els.settingsAiModel) settings.ai_model = els.settingsAiModel.value;
    if (els.settingsGeminiKey) settings.gemini_api_key = els.settingsGeminiKey.value.trim();
    if (els.settingsKlingAK) settings.kling_access_key = els.settingsKlingAK.value.trim();
    if (els.settingsKlingSK) settings.kling_secret_key = els.settingsKlingSK.value.trim();
    if (els.settingsSeedanceKey) settings.seedance_api_key = els.settingsSeedanceKey.value.trim();

    try {
      var extPath = csInterface.getSystemPath(SystemPath.EXTENSION);
      var configPath = path.join(extPath, 'config', 'settings.json');
      fs.writeFileSync(configPath, JSON.stringify(settings, null, 2), 'utf8');
      showToast('Settings saved', 'success');
    } catch (e) {
      showToast('Failed to save settings: ' + e.message, 'error');
    }

    updateConnectionStatus();
    initApiClients();
    closeSettings();
  }

  function initApiClients() {
    if (settings.elevenlabs_api_key) {
      transcriber = new TranscriptionPipeline(settings.elevenlabs_api_key);
    }
    if (settings.anthropic_api_key) {
      aiEditor = new AIEditor(settings.anthropic_api_key);
      aiEditor.setModel(settings.ai_model);
    }
  }

  function updateConnectionStatus() {
    if (settings.elevenlabs_api_key && settings.anthropic_api_key) {
      els.statusDot.className = 'status-dot connected';
      els.statusText.textContent = 'APIs Connected';
    } else {
      els.statusDot.className = 'status-dot disconnected';
      els.statusText.textContent = 'Missing API Keys';
    }
  }

  // ==================== EXTENDSCRIPT BRIDGE ====================

  function evalScript(script) {
    return new Promise(function (resolve, reject) {
      csInterface.evalScript(script, function (result) {
        if (result === 'EvalScript error.' || result === 'undefined') {
          reject(new Error('ExtendScript error: ' + result));
        } else {
          try {
            resolve(JSON.parse(result));
          } catch (e) {
            resolve(result);
          }
        }
      });
    });
  }

  // ==================== FFMPEG AUDIO EXTRACTION ====================

  function extractAudioWithFFmpeg(mediaClips, outputPath) {
    return new Promise(function (resolve, reject) {
      if (!mediaClips || mediaClips.length === 0) {
        reject(new Error('No media clips to extract audio from'));
        return;
      }

      mediaClips.sort(function (a, b) { return a.timelineStart - b.timelineStart; });

      if (mediaClips.length === 1) {
        var clip = mediaClips[0];
        var cmd = '/usr/local/bin/ffmpeg -y' +
          ' -i "' + clip.mediaPath + '"' +
          ' -ss ' + clip.sourceInPoint +
          ' -t ' + clip.duration +
          ' -vn -acodec pcm_s16le -ar 16000 -ac 1' +
          ' "' + outputPath + '"';

        console.log('[FFmpeg] Command:', cmd);

        childProcess.exec(cmd, { timeout: 120000 }, function (error, stdout, stderr) {
          if (error) {
            console.log('[FFmpeg] Error:', stderr);
            reject(new Error('FFmpeg failed: ' + (stderr || error.message).substring(0, 200)));
            return;
          }
          console.log('[FFmpeg] Success, output:', outputPath);
          resolve({ path: outputPath, clips: 1 });
        });
        return;
      }

      // Multiple clips: extract each, then concatenate
      var tmpDir = path.dirname(outputPath);
      var tempFiles = [];
      var completed = 0;
      var hasError = false;

      mediaClips.forEach(function (clip, index) {
        var tmpFile = path.join(tmpDir, 'clip_' + index + '_' + Date.now() + '.wav');
        tempFiles.push(tmpFile);

        var cmd = '/usr/local/bin/ffmpeg -y' +
          ' -i "' + clip.mediaPath + '"' +
          ' -ss ' + clip.sourceInPoint +
          ' -t ' + clip.duration +
          ' -vn -acodec pcm_s16le -ar 16000 -ac 1' +
          ' "' + tmpFile + '"';

        childProcess.exec(cmd, { timeout: 120000 }, function (error, stdout, stderr) {
          if (hasError) return;

          if (error) {
            hasError = true;
            reject(new Error('FFmpeg clip ' + index + ' failed: ' + (stderr || error.message).substring(0, 200)));
            return;
          }

          completed++;
          if (completed === mediaClips.length) {
            // All clips extracted, concatenate
            var concatListPath = path.join(tmpDir, 'concat_list_' + Date.now() + '.txt');
            var concatContent = tempFiles.map(function (tf) { return "file '" + tf + "'"; }).join('\n');
            fs.writeFileSync(concatListPath, concatContent);

            var concatCmd = '/usr/local/bin/ffmpeg -y -f concat -safe 0' +
              ' -i "' + concatListPath + '"' +
              ' -acodec pcm_s16le -ar 16000 -ac 1' +
              ' "' + outputPath + '"';

            childProcess.exec(concatCmd, { timeout: 120000 }, function (cerr) {
              tempFiles.forEach(function (tf) { try { fs.unlinkSync(tf); } catch (e) {} });
              try { fs.unlinkSync(concatListPath); } catch (e) {}

              if (cerr) {
                reject(new Error('FFmpeg concat failed: ' + cerr.message));
                return;
              }
              resolve({ path: outputPath, clips: mediaClips.length });
            });
          }
        });
      });
    });
  }

  // ==================== CLIP INFO ====================

  function refreshClipInfo() {
    evalScript('getSelectedClips()')
      .then(function (result) {
        if (result.error) {
          els.clipInfoContent.innerHTML =
            '<div class="empty-state">' +
              '<div class="empty-state-icon">⚠️</div>' +
              '<div class="empty-state-text">' + result.error + '</div>' +
            '</div>';
          els.btnCreateCut.disabled = true;
          currentClipData = null;
          return;
        }

        currentClipData = result;
        var clips = result.clips;
        var totalDuration = 0;
        clips.forEach(function (c) { totalDuration += c.duration; });

        return evalScript('getTimelineRange()').then(function (range) {
          if (range && !range.error) {
            currentClipData.timelineStart = range.startTime;
            currentClipData.timelineEnd = range.endTime;
            currentClipData.duration = range.duration;
          }

          els.clipInfoContent.innerHTML =
            '<div class="clip-info-grid">' +
              '<div class="clip-info-item">' +
                '<div class="clip-info-label">Clips</div>' +
                '<div class="clip-info-value accent">' + clips.length + '</div>' +
              '</div>' +
              '<div class="clip-info-item">' +
                '<div class="clip-info-label">Total Duration</div>' +
                '<div class="clip-info-value">' + formatTime(totalDuration) + '</div>' +
              '</div>' +
              '<div class="clip-info-item">' +
                '<div class="clip-info-label">Timeline Start</div>' +
                '<div class="clip-info-value">' + formatTime(range ? range.startTime : 0) + '</div>' +
              '</div>' +
              '<div class="clip-info-item">' +
                '<div class="clip-info-label">Timeline End</div>' +
                '<div class="clip-info-value">' + formatTime(range ? range.endTime : 0) + '</div>' +
              '</div>' +
            '</div>';

          els.btnCreateCut.disabled = false;
        });
      })
      .catch(function (err) {
        els.clipInfoContent.innerHTML =
          '<div class="empty-state">' +
            '<div class="empty-state-icon">❌</div>' +
            '<div class="empty-state-text">' + err.message + '</div>' +
          '</div>';
        els.btnCreateCut.disabled = true;
      });
  }

  // ==================== PROGRESS TRACKING ====================

  function setStepState(stepNum, state, detail) {
    var stepEl = document.getElementById('step' + stepNum);
    var detailEl = document.getElementById('step' + stepNum + 'Detail');

    stepEl.className = 'progress-step ' + state;

    var indicator = stepEl.querySelector('.step-indicator');
    if (state === 'completed') indicator.textContent = '✓';
    else if (state === 'error') indicator.textContent = '✕';
    else indicator.textContent = stepNum;

    if (detail) detailEl.textContent = detail;
  }

  function resetProgress() {
    for (var i = 1; i <= 4; i++) {
      setStepState(i, 'pending', 'Waiting...');
    }
    els.progressSection.classList.remove('active');
    els.transcriptSection.classList.remove('active');
    els.deleteSection.classList.remove('active');
    els.btnApplyCuts.style.display = '';
    showPage('setup');
  }

  // ==================== MAIN PIPELINE ====================

  function createCut() {
    if (isProcessing) return;
    if (!settings.elevenlabs_api_key || !settings.anthropic_api_key) {
      showToast('Please set API keys in Settings', 'error');
      return;
    }
    if (!currentClipData || !currentClipData.clips || currentClipData.clips.length === 0) {
      showToast('No clips selected. Click Refresh first.', 'error');
      return;
    }

    var prompt = els.promptInput.value.trim();
    if (!prompt) {
      showToast('Please enter a story prompt', 'error');
      return;
    }

    var targetDuration = parseInt(els.durationSlider.value);

    isProcessing = true;
    els.btnCreateCut.disabled = true;
    resetProgress();
    showPage('process');
    els.progressSection.classList.add('active');

    var tempAudioPath = '';
    var timelineRange = currentClipData;

    // ---- STEP 1: Save state & Export Audio via ffmpeg ----
    setStepState(1, 'active', 'Saving timeline state...');

    evalScript('saveTimelineState()')
      .then(function (stateResult) {
        if (stateResult.error) throw new Error(stateResult.error);
        stateManager.saveState(stateResult.state);
        setStepState(1, 'active', 'Getting clip media paths...');
        return evalScript('getClipMediaInfo()');
      })
      .then(function (mediaInfo) {
        if (mediaInfo.error) throw new Error(mediaInfo.error);
        if (!mediaInfo.clips || mediaInfo.clips.length === 0) {
          throw new Error('No media paths found for selected clips');
        }

        setStepState(1, 'active', 'Getting temp directory...');
        return evalScript('getTempDirectory()').then(function (tmpResult) {
          if (tmpResult.error) throw new Error(tmpResult.error);
          return { mediaInfo: mediaInfo, tmpDir: tmpResult.path };
        });
      })
      .then(function (data) {
        var tmpDir = data.tmpDir;
        tempAudioPath = path.join(tmpDir, 'editly_audio_' + Date.now() + '.wav');

        setStepState(1, 'active', 'Extracting audio (' + data.mediaInfo.clips.length + ' clips)...');
        return extractAudioWithFFmpeg(data.mediaInfo.clips, tempAudioPath);
      })
      .then(function () {
        var fileSize = 0;
        try { fileSize = fs.statSync(tempAudioPath).size; } catch (e) {}
        if (fileSize === 0) throw new Error('Audio extraction produced empty file');

        setStepState(1, 'completed', 'Audio extracted (' + AudioUtils.formatBytes(fileSize) + ')');

        // ---- STEP 2: Transcribe with ElevenLabs ----
        var timelineOffset = timelineRange.timelineStart || 0;
        setStepState(2, 'active', 'Transcribing with ElevenLabs...');
        return transcriber.transcribe(tempAudioPath, null, timelineOffset);
      })
      .then(function (transcriptResult) {
        if (!transcriptResult.success) throw new Error(transcriptResult.error || 'Transcription failed');

        console.log('[Pipeline] Transcript: ' + transcriptResult.totalSegments + ' segments');

        if (transcriptResult.totalSegments === 0) {
          throw new Error('No speech detected. Make sure your clips have audio.');
        }

        var segments = transcriptResult.segments;

        // Count types for display
        var speechCount = segments.filter(function (s) { return s.type === 'speech'; }).length;
        var fillerCount = segments.filter(function (s) { return s.type === 'filler'; }).length;
        var silenceCount = segments.filter(function (s) { return s.type === 'silence'; }).length;

        setStepState(2, 'completed',
          speechCount + ' speech, ' + fillerCount + ' fillers, ' + silenceCount + ' silences');

        // ---- STEP 3: Claude edits the story (chunked) ----
        setStepState(3, 'active', 'Pre-filtering junk...');

        var chunkProgress = function (chunkIdx, totalChunks) {
          if (totalChunks > 1) {
            setStepState(3, 'active', 'Claude: chunk ' + (chunkIdx + 1) + '/' + totalChunks + '...');
          } else {
            setStepState(3, 'active', 'Claude is editing the story...');
          }
        };

        return aiEditor.generateEditDecisions(
          segments,
          prompt,
          targetDuration,
          currentClipData,
          chunkProgress
        );
      })
      .then(function (editResult) {
        if (!editResult.success) throw new Error(editResult.error || 'AI editor failed');

        var decisions = editResult.decisions;
        setStepState(3, 'completed',
          decisions.kept_segments_count + ' kept, ' +
          decisions.removed_segments_count + ' removed'
        );

        // ---- Show transcript for user review (Step 4 waits for user) ----
        currentDecisions = decisions;
        showTranscriptReview(decisions);
        showToast('Review the transcript. Toggle segments, then click Apply.', 'success');
      })
      .catch(function (err) {
        console.error('[Pipeline] Error:', err);
        for (var s = 1; s <= 4; s++) {
          var stepEl = document.getElementById('step' + s);
          if (stepEl.classList.contains('active')) {
            setStepState(s, 'error', err.message);
            break;
          }
        }
        showToast('Error: ' + err.message, 'error');
        AudioUtils.cleanupTempFiles([tempAudioPath]);
      })
      .then(function () {
        isProcessing = false;
        els.btnCreateCut.disabled = false;
        els.progressSpinner.style.display = 'none';
      });
  }

  // ==================== TRANSCRIPT REVIEW ====================

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showTranscriptReview(decisions) {
    els.storySummaryText.textContent = decisions.story_summary || 'Edit complete.';
    renderTranscript();
    els.transcriptSection.classList.add('active');
  }

  function renderTranscript() {
    if (!currentDecisions || !currentDecisions.segments) return;

    var segments = currentDecisions.segments;
    var query = currentSearchQuery.toLowerCase();
    var html = '';
    var keepCount = 0, removeCount = 0, keepDuration = 0, removeDuration = 0;

    segments.forEach(function (seg, idx) {
      var dur = seg.end - seg.start;
      var isKeep = seg.action === 'keep';
      if (isKeep) { keepCount++; keepDuration += dur; } else { removeCount++; removeDuration += dur; }

      // Search filter
      var segText = (seg.reason || '') + ' ' + (seg._text || '');
      var matchesSearch = !query || segText.toLowerCase().indexOf(query) >= 0;

      // Display text
      var displayText = seg._text || seg.reason || '';
      var highlightedText = escapeHtml(displayText);
      if (query && displayText.toLowerCase().indexOf(query) >= 0) {
        var regex = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
        highlightedText = escapeHtml(displayText).replace(regex, '<mark>$1</mark>');
      }

      var cls = isKeep ? 'kept' : 'removed';
      if (!matchesSearch) cls += ' hidden';

      var btnClass = isKeep ? 'btn-remove' : 'btn-keep';
      var btnLabel = isKeep ? 'Cut' : 'Keep';

      html += '<div class="transcript-segment ' + cls + '" data-idx="' + idx + '">' +
        '<div class="seg-body">' +
          '<div class="seg-header">' +
            '<span class="seg-time">' + seg.start.toFixed(1) + 's – ' + seg.end.toFixed(1) + 's</span>' +
            '<span class="seg-type ' + seg.action + '">' + seg.action + '</span>' +
            (seg.reason ? '<span class="seg-reason">' + escapeHtml(seg.reason) + '</span>' : '') +
          '</div>' +
          (displayText ? '<div class="seg-text">' + highlightedText + '</div>' : '') +
        '</div>' +
        '<div class="seg-action">' +
          '<button class="btn-seg-toggle ' + btnClass + '" data-idx="' + idx + '">' + btnLabel + '</button>' +
        '</div>' +
      '</div>';
    });

    els.transcriptList.innerHTML = html;

    // Update stats
    els.statKept.textContent = keepCount;
    els.statRemoved.textContent = removeCount;
    els.statDuration.textContent = Math.round(keepDuration) + 's';
    els.statSaved.textContent = Math.round(removeDuration) + 's';
    els.transcriptBadge.textContent = removeCount + ' to cut';
    els.transcriptBadge.className = 'card-badge ' + (removeCount > 0 ? 'error' : 'ready');

    // Bind toggle buttons
    els.transcriptList.querySelectorAll('.btn-seg-toggle').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute('data-idx'));
        var seg = currentDecisions.segments[idx];
        seg.action = seg.action === 'keep' ? 'remove' : 'keep';
        renderTranscript();
      });
    });
  }

  // ==================== APPLY CUTS (from user's review) ====================

  function applyCuts() {
    if (!currentDecisions || isProcessing) return;
    isProcessing = true;
    els.btnApplyCuts.disabled = true;

    els.progressSection.classList.add('active');
    setStepState(4, 'active', 'Applying razor cuts...');

    var cutTimes = [];
    var removeRanges = [];

    currentDecisions.segments.forEach(function (seg) {
      cutTimes.push(seg.start);
      cutTimes.push(seg.end);
      if (seg.action === 'remove') {
        removeRanges.push({ start: seg.start, end: seg.end });
      }
    });

    var uniqueCuts = [];
    var seen = {};
    cutTimes.forEach(function (t) {
      var rounded = Math.round(t * 100) / 100;
      if (!seen[rounded]) { seen[rounded] = true; uniqueCuts.push(rounded); }
    });

    console.log('[Apply] ' + uniqueCuts.length + ' cut points, ' + removeRanges.length + ' remove ranges');

    var cutsJson = JSON.stringify(uniqueCuts);
    evalScript('applyMultipleRazorCuts(\'' + cutsJson.replace(/'/g, "\\'") + '\')')
      .then(function (cutResult) {
        setStepState(4, 'active', 'Waiting for cuts (' + (cutResult.successCount || 0) + ')...');
        return new Promise(function (resolve) {
          setTimeout(function () {
            setStepState(4, 'active', 'Disabling removed segments...');
            var rangesJson = JSON.stringify(removeRanges);
            evalScript('disableClipRanges(\'' + rangesJson.replace(/'/g, "\\'") + '\')')
              .then(resolve);
          }, 2000);
        });
      })
      .then(function (disableResult) {
        var count = disableResult ? (disableResult.disabledCount || 0) : 0;
        setStepState(4, 'completed', 'Done! ' + count + ' clips disabled');
        showToast('Cuts applied! Preview the result, then delete if happy.', 'success');
        // Show delete button, hide apply button
        els.btnApplyCuts.style.display = 'none';
        els.deleteSection.classList.add('active');
      })
      .catch(function (err) {
        setStepState(4, 'error', err.message);
        showToast('Error: ' + err.message, 'error');
      })
      .then(function () {
        isProcessing = false;
        els.btnApplyCuts.disabled = false;
      });
  }

  // ==================== UNDO ====================

  function undoEdit() {
    evalScript('undoDisableAll()')
      .then(function (result) {
        if (result.error) { showToast('Undo error: ' + result.error, 'error'); return; }
        stateManager.clearState();
        resetProgress();
        showToast('Edit undone. ' + (result.enabledCount || 0) + ' clips re-enabled.', 'info');
        refreshClipInfo();
      })
      .catch(function (err) { showToast('Undo failed: ' + err.message, 'error'); });
  }

  // ==================== DELETE CUTS ====================

  function deleteCuts() {
    if (isProcessing) return;
    isProcessing = true;
    els.btnDeleteCuts.disabled = true;
    els.btnDeleteCuts.textContent = '⏳ Deleting...';

    evalScript('approveChanges()')
      .then(function (result) {
        if (result.error) {
          showToast('Delete error: ' + result.error, 'error');
          return;
        }
        stateManager.clearState();
        els.deleteSection.classList.remove('active');
        els.transcriptSection.classList.remove('active');
        showToast('Done! ' + (result.removedCount || 0) + ' clips deleted. Timeline is clean.', 'success');
        refreshClipInfo();
      })
      .catch(function (err) { showToast('Delete failed: ' + err.message, 'error'); })
      .then(function () {
        isProcessing = false;
        els.btnDeleteCuts.disabled = false;
        els.btnDeleteCuts.textContent = '🗑 Delete Removed Clips';
      });
  }

  // ==================== UI HELPERS ====================

  function formatTime(seconds) {
    var mins = Math.floor(seconds / 60);
    var secs = Math.floor(seconds % 60);
    return (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
  }

  function updateDurationDisplay() {
    els.durationDisplay.textContent = formatTime(parseInt(els.durationSlider.value));
  }

  function openSettings() { els.settingsOverlay.classList.add('active'); }
  function closeSettings() { els.settingsOverlay.classList.remove('active'); }

  function showToast(message, type) {
    type = type || 'info';
    var icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
    var toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.innerHTML = '<span>' + icon + '</span><span>' + message + '</span>';
    els.toastContainer.appendChild(toast);
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 4000);
  }

  // ==================== TAB SWITCHING ====================

  function switchTab(tabName) {
    els.tabBtnEditor.classList.toggle('active', tabName === 'editor');
    els.tabBtnVFX.classList.toggle('active', tabName === 'vfx');
    els.tabEditor.classList.toggle('active', tabName === 'editor');
    els.tabVFX.classList.toggle('active', tabName === 'vfx');
  }

  // ==================== VFX STUDIO ====================

  function showVFXPage(pageName) {
    els.vfxPageSetup.classList.toggle('active', pageName === 'setup');
    els.vfxPagePreview.classList.toggle('active', pageName === 'preview');
    els.vfxPageQueue.classList.toggle('active', pageName === 'queue');
  }

  function vfxRefreshClip() {
    evalScript('getSelectedClipMediaPath()')
      .then(function (result) {
        if (result.error) {
          els.vfxClipInfo.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠</div>' +
            '<div class="empty-state-text">' + escapeHtml(result.error) + '</div></div>';
          els.vfxBtnGenerate.disabled = true;
          vfxClipData = null;
          return;
        }

        vfxClipData = result;
        var dur = result.duration || 0;
        var durStr = Math.floor(dur / 60) + ':' + ('0' + Math.floor(dur % 60)).slice(-2);
        var splits = KlingVideo.calculateSplits(dur, 30);
        var badgeClass = splits.length > 1 ? 'warn' : 'ok';
        var badgeText = splits.length > 1 ? splits.length + ' tasks' : 'Ready';

        els.vfxClipInfo.innerHTML =
          '<div class="vfx-clip-info">' +
            '<div>' +
              '<div class="vfx-clip-name">' + escapeHtml(result.clipName) + '</div>' +
              '<div class="vfx-clip-meta">' + durStr + ' duration</div>' +
            '</div>' +
            '<span class="vfx-clip-badge ' + badgeClass + '">' + badgeText + '</span>' +
          '</div>';

        if (splits.length > 1) {
          els.vfxClipInfo.innerHTML += '<div class="vfx-clip-meta" style="font-size:10px;color:var(--warning);padding:4px 0">' +
            '⚠ Clip is longer than 30s. It will be split into ' + splits.length + ' separate tasks.</div>';
        }

        updateVFXGenerateButton();
      })
      .catch(function (err) {
        els.vfxClipInfo.innerHTML = '<div class="empty-state"><div class="empty-state-icon">✕</div>' +
          '<div class="empty-state-text">' + escapeHtml(err.message) + '</div></div>';
        els.vfxBtnGenerate.disabled = true;
      });
  }

  function updateVFXGenerateButton() {
    var hasClip = !!vfxClipData;
    var hasPrompt = els.vfxPromptInput.value.trim().length > 0;
    var hasGeminiKey = !!settings.gemini_api_key;
    els.vfxBtnGenerate.disabled = !(hasClip && hasPrompt && hasGeminiKey);
  }

  function vfxGeneratePreview() {
    if (vfxIsProcessing || !vfxClipData) return;
    vfxIsProcessing = true;

    var prompt = els.vfxPromptInput.value.trim();
    if (!prompt) { showToast('Enter an effect prompt', 'error'); vfxIsProcessing = false; return; }
    if (!settings.gemini_api_key) { showToast('Configure Gemini API key in Settings', 'error'); vfxIsProcessing = false; return; }

    // Show preview page with loading
    showVFXPage('preview');
    els.vfxProgressArea.style.display = 'flex';
    els.vfxPreviewContainer.style.display = 'none';
    els.vfxPreviewActions.style.display = 'none';
    els.vfxPreviewStatus.textContent = 'Generating...';
    els.vfxPreviewStatus.className = 'card-badge';

    // Prepend aspect ratio instruction to prompt
    var fw = vfxClipData.frameWidth || 1920;
    var fh = vfxClipData.frameHeight || 1080;
    var aspectPrompt = 'IMPORTANT: The output image MUST be exactly ' + fw + 'x' + fh + ' pixels (' + fw + ':' + fh + ' aspect ratio). ' + prompt;

    // Get project folder for saving preview images next to the project
    evalScript('getProjectFolder()')
    .then(function (projResult) {
      var outputDir = null;
      if (projResult && projResult.success && projResult.folder) {
        outputDir = projResult.folder + '/Editly_VFX';
      }
      return outputDir;
    })
    .then(function (outputDir) {
      return VFXController.generatePreview({
        clip: vfxClipData,
        mediaPath: vfxClipData.mediaPath,
        prompt: aspectPrompt,
        geminiApiKey: settings.gemini_api_key,
        imageModel: 'gemini-3-pro-image-preview',
        outputDir: outputDir,
        onProgress: function (p) {
          els.vfxProgressText.textContent = p.detail || 'Processing...';
        }
      });
    })
    .then(function (result) {
      if (!result.success) throw new Error(result.error);

      vfxPreviewData = result;
      els.vfxProgressArea.style.display = 'none';
      els.vfxPreviewContainer.style.display = 'block';
      els.vfxPreviewImg.src = 'data:image/png;base64,' + result.imageBase64;
      els.vfxPreviewActions.style.display = 'flex';
      els.vfxPreviewStatus.textContent = 'Preview Ready';
      els.vfxPreviewStatus.className = 'card-badge ready';
    })
    .catch(function (err) {
      els.vfxProgressArea.style.display = 'none';
      els.vfxPreviewStatus.textContent = 'Error';
      els.vfxPreviewStatus.className = 'card-badge error';
      els.vfxPreviewContainer.innerHTML = '<div class="empty-state"><div class="empty-state-icon">✕</div>' +
        '<div class="empty-state-text">' + escapeHtml(err.message) + '</div></div>';
      els.vfxPreviewContainer.style.display = 'block';
      els.vfxPreviewActions.style.display = 'none';
      showToast('Preview failed: ' + err.message, 'error');
    })
    .then(function () { vfxIsProcessing = false; });
  }

  // ==================== VFX IMAGE UPLOAD ====================

  function handleVFXImageDrop(fileList) {
    if (!fileList || fileList.length === 0) return;
    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      if (!file.type.startsWith('image/')) continue;
      var filePath = file.path || file.name;
      var reader = new FileReader();
      (function (fp) {
        reader.onload = function (e) {
          vfxUploadedImages.push({ path: fp, dataUri: e.target.result });
          renderVFXUploadThumbs();
        };
      })(filePath);
      reader.readAsDataURL(file);
    }
  }

  function renderVFXUploadThumbs() {
    if (!els.vfxUploadThumbs) return;
    var html = '';
    for (var i = 0; i < vfxUploadedImages.length; i++) {
      html += '<div class="vfx-upload-thumb" data-idx="' + i + '">' +
        '<img src="' + vfxUploadedImages[i].dataUri + '" alt="ref ' + (i + 1) + '">' +
        '<button class="thumb-remove" data-remove="' + i + '">×</button>' +
      '</div>';
    }
    els.vfxUploadThumbs.innerHTML = html;
    els.vfxUploadThumbs.querySelectorAll('.thumb-remove').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var idx = parseInt(this.getAttribute('data-remove'), 10);
        vfxUploadedImages.splice(idx, 1);
        renderVFXUploadThumbs();
      });
    });
  }

  function vfxApproveAndGenerate() {
    if (!vfxPreviewData || !vfxClipData) return;

    var selectedModel = els.vfxModelSelect ? els.vfxModelSelect.value : 'kling-v3';
    var prompt = els.vfxPromptInput.value.trim();
    var dur = vfxClipData.duration || 0;

    // Validate API keys based on model
    if (selectedModel === 'kling-v3') {
      if (!settings.kling_access_key || !settings.kling_secret_key) {
        showToast('Configure Kling Access Key and Secret Key in Settings', 'error');
        return;
      }
    } else if (selectedModel === 'seedance-2') {
      if (!settings.seedance_api_key) {
        showToast('Configure Seedance API Key in Settings', 'error');
        return;
      }
    }

    // Calculate splits based on model's max chunk duration
    var maxChunk = selectedModel === 'seedance-2' ? 15 : 30;
    var splits = selectedModel === 'seedance-2'
      ? SeedanceVideo.calculateSplits(dur, maxChunk)
      : KlingVideo.calculateSplits(dur, maxChunk);

    // Calculate ratio from sequence dimensions
    var fw = vfxClipData.frameWidth || 1920;
    var fh = vfxClipData.frameHeight || 1080;
    var ratio = SeedanceVideo.mapRatio(fw, fh);

    // Collect extra image paths for Seedance
    var extraImagePaths = [];
    if (selectedModel === 'seedance-2' && vfxUploadedImages.length > 0) {
      for (var j = 0; j < vfxUploadedImages.length; j++) {
        if (vfxUploadedImages[j].path) extraImagePaths.push(vfxUploadedImages[j].path);
      }
    }

    // Create tasks for each chunk
    for (var i = 0; i < splits.length; i++) {
      VFXController.createTask({
        clipName: vfxClipData.clipName,
        chunkIndex: i,
        totalChunks: splits.length,
        // Timeline position (where to place the generated clip on the sequence)
        timelineStart: vfxClipData.startTime + splits[i].start,
        // Source media seek time (where to extract from in the source file)
        startTime: vfxClipData.inPoint + splits[i].start,
        endTime: vfxClipData.inPoint + splits[i].end,
        duration: splits[i].duration,
        prompt: prompt,
        imageBase64: vfxPreviewData.imageBase64,
        mediaPath: vfxClipData.mediaPath,
        // Model-specific
        model: selectedModel,
        ratio: ratio,
        extraImagePaths: extraImagePaths,
        klingAccessKey: settings.kling_access_key,
        klingSecretKey: settings.kling_secret_key,
        seedanceApiKey: settings.seedance_api_key
      });
    }

    // Switch to queue page and start processing
    showVFXPage('queue');
    renderVFXQueue();
    // Show the "View Queue" button on setup page for navigation back
    els.vfxBtnViewQueue.style.display = 'block';
    showToast(splits.length + ' task(s) queued for video generation', 'success');

    VFXController.processQueue(function (task) {
      renderVFXQueue();
      if (task.status === 'done') {
        showToast(task.clipName + ' chunk ' + (task.chunkIndex + 1) + ' complete!', 'success');
      } else if (task.status === 'error') {
        showToast('Task error: ' + task.error, 'error');
      }
    }, evalScript);
  }

  function renderVFXQueue() {
    var queue = VFXController.getQueue();
    if (queue.length === 0) {
      els.vfxQueueList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div>' +
        '<div class="empty-state-text">No tasks yet</div></div>';
      els.vfxQueueBadge.textContent = '0 tasks';
      return;
    }

    var statusIcons = { queued: '⚪', extracting: '🟡', submitting: '🟡', processing: '🟡', downloading: '🟡', importing: '🟡', done: '🟢', error: '🔴' };
    var statusLabels = { queued: 'Queued', extracting: 'Extracting video...', submitting: 'Uploading to Kling...', processing: 'Generating video...', downloading: 'Downloading...', importing: 'Importing to timeline...', done: 'Complete', error: 'Error' };

    var html = '';
    var doneCount = 0;
    for (var i = 0; i < queue.length; i++) {
      var t = queue[i];
      if (t.status === 'done') doneCount++;
      var icon = statusIcons[t.status] || '⚪';
      var label = statusLabels[t.status] || t.status;
      if (t.status === 'error' && t.error) label = t.error;

      // Thumbnail from reference image
      var thumbHtml = '';
      if (t.thumbDataUri) {
        thumbHtml = '<img class="queue-thumb" src="' + t.thumbDataUri + '" alt="ref">';
      }

      // Action buttons
      var actionsHtml = '';
      if (t.status === 'queued') {
        actionsHtml += '<button class="queue-btn-cancel" data-cancel-id="' + t.id + '">Cancel</button>';
      }
      if (t.status === 'error') {
        actionsHtml += '<button class="queue-btn-retry" data-retry-id="' + t.id + '">Retry</button>';
      }
      if (t.status === 'done' || t.status === 'error') {
        actionsHtml += '<button class="queue-btn-folder" data-folder-id="' + t.id + '" title="Show in Finder">📂</button>';
      }

      html += '<div class="vfx-queue-item" data-task-id="' + t.id + '">' +
        thumbHtml +
        '<span class="queue-status-icon">' + icon + '</span>' +
        '<div class="queue-info">' +
          '<div class="queue-name">' + escapeHtml(t.clipName) +
            (t.totalChunks > 1 ? ' (' + (t.chunkIndex + 1) + '/' + t.totalChunks + ')' : '') + '</div>' +
          '<div class="queue-detail">' + escapeHtml(label) + '</div>' +
          (t.status !== 'done' && t.status !== 'error' && t.status !== 'queued' ?
            '<div class="queue-progress"><div class="queue-progress-bar" style="width:' + t.progress + '%"></div></div>' : '') +
        '</div>' +
        '<div class="queue-actions">' + actionsHtml + '</div>' +
      '</div>';
    }

    els.vfxQueueList.innerHTML = html;
    els.vfxQueueBadge.textContent = doneCount + '/' + queue.length + ' done';

    // Bind retry buttons
    els.vfxQueueList.querySelectorAll('.queue-btn-retry').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var taskId = this.getAttribute('data-retry-id');
        VFXController.retryTask(taskId);
        renderVFXQueue();
        VFXController.processQueue(function () { renderVFXQueue(); }, evalScript);
      });
    });

    // Bind show-in-folder buttons
    els.vfxQueueList.querySelectorAll('.queue-btn-folder').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var taskId = this.getAttribute('data-folder-id');
        VFXController.showInFolder(taskId);
      });
    });

    // Bind cancel buttons
    els.vfxQueueList.querySelectorAll('.queue-btn-cancel').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var taskId = this.getAttribute('data-cancel-id');
        VFXController.cancelTask(taskId);
        renderVFXQueue();
        showToast('Task cancelled', 'success');
      });
    });
  }

  // ==================== EVENT LISTENERS ====================

  // Tab switching
  els.tabBtnEditor.addEventListener('click', function () { switchTab('editor'); });
  els.tabBtnVFX.addEventListener('click', function () { switchTab('vfx'); });

  // AI Editor events
  els.btnRefresh.addEventListener('click', refreshClipInfo);
  els.durationSlider.addEventListener('input', updateDurationDisplay);
  els.btnCreateCut.addEventListener('click', createCut);
  els.btnApplyCuts.addEventListener('click', applyCuts);
  els.btnUndo.addEventListener('click', undoEdit);
  els.btnDeleteCuts.addEventListener('click', deleteCuts);
  els.btnBack.addEventListener('click', function () {
    if (!isProcessing) showPage('setup');
  });

  // VFX Studio events
  els.vfxBtnRefresh.addEventListener('click', vfxRefreshClip);
  els.vfxPromptInput.addEventListener('input', updateVFXGenerateButton);
  els.vfxBtnGenerate.addEventListener('click', vfxGeneratePreview);
  els.vfxBtnApprove.addEventListener('click', vfxApproveAndGenerate);
  els.vfxBtnRegenerate.addEventListener('click', function () {
    showVFXPage('setup');
  });
  els.vfxBtnBackToSetup.addEventListener('click', function () {
    if (!vfxIsProcessing) showVFXPage('setup');
  });
  els.vfxBtnBackFromQueue.addEventListener('click', function () {
    showVFXPage('setup');
  });
  els.vfxBtnViewQueue.addEventListener('click', function () {
    renderVFXQueue();
    showVFXPage('queue');
  });

  // Model selector: toggle Seedance image upload area
  if (els.vfxModelSelect) {
    els.vfxModelSelect.addEventListener('change', function () {
      var isSeedance = this.value === 'seedance-2';
      els.vfxImageUpload.style.display = isSeedance ? 'block' : 'none';
    });
  }

  // Image upload: dropzone click
  if (els.vfxDropzone) {
    els.vfxDropzone.addEventListener('click', function () {
      els.vfxFileInput.click();
    });
    els.vfxDropzone.addEventListener('dragover', function (e) {
      e.preventDefault(); e.stopPropagation();
      this.classList.add('dragover');
    });
    els.vfxDropzone.addEventListener('dragleave', function (e) {
      e.preventDefault(); e.stopPropagation();
      this.classList.remove('dragover');
    });
    els.vfxDropzone.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation();
      this.classList.remove('dragover');
      handleVFXImageDrop(e.dataTransfer.files);
    });
  }

  if (els.vfxFileInput) {
    els.vfxFileInput.addEventListener('change', function () {
      handleVFXImageDrop(this.files);
      this.value = ''; // Reset so same file can be re-selected
    });
  }

  // Template buttons
  els.templateGrid.querySelectorAll('.template-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var prompt = this.getAttribute('data-prompt');
      els.vfxPromptInput.value = prompt;
      // Highlight selected template
      els.templateGrid.querySelectorAll('.template-btn').forEach(function (b) { b.classList.remove('selected'); });
      this.classList.add('selected');
      updateVFXGenerateButton();
    });
  });

  // Settings
  els.btnSettings.addEventListener('click', openSettings);
  els.btnSettingsClose.addEventListener('click', closeSettings);
  els.btnSaveSettings.addEventListener('click', saveSettings);

  // Search input
  els.transcriptSearch.addEventListener('input', function () {
    currentSearchQuery = els.transcriptSearch.value.trim();
    renderTranscript();
  });

  els.settingsOverlay.addEventListener('click', function (e) {
    if (e.target === els.settingsOverlay) closeSettings();
  });

  // ==================== STARTUP ====================
  loadSettings();
  updateDurationDisplay();

  if (!settings.elevenlabs_api_key || !settings.anthropic_api_key) {
    showToast('Configure API keys in Settings to get started', 'info');
  }

  // Auto-update check (silent, non-blocking)
  try {
    var extPath = csInterface.getSystemPath(SystemPath.EXTENSION);
    var updater = new Updater(extPath);
    updater.checkAndUpdate(function (msg, type) {
      console.log('[Updater] ' + msg);
      if (type === 'success') showToast(msg, 'success');
    }).then(function (result) {
      if (result.updated) {
        showToast(result.message, 'success');
      }
    }).catch(function (e) {
      console.log('[Updater] Check failed (non-fatal):', e.message);
    });
  } catch (e) {
    console.log('[Updater] Init failed (non-fatal):', e.message);
  }

})();
