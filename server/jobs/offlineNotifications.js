const { processOfflineNotifications } = require("../offlineNotificationService");

function startOfflineNotificationCron() {
  const HOUR_MS = 60 * 60 * 1000;
  const run = () => {
    processOfflineNotifications().catch((err) => {
      console.error("[cron] processOfflineNotifications:", err.message || err);
    });
  };
  setTimeout(run, 2 * 60 * 1000);
  setInterval(run, HOUR_MS);
}

module.exports = {
  startOfflineNotificationCron,
  processOfflineNotifications,
};
