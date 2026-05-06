/**
 * Editly AI Cut — ExtendScript Host Script
 * Main entry point for Premiere Pro ExtendScript API calls.
 * All functions here are callable from the CEP panel via csInterface.evalScript().
 */

// ========== TIMELINE READ ==========

/**
 * Get info about the currently selected clips on the active sequence.
 * Returns JSON string with array of clip data.
 */
function getSelectedClips() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) {
      return JSON.stringify({ error: 'No active sequence found.' });
    }

    var selection = seq.getSelection();
    if (!selection || selection.length === 0) {
      return JSON.stringify({ error: 'No clips selected. Select clips on the timeline first.' });
    }

    var clips = [];
    var seen = {}; // Deduplicate linked video+audio items

    for (var i = 0; i < selection.length; i++) {
      var item = selection[i];
      var startSec = item.start ? item.start.seconds : 0;
      var endSec = item.end ? item.end.seconds : 0;
      var itemName = item.name || 'Untitled';

      // Create a unique key to avoid counting linked audio+video twice
      var dedupeKey = itemName + '_' + startSec.toFixed(3) + '_' + endSec.toFixed(3);
      if (seen[dedupeKey]) continue;
      seen[dedupeKey] = true;

      var clipData = {
        index: clips.length,
        name: itemName,
        startTime: startSec,
        endTime: endSec,
        duration: item.duration ? item.duration.seconds : 0,
        inPoint: item.inPoint ? item.inPoint.seconds : 0,
        outPoint: item.outPoint ? item.outPoint.seconds : 0,
        disabled: item.disabled || false,
        mediaType: item.mediaType || 'unknown'
      };

      // Try to get track info
      if (item.parentTrackIndex !== undefined) {
        clipData.trackIndex = item.parentTrackIndex;
      }

      // Try to get the source media path
      if (item.projectItem && item.projectItem.getMediaPath) {
        try {
          clipData.mediaPath = item.projectItem.getMediaPath();
        } catch (e) {
          clipData.mediaPath = '';
        }
      }

      clipData.hasAudio = true;
      clipData.hasVideo = true;

      clips.push(clipData);
    }

    $.writeln('[Editly] getSelectedClips: ' + clips.length + ' unique clips (from ' + selection.length + ' selection items)');
    return JSON.stringify({ clips: clips, count: clips.length });
  } catch (e) {
    return JSON.stringify({ error: 'Error reading clips: ' + e.message });
  }
}

/**
 * Get info about the active sequence.
 */
function getSequenceInfo() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) {
      return JSON.stringify({ error: 'No active sequence.' });
    }

    return JSON.stringify({
      name: seq.name,
      id: seq.sequenceID,
      frameSizeHorizontal: seq.frameSizeHorizontal,
      frameSizeVertical: seq.frameSizeVertical,
      timebase: seq.timebase,
      end: seq.end ? seq.end.seconds : 0,
      videoTrackCount: seq.videoTracks ? seq.videoTracks.numTracks : 0,
      audioTrackCount: seq.audioTracks ? seq.audioTracks.numTracks : 0
    });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

/**
 * Get the full timeline range of the selected clips (earliest start to latest end).
 */
function getTimelineRange() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: 'No active sequence.' });

    var selection = seq.getSelection();
    if (!selection || selection.length === 0) {
      return JSON.stringify({ error: 'No clips selected.' });
    }

    var earliest = Infinity;
    var latest = 0;

    for (var i = 0; i < selection.length; i++) {
      var s = selection[i].start ? selection[i].start.seconds : 0;
      var e = selection[i].end ? selection[i].end.seconds : 0;
      if (s < earliest) earliest = s;
      if (e > latest) latest = e;
    }

    return JSON.stringify({
      startTime: earliest,
      endTime: latest,
      duration: latest - earliest
    });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}


// ========== AUDIO EXPORT ==========

/**
 * Get source media paths and timing info for all selected clips.
 * This data is used by Node.js to extract audio via ffmpeg.
 * Returns clip-to-source mapping with timeline offsets.
 */
