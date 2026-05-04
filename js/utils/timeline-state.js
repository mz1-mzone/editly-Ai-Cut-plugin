/**
 * Editly AI Cut — Timeline State Manager
 * Saves and restores timeline state for the custom undo system.
 */

var TimelineStateManager = (function () {
  'use strict';

  function TimelineStateManager() {
    this._savedState = null;
    this._editPending = false;
    this._editResults = null;
  }

  /**
   * Store the pre-edit timeline state.
   */
  TimelineStateManager.prototype.saveState = function (stateData) {
    this._savedState = stateData;
    this._editPending = true;
  };

  /**
   * Get the saved state.
   */
  TimelineStateManager.prototype.getState = function () {
    return this._savedState;
  };

  /**
   * Check if there's an unapproved edit.
   */
  TimelineStateManager.prototype.hasUnsavedChanges = function () {
    return this._editPending;
  };

  /**
   * Store edit results for display.
   */
  TimelineStateManager.prototype.setEditResults = function (results) {
    this._editResults = results;
  };

  /**
   * Get edit results.
   */
  TimelineStateManager.prototype.getEditResults = function () {
    return this._editResults;
  };

  /**
   * Clear all state after approve or undo.
   */
  TimelineStateManager.prototype.clearState = function () {
    this._savedState = null;
    this._editPending = false;
    this._editResults = null;
  };

  return TimelineStateManager;
})();

if (typeof window !== 'undefined') {
  window.TimelineStateManager = TimelineStateManager;
}
