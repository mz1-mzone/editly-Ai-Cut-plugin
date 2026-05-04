/**
 * Editly AI Cut — Main Application Controller
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
    ai_model: 'claude-opus-4-7'
  };

  // ==================== DOM REFERENCES ====================
  var els = {
    btnRefresh: document.getElementById('btnRefresh'),
    clipInfoContent: document.getElementById('clipInfoContent'),
    promptInput: document.getElementById('promptInput'),
    durationSlider: document.getElementById('durationSlider'),
    durationDisplay: document.getElementById('durationDisplay'),
    btnCreateCut: document.getElementById('btnCreateCut'),
    progressSection: document.getElementById('progressSection'),
    progressSpinner: document.getElementById('progressSpinner'),
    resultsSection: document.getElementById('resultsSection'),
    storySummaryText: document.getElementById('storySummaryText'),
    resultKept: document.getElementById('resultKept'),
    resultRemoved: document.getElementById('resultRemoved'),
    resultDuration: document.getElementById('resultDuration'),
    resultSaved: document.getElementById('resultSaved'),
    btnApprove: document.getElementById('btnApprove'),
    btnUndo: document.getElementById('btnUndo'),
    btnSettings: document.getElementById('btnSettings'),
    settingsOverlay: document.getElementById('settingsOverlay'),
    btnSettingsClose: document.getElementById('btnSettingsClose'),
    settingsApiKey: document.getElementById('settingsApiKey'),
    settingsSttModel: document.getElementById('settingsSttModel'),
    settingsAiModel: document.getElementById('settingsAiModel'),
    btnSaveSettings: document.getElementById('btnSaveSettings'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    toastContainer: document.getElementById('toastContainer')
  };

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
      }
    } catch (e) {
      console.warn('Could not load settings:', e.message);
    }

    // Update UI
    els.settingsApiKey.value = settings.elevenlabs_api_key;
    if (els.settingsSttModel) els.settingsSttModel.value = settings.anthropic_api_key;
    if (els.settingsAiModel) els.settingsAiModel.value = settings.ai_model;

    updateConnectionStatus();
    initApiClients();
  }

  function saveSettings() {
    settings.elevenlabs_api_key = els.settingsApiKey.value.trim();
    if (els.settingsSttModel) settings.anthropic_api_key = els.settingsSttModel.value.trim();
    if (els.settingsAiModel) settings.ai_model = els.settingsAiModel.value;

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
    els.resultsSection.classList.remove('active');
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

        // ---- STEP 4: Apply Cuts ----
        setStepState(4, 'active', 'Applying razor cuts...');

        var cutTimes = [];
        var removeRanges = [];

        decisions.segments.forEach(function (seg) {
          cutTimes.push(seg.start);
          cutTimes.push(seg.end);
          if (seg.action === 'remove') {
            removeRanges.push({ start: seg.start, end: seg.end });
          }
        });

        // Deduplicate cut times
        var uniqueCuts = [];
        var seen = {};
        cutTimes.forEach(function (t) {
          var rounded = Math.round(t * 100) / 100;
          if (!seen[rounded]) {
            seen[rounded] = true;
            uniqueCuts.push(rounded);
          }
        });

        console.log('[Pipeline] Unique cut points:', uniqueCuts.length);
        console.log('[Pipeline] Remove ranges:', removeRanges.length);

        var cutsJson = JSON.stringify(uniqueCuts);
        return evalScript('applyMultipleRazorCuts(\'' + cutsJson.replace(/'/g, "\\'") + '\')')
          .then(function (cutResult) {
            console.log('[Pipeline] Razor result:', JSON.stringify(cutResult));
            setStepState(4, 'active', 'Waiting for cuts to settle (' + (cutResult.successCount || 0) + ' cuts)...');

            // Give Premiere Pro time to process all the razor cuts
            return new Promise(function (resolve) {
              setTimeout(function () {
                setStepState(4, 'active', 'Disabling removed segments...');
                var rangesJson = JSON.stringify(removeRanges);
                evalScript('disableClipRanges(\'' + rangesJson.replace(/'/g, "\\'") + '\')')
                  .then(function (disableResult) {
                    console.log('[Pipeline] Disable result:', JSON.stringify(disableResult));
                    resolve(disableResult);
                  });
              }, 2000);
            });
          })
          .then(function (disableResult) {
            var disabledCount = disableResult ? (disableResult.disabledCount || 0) : 0;
            setStepState(4, 'completed', 'Done! ' + disabledCount + ' clips disabled');
            stateManager.setEditResults(decisions);
            showResults(decisions);
            AudioUtils.cleanupTempFiles([tempAudioPath]);
          });
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

  // ==================== RESULTS DISPLAY ====================

  function showResults(decisions) {
    els.storySummaryText.textContent = decisions.story_summary || 'Edit complete.';
    els.resultKept.textContent = decisions.kept_segments_count || 0;
    els.resultRemoved.textContent = decisions.removed_segments_count || 0;
    els.resultDuration.textContent = formatTime(decisions.estimated_duration || 0);
    els.resultSaved.textContent = formatTime(decisions.removed_duration || 0);

    els.resultsSection.classList.add('active');
    showToast('AI cut complete! Review and approve or undo.', 'success');
  }

  // ==================== APPROVE / UNDO ====================

  function approveEdit() {
    evalScript('approveChanges()')
      .then(function (result) {
        if (result.error) { showToast('Approve error: ' + result.error, 'error'); return; }
        stateManager.clearState();
        resetProgress();
        showToast('Edit approved! ✓ ' + (result.message || ''), 'success');
        refreshClipInfo();
      })
      .catch(function (err) { showToast('Approve failed: ' + err.message, 'error'); });
  }

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

  // ==================== EVENT LISTENERS ====================

  els.btnRefresh.addEventListener('click', refreshClipInfo);
  els.durationSlider.addEventListener('input', updateDurationDisplay);
  els.btnCreateCut.addEventListener('click', createCut);
  els.btnApprove.addEventListener('click', approveEdit);
  els.btnUndo.addEventListener('click', undoEdit);
  els.btnSettings.addEventListener('click', openSettings);
  els.btnSettingsClose.addEventListener('click', closeSettings);
  els.btnSaveSettings.addEventListener('click', saveSettings);

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
