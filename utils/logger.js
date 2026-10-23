// ============================================================
// utils/logger.js
// ============================================================
// Logging mínimo y consistente. En V3 esto se reemplaza/extiende
// por un historial persistente (ver ficha técnica, sección 32/V3.2).
// ============================================================

const PREFIX = "[Panafargo Sync]";

export const logger = {
  info: (...args) => console.log(PREFIX, ...args),
  warn: (...args) => console.warn(PREFIX, ...args),
  error: (...args) => console.error(PREFIX, ...args),
};