function getClipMediaInfo() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: 'No active sequence.' });

    var selection = seq.getSelection();
    if (!selection || selection.length === 0) {
      return JSON.stringify({ error: 'No clips selected.' });
    }

    var mediaClips = [];
    var seen = {}; // Deduplicate linked video+audio items

    for (var i = 0; i < selection.length; i++) {
      var item = selection[i];
      var mediaPath = '';

      if (item.projectItem && item.projectItem.getMediaPath) {
        try { mediaPath = item.projectItem.getMediaPath(); } catch (e) {}
      }

      if (!mediaPath) continue;

      var startSec = item.start ? item.start.seconds : 0;
      var endSec = item.end ? item.end.seconds : 0;

      // Deduplicate: same file + same timeline position = linked audio/video
      var dedupeKey = mediaPath + '_' + startSec.toFixed(3) + '_' + endSec.toFixed(3);
      if (seen[dedupeKey]) continue;
      seen[dedupeKey] = true;

      mediaClips.push({
        mediaPath: mediaPath,
        timelineStart: startSec,
        timelineEnd: endSec,
        sourceInPoint: item.inPoint ? item.inPoint.seconds : 0,
        sourceOutPoint: item.outPoint ? item.outPoint.seconds : 0,
        duration: item.duration ? item.duration.seconds : 0,
        name: item.name || 'clip_' + i
      });
    }

    $.writeln('[Editly] getClipMediaInfo: ' + mediaClips.length + ' unique media clips');
    return JSON.stringify({
      success: true,
      clips: mediaClips,
      count: mediaClips.length,
      timebase: seq.timebase
    });
  } catch (e) {
    return JSON.stringify({ error: 'Failed to get media info: ' + e.message });
  }
}

/**
 * Get OS temp directory path for storing temporary audio files.
 */
function getTempDirectory() {
  try {
    var tmpFolder = Folder.temp;
    var editlyTmp = new Folder(tmpFolder.fsName + '/EditlyAICut');
    if (!editlyTmp.exists) {
      editlyTmp.create();
    }
    return JSON.stringify({ path: editlyTmp.fsName });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}


// ========== TIMELINE EDIT ==========

/**
 * Convert seconds to ticks (Premiere Pro internal time).
 * 254,016,000,000 ticks per second.
 */
function secondsToTicks(seconds) {
  return Math.round(seconds * 254016000000);
}

/**
 * Convert seconds to timecode string HH:MM:SS:FF
 * @param {number} totalSeconds - time in seconds
 * @param {number} fps - frames per second (default 24)
 */
function secondsToTimecode(totalSeconds, fps) {
  fps = fps || 24;
  var hours = Math.floor(totalSeconds / 3600);
  var minutes = Math.floor((totalSeconds % 3600) / 60);
  var seconds = Math.floor(totalSeconds % 60);
  var frames = Math.floor((totalSeconds % 1) * fps);

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return pad(hours) + ':' + pad(minutes) + ':' + pad(seconds) + ':' + pad(frames);
}

/**
 * Get the sequence frame rate.
 */
function getSequenceFPS() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return 24;
    // timebase is ticks per frame
    var ticksPerFrame = parseInt(seq.timebase);
    if (ticksPerFrame > 0) {
      return Math.round(254016000000 / ticksPerFrame);
    }
    return 24;
  } catch (e) {
    return 24;
  }
}

/**
 * Save the complete state of all clips in the sequence for undo.
 * Returns JSON with full state data.
 */
