const DEFAULT_LATE_DROP_OFF_AFTER = '08:36';
const DEFAULT_LATE_PICK_UP_AFTER = '13:35';

function isValidTimeValue(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function normalizeScheduleSettings(settings = {}) {
  const lateDropOffAfter = isValidTimeValue(settings.lateDropOffAfter || settings.late_drop_off_after)
    ? (settings.lateDropOffAfter || settings.late_drop_off_after)
    : DEFAULT_LATE_DROP_OFF_AFTER;
  const latePickUpAfter = isValidTimeValue(settings.latePickUpAfter || settings.late_pick_up_after)
    ? (settings.latePickUpAfter || settings.late_pick_up_after)
    : DEFAULT_LATE_PICK_UP_AFTER;

  const overrides = Array.isArray(settings.overrides) ? settings.overrides : [];
  const normalizedOverrides = overrides
    .filter((override) => override && typeof override === 'object')
    .map((override) => ({
      id: override.id || `${override.type || 'day'}-${override.value || ''}-${override.action || ''}`,
      type: override.type === 'date' ? 'date' : 'day',
      value: String(override.value || '').trim(),
      action: override.action === 'pick_up' ? 'pick_up' : 'drop_off',
      time: isValidTimeValue(override.time) ? override.time : '',
    }))
    .filter((override) => override.value && override.time);

  return {
    lateDropOffAfter,
    latePickUpAfter,
    overrides: normalizedOverrides,
  };
}

function getEffectiveScheduleTime(action, timestamp, settings = {}) {
  const normalizedSettings = normalizeScheduleSettings(settings);
  const actionKey = action === 'pick_up' ? 'pick_up' : 'drop_off';
  const defaultTime = actionKey === 'pick_up' ? normalizedSettings.latePickUpAfter : normalizedSettings.lateDropOffAfter;

  if (!timestamp) {
    return defaultTime;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return defaultTime;
  }

  const dateKey = date.toISOString().slice(0, 10);
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });

  const override = normalizedSettings.overrides.find((entry) => {
    if (entry.action !== actionKey) {
      return false;
    }

    if (entry.type === 'date') {
      return entry.value === dateKey;
    }

    return entry.value.toLowerCase() === dayName.toLowerCase();
  });

  return override?.time || defaultTime;
}

module.exports = {
  DEFAULT_LATE_DROP_OFF_AFTER,
  DEFAULT_LATE_PICK_UP_AFTER,
  isValidTimeValue,
  normalizeScheduleSettings,
  getEffectiveScheduleTime,
};
