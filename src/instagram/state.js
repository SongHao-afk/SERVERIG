const sessionStatus = {
  ok: false,
  lastCheckedAt: null,
  lastError: null
};

let sessionCheckRunning = false;
let lastAlertSentAt = 0;

function getSessionStatus() {
  return sessionStatus;
}

function setSessionStatus(nextStatus) {
  sessionStatus.ok = Boolean(nextStatus.ok);
  sessionStatus.lastCheckedAt = nextStatus.lastCheckedAt ?? sessionStatus.lastCheckedAt;
  sessionStatus.lastError = nextStatus.lastError ?? null;
}

function isSessionCheckRunning() {
  return sessionCheckRunning;
}

function setSessionCheckRunning(value) {
  sessionCheckRunning = Boolean(value);
}

function getLastAlertSentAt() {
  return lastAlertSentAt;
}

function setLastAlertSentAt(value) {
  lastAlertSentAt = Number(value || 0);
}

module.exports = {
  getSessionStatus,
  setSessionStatus,
  isSessionCheckRunning,
  setSessionCheckRunning,
  getLastAlertSentAt,
  setLastAlertSentAt
};