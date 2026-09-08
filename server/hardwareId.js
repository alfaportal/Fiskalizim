/** Hardware ID — i njëjti format në server, telefon dhe laptop (XXXX-XXXX-XXXX-XXXX). */

function compactHardwareId(hw) {
  return String(hw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16);
}

function formatHardwareId(hw) {
  const hex = compactHardwareId(hw);
  if (hex.length < 16) return hex;
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

function normalizeHardwareId(hw) {
  return formatHardwareId(hw);
}

function hardwareIdsEqual(a, b) {
  const ca = compactHardwareId(a);
  const cb = compactHardwareId(b);
  return ca.length >= 16 && cb.length >= 16 && ca === cb;
}

module.exports = {
  compactHardwareId,
  formatHardwareId,
  normalizeHardwareId,
  hardwareIdsEqual,
};