function saveTimelineState() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: 'No active sequence.' });

    var state = {
      sequenceId: seq.sequenceID,
      sequenceName: seq.name,
      timestamp: (function(){ var d = new Date(); return d.getFullYear() + '-' + (d.getMonth()+1) + '-' + d.getDate() + 'T' + d.getHours() + ':' + d.getMinutes() + ':' + d.getSeconds(); })(),
      videoTracks: [],
      audioTracks: []
    };

    // Save video tracks state
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
      var vTrack = seq.videoTracks[v];
      var vClips = [];
      for (var c = 0; c < vTrack.clips.numItems; c++) {
        var clip = vTrack.clips[c];
        vClips.push({
          index: c,
          name: clip.name,
          start: clip.start.seconds,
          end: clip.end.seconds,
          inPoint: clip.inPoint.seconds,
          outPoint: clip.outPoint.seconds,
          duration: clip.duration.seconds,
          disabled: clip.disabled
        });
      }
      state.videoTracks.push({ trackIndex: v, clips: vClips });
    }

    // Save audio tracks state
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
      var aTrack = seq.audioTracks[a];
      var aClips = [];
      for (var ac = 0; ac < aTrack.clips.numItems; ac++) {
        var aclip = aTrack.clips[ac];
        aClips.push({
          index: ac,
          name: aclip.name,
          start: aclip.start.seconds,
          end: aclip.end.seconds,
          inPoint: aclip.inPoint.seconds,
          outPoint: aclip.outPoint.seconds,
          duration: aclip.duration.seconds,
          disabled: aclip.disabled
        });
      }
      state.audioTracks.push({ trackIndex: a, clips: aClips });
    }

    return JSON.stringify({ success: true, state: state });
  } catch (e) {
    return JSON.stringify({ error: 'Failed to save state: ' + e.message });
  }
}

/**
 * Apply multiple razor cuts at specified times.
 * @param {string} timesJson - JSON array of time values in seconds
 */
function applyMultipleRazorCuts(timesJson) {
  try {
    var times = JSON.parse(timesJson);
    var fps = getSequenceFPS();

    $.writeln('[Editly] applyMultipleRazorCuts: ' + times.length + ' cuts, FPS: ' + fps);

    // Sort times in reverse order so cuts don't shift subsequent positions
    times.sort(function(a, b) { return b - a; });

    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) return JSON.stringify({ error: 'No active QE sequence.' });

    var results = [];
    var successCount = 0;

    for (var i = 0; i < times.length; i++) {
      try {
        var tc = secondsToTimecode(parseFloat(times[i]), fps);
        $.writeln('[Editly] Razor at ' + times[i] + 's -> TC: ' + tc);
        qeSeq.razor(tc);
        results.push({ time: times[i], timecode: tc, success: true });
        successCount++;
      } catch (cutErr) {
        $.writeln('[Editly] Razor FAILED at ' + times[i] + 's: ' + cutErr.message);
        results.push({ time: times[i], success: false, error: cutErr.message });
      }
    }

    $.writeln('[Editly] Razor complete: ' + successCount + '/' + times.length + ' successful');
    return JSON.stringify({ success: true, cuts: results, successCount: successCount });
  } catch (e) {
    $.writeln('[Editly] applyMultipleRazorCuts ERROR: ' + e.message);
    return JSON.stringify({ error: 'Multiple razor cuts failed: ' + e.message });
  }
}

/**
 * Disable clips that fall within specified time ranges.
 * Uses overlap-based matching: if a clip's midpoint falls in a remove range, disable it.
 * @param {string} rangesJson - JSON array of {start, end} ranges to disable
 */
