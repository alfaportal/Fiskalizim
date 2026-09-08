const crypto = require("crypto");

function genLicenseKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(16);
  const part = (offset) => {
    let s = "";
    for (let i = 0; i < 4; i += 1) s += chars[bytes[offset + i] % chars.length];
    return s;
  };
  return `${part(0)}-${part(4)}-${part(8)}-${part(12)}`;
}

module.exports = { genLicenseKey };