function disableClipRanges(rangesJson) {
  try {
    var ranges = JSON.parse(rangesJson);
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: 'No active sequence.' });

    $.writeln('[Editly] disableClipRanges: ' + ranges.length + ' ranges');

    var disabledCount = 0;
    var tolerance = 0.1; // 100ms tolerance

    // Process video tracks
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
      var track = seq.videoTracks[v];
      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        var clipStart = clip.start.seconds;
        var clipEnd = clip.end.seconds;
        var clipMid = (clipStart + clipEnd) / 2;

        for (var r = 0; r < ranges.length; r++) {
          var rStart = ranges[r].start - tolerance;
          var rEnd = ranges[r].end + tolerance;

          // Disable if clip's midpoint falls in the remove range
          // OR if the clip is mostly contained in the range (>50% overlap)
          var overlapStart = Math.max(clipStart, rStart);
          var overlapEnd = Math.min(clipEnd, rEnd);
          var overlapDur = Math.max(0, overlapEnd - overlapStart);
          var clipDur = clipEnd - clipStart;
          var overlapRatio = clipDur > 0 ? overlapDur / clipDur : 0;

          if (overlapRatio > 0.5) {
            clip.disabled = true;
            disabledCount++;
            $.writeln('[Editly] Disabled V' + v + ' clip ' + c + ': ' + clip.name + ' (' + clipStart.toFixed(2) + '-' + clipEnd.toFixed(2) + ')');
            break;
          }
        }
      }
    }

    // Process audio tracks
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
      var aTrack = seq.audioTracks[a];
      for (var ac = 0; ac < aTrack.clips.numItems; ac++) {
        var aClip = aTrack.clips[ac];
        var aClipStart = aClip.start.seconds;
        var aClipEnd = aClip.end.seconds;

        for (var ar = 0; ar < ranges.length; ar++) {
          var aRStart = ranges[ar].start - tolerance;
          var aREnd = ranges[ar].end + tolerance;

          var aOverlapStart = Math.max(aClipStart, aRStart);
          var aOverlapEnd = Math.min(aClipEnd, aREnd);
          var aOverlapDur = Math.max(0, aOverlapEnd - aOverlapStart);
          var aClipDur = aClipEnd - aClipStart;
          var aOverlapRatio = aClipDur > 0 ? aOverlapDur / aClipDur : 0;

          if (aOverlapRatio > 0.5) {
            aClip.disabled = true;
            disabledCount++;
            $.writeln('[Editly] Disabled A' + a + ' clip ' + ac + ': ' + aClip.name + ' (' + aClipStart.toFixed(2) + '-' + aClipEnd.toFixed(2) + ')');
            break;
          }
        }
      }
    }

    $.writeln('[Editly] Total disabled: ' + disabledCount);
    return JSON.stringify({ success: true, disabledCount: disabledCount });
  } catch (e) {
    $.writeln('[Editly] disableClipRanges ERROR: ' + e.message);
    return JSON.stringify({ error: 'Disable failed: ' + e.message });
  }
}


// ========== TIMELINE RESTORE ==========

/**
 * Undo the AI edit by using Premiere's native Edit > Undo repeatedly.
 * We stored a count of operations (razor cuts + disables) so we undo all of them.
 */
function undoDisableAll() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: 'No active sequence.' });

    $.writeln('[Editly] undoDisableAll: re-enabling disabled clips and using Premiere undo');

    // First approach: re-enable all disabled clips
    var enabledCount = 0;
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
      var track = seq.videoTracks[v];
      for (var c = 0; c < track.clips.numItems; c++) {
        if (track.clips[c].disabled) {
          track.clips[c].disabled = false;
          enabledCount++;
        }
      }
    }
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
      var aTrack = seq.audioTracks[a];
      for (var ac = 0; ac < aTrack.clips.numItems; ac++) {
        if (aTrack.clips[ac].disabled) {
          aTrack.clips[ac].disabled = false;
          enabledCount++;
        }
      }
    }

    // Also trigger Premiere's built-in undo multiple times to reverse razor cuts
    // Each razor cut is one undo step, each disable is one undo step
    // We'll do a generous number of undos to cover all operations
    var undoSteps = enabledCount + 50; // Extra for razor cuts
    for (var u = 0; u < undoSteps; u++) {
      app.project.activeSequence.undo();
    }

    $.writeln('[Editly] Undo complete: re-enabled ' + enabledCount + ' clips + ' + undoSteps + ' undo steps');

    return JSON.stringify({ success: true, enabledCount: enabledCount, undoSteps: undoSteps });
  } catch (e) {
    $.writeln('[Editly] undoDisableAll ERROR: ' + e.message);
    // If sequence.undo() doesn't exist, fall back to just re-enabling
    return JSON.stringify({ success: true, enabledCount: enabledCount || 0, note: 'Undo fallback: ' + e.message });
  }
}

/**
 * Restore the timeline to a specific saved state.
 * @param {string} stateJson - JSON string of the saved state
 */
function restoreTimelineState(stateJson) {
  try {
    var state = JSON.parse(stateJson);
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: 'No active sequence.' });

    var restoredCount = 0;

    // Restore video track clip states
    if (state.videoTracks) {
      for (var v = 0; v < state.videoTracks.length; v++) {
        var savedTrack = state.videoTracks[v];
        var ti = savedTrack.trackIndex;
        if (ti < seq.videoTracks.numTracks) {
          var track = seq.videoTracks[ti];
          for (var c = 0; c < savedTrack.clips.length && c < track.clips.numItems; c++) {
            var savedClip = savedTrack.clips[c];
            var clip = track.clips[c];
            if (clip.disabled !== savedClip.disabled) {
              clip.disabled = savedClip.disabled;
              restoredCount++;
            }
          }
        }
      }
    }

    // Restore audio track clip states
    if (state.audioTracks) {
      for (var a = 0; a < state.audioTracks.length; a++) {
        var savedATrack = state.audioTracks[a];
        var ati = savedATrack.trackIndex;
        if (ati < seq.audioTracks.numTracks) {
          var aTrack = seq.audioTracks[ati];
          for (var ac = 0; ac < savedATrack.clips.length && ac < aTrack.clips.numItems; ac++) {
            var savedAClip = savedATrack.clips[ac];
            var aClip = aTrack.clips[ac];
            if (aClip.disabled !== savedAClip.disabled) {
              aClip.disabled = savedAClip.disabled;
              restoredCount++;
            }
          }
        }
      }
    }

    return JSON.stringify({ success: true, restoredCount: restoredCount });
  } catch (e) {
    return JSON.stringify({ error: 'Restore failed: ' + e.message });
  }
}

/**
 * Remove all disabled clips with ripple delete (approve/finalize operation).
 * Ripple delete closes the gaps left by removed clips.
 */
function approveChanges() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: 'No active sequence.' });

    $.writeln('[Editly] approveChanges: ripple-deleting disabled clips');

    var removedCount = 0;

    // Remove disabled video clips (iterate in reverse to avoid index shifting)
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
      var vTrack = seq.videoTracks[v];
      for (var c = vTrack.clips.numItems - 1; c >= 0; c--) {
        var clip = vTrack.clips[c];
        if (clip.disabled) {
          try {
            clip.remove(true, true); // remove(ripple=true, alignToVideo=true)
            removedCount++;
            $.writeln('[Editly] Ripple-removed V' + v + ' clip ' + c);
          } catch (removeErr) {
            $.writeln('[Editly] Failed to remove V' + v + ' clip ' + c + ': ' + removeErr.message);
            // Fallback: try without ripple
            try {
              clip.remove(false, false);
              removedCount++;
              $.writeln('[Editly] Fallback removed V' + v + ' clip ' + c);
            } catch (e2) {
              $.writeln('[Editly] All remove methods failed for V' + v + ' clip ' + c);
            }
          }
        }
      }
    }

    // Remove disabled audio clips
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
      var aTrack = seq.audioTracks[a];
      for (var ac = aTrack.clips.numItems - 1; ac >= 0; ac--) {
        var aClip = aTrack.clips[ac];
        if (aClip.disabled) {
          try {
            aClip.remove(true, true); // ripple delete
            removedCount++;
            $.writeln('[Editly] Ripple-removed A' + a + ' clip ' + ac);
          } catch (aRemoveErr) {
            try {
              aClip.remove(false, false);
              removedCount++;
            } catch (e2) {
              $.writeln('[Editly] All remove methods failed for A' + a + ' clip ' + ac);
            }
          }
        }
      }
    }

    $.writeln('[Editly] approveChanges complete: ripple-removed ' + removedCount + ' clips');

    return JSON.stringify({
      success: true,
      message: removedCount + ' clips ripple-deleted from timeline.',
      removedCount: removedCount
    });
  } catch (e) {
    $.writeln('[Editly] approveChanges ERROR: ' + e.message);
    return JSON.stringify({ error: 'Approve failed: ' + e.message });
  }
}


// ========== VFX: PROJECT FOLDER ==========

/**
 * Get the folder path of the current Premiere project file.
 * VFX outputs will be saved here in an "Editly_VFX" subfolder.
 */
function getProjectFolder() {
  try {
    var projectPath = app.project.path;
    if (!projectPath || projectPath === '') {
      return JSON.stringify({ error: 'Project not saved yet' });
    }
    // Extract directory from full path
    var lastSlash = projectPath.lastIndexOf('/');
    if (lastSlash < 0) lastSlash = projectPath.lastIndexOf('\\');
    var folder = projectPath.substring(0, lastSlash);
    return JSON.stringify({ success: true, folder: folder, projectPath: projectPath });
  } catch (e) {
    return JSON.stringify({ error: 'getProjectFolder failed: ' + e.message });
  }
}

// ========== VFX: CLIP MEDIA INFO ==========

/**
 * Get the source media file path and timing info for the selected clip.
 * Returns the actual file path on disk so ffmpeg can extract frames.
 */
function getSelectedClipMediaPath() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: 'No active sequence' });

    var selection = seq.getSelection();
    if (!selection || selection.length === 0) {
      return JSON.stringify({ error: 'No clip selected' });
    }

    // Take the first selected clip
    var clip = selection[0];
    var mediaPath = '';
    var clipName = clip.name || 'Untitled';

    // Get the source media file path
    if (clip.projectItem && clip.projectItem.getMediaPath) {
      mediaPath = clip.projectItem.getMediaPath();
    }

    if (!mediaPath) {
      return JSON.stringify({ error: 'Could not get media path for clip: ' + clipName });
    }

    // Get timing info (accounting for cuts)
    var startTime = clip.start ? clip.start.seconds : 0;
    var endTime = clip.end ? clip.end.seconds : 0;
    var inPoint = clip.inPoint ? clip.inPoint.seconds : 0;
    var outPoint = clip.outPoint ? clip.outPoint.seconds : 0;
    var duration = endTime - startTime;

    // Get sequence frame size for aspect ratio matching
    var frameWidth = seq.frameSizeHorizontal || 1920;
    var frameHeight = seq.frameSizeVertical || 1080;

    return JSON.stringify({
      success: true,
      mediaPath: mediaPath,
      clipName: clipName,
      startTime: startTime,
      endTime: endTime,
      inPoint: inPoint,
      outPoint: outPoint,
      duration: duration,
      frameWidth: frameWidth,
      frameHeight: frameHeight
    });
  } catch (e) {
    return JSON.stringify({ error: 'getSelectedClipMediaPath failed: ' + e.message });
  }
}


// ========== VFX: IMPORT AND PLACE VIDEO ==========

/**
 * Import a generated VFX video and place it above the original clip.
 * @param {string} videoPath - Path to the generated video file
 * @param {number} startSeconds - Where to place it on the timeline (seconds)
 */
function importAndPlaceAbove(videoPath, startSeconds) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: 'No active sequence' });

    // Import the video into the project
    var importOk = app.project.importFiles([videoPath], true, app.project.rootItem, false);
    if (!importOk) {
      return JSON.stringify({ error: 'Failed to import video file' });
    }

    // Find the imported item (most recently added)
    var rootItem = app.project.rootItem;
    var importedItem = null;
    for (var i = rootItem.children.numItems - 1; i >= 0; i--) {
      var child = rootItem.children[i];
      if (child.name && child.getMediaPath && child.getMediaPath() === videoPath) {
        importedItem = child;
        break;
      }
    }
    if (!importedItem && rootItem.children.numItems > 0) {
      importedItem = rootItem.children[rootItem.children.numItems - 1];
    }
    if (!importedItem) {
      return JSON.stringify({ error: 'Could not find imported item in project' });
    }

    var videoTracks = seq.videoTracks;
    var seqWidth = seq.frameSizeHorizontal;
    var seqHeight = seq.frameSizeVertical;

    // Find the source clip's track by matching the startTime
    var sourceTrackIdx = 0;
    var insertTimeSec = startSeconds;
    var insertTime = new Time();
    insertTime.seconds = insertTimeSec;

    // Try to find exact clip at this time position to get its track
    for (var t = 0; t < videoTracks.numTracks; t++) {
      var trk = videoTracks[t];
      for (var c = 0; c < trk.clips.numItems; c++) {
        var cl = trk.clips[c];
        var clStart = cl.start ? cl.start.seconds : -1;
        // If clip starts within 0.5s of our target, this is the source track
        if (Math.abs(clStart - insertTimeSec) < 0.5) {
          sourceTrackIdx = t;
          break;
        }
      }
    }

    // Search for an empty track above the source track
    var targetTrackIdx = -1;
    for (var t = sourceTrackIdx + 1; t < videoTracks.numTracks; t++) {
      var trk = videoTracks[t];
      var hasConflict = false;

      for (var c = 0; c < trk.clips.numItems; c++) {
        var cl = trk.clips[c];
        var clStart = cl.start ? cl.start.seconds : 0;
        var clEnd = cl.end ? cl.end.seconds : 0;
        // Check if any clip on this track overlaps our insert time range
        // Our clip duration is unknown here, so check if insert point falls within existing clip
        if (clEnd > insertTimeSec && clStart < (insertTimeSec + 60)) {
          hasConflict = true;
          break;
        }
      }

      if (!hasConflict) {
        targetTrackIdx = t;
        break;
      }
    }

    // If no empty track found, try to add a new track or use the topmost one
    if (targetTrackIdx < 0) {
      try {
        // Try QE DOM to add track (works across more Premiere versions)
        var qeSeq = qe.project.getActiveSequence();
        qeSeq.addTracks(1, 0, 0);
        targetTrackIdx = videoTracks.numTracks - 1;
      } catch (addErr) {
        // Fallback: just use the topmost existing track
        targetTrackIdx = videoTracks.numTracks - 1;
      }
    }

    // Place the clip using overwriteClip (won't shift other clips)
    var targetTrack = videoTracks[targetTrackIdx];
    targetTrack.overwriteClip(importedItem, insertTime);

    // Scale-to-fit: after inserting, find the new clip and adjust scale
    var placedClip = null;
    for (var c = 0; c < targetTrack.clips.numItems; c++) {
      var cl = targetTrack.clips[c];
      var clStart = cl.start ? cl.start.seconds : -1;
      if (Math.abs(clStart - insertTimeSec) < 0.5) {
        placedClip = cl;
        break;
      }
    }

    if (placedClip) {
      try {
        // Get the generated video's intrinsic dimensions from project item
        var mediaWidth = 0;
        var mediaHeight = 0;
        // Try to read from the clip's component params
        var motionComponent = placedClip.components[1]; // Motion component
        if (motionComponent) {
          // Find Scale parameter
          for (var p = 0; p < motionComponent.properties.numItems; p++) {
            var prop = motionComponent.properties[p];
            if (prop.displayName === 'Scale') {
              // Calculate scale to fit sequence
              // Kling outputs may differ from sequence resolution
              // Default to 100% and let Premiere handle it
              // If we know the source dimensions, calculate proper scale
              prop.setValue(100, true);
            }
            // Set "Scale to Frame Size" via uniform scale
            if (prop.displayName === 'Scale Width') {
              prop.setValue(100, true);
            }
          }
        }

        // Use setScaleToFrameSize if available (PP 2020+)
        if (placedClip.projectItem && placedClip.projectItem.setScaleToFrameSize) {
          placedClip.projectItem.setScaleToFrameSize();
        }
      } catch (scaleErr) {
        // Scale adjustment is best-effort, don't fail the whole operation
      }
    }

    return JSON.stringify({
      success: true,
      message: 'VFX placed on V' + (targetTrackIdx + 1) + ' at ' + insertTimeSec.toFixed(2) + 's',
      trackIndex: targetTrackIdx
    });
  } catch (e) {
    return JSON.stringify({ error: 'importAndPlaceAbove failed: ' + e.message });
  }
}
