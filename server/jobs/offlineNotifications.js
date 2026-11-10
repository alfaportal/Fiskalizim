const { processOfflineNotifications } = require("../offlineNotificationService");

function startOfflineNotificationCron() {
  const run = () => {
    processOfflineNotifications().catch((err) => {
      console.error("[offline-48h]", err.message || err);
    });
  };
  setTimeout(run, 2 * 60 * 1000);
  setInterval(run, 15 * 60 * 1000);
}

module.exports = {
  startOfflineNotificationCron,
  processOfflineNotifications,
};
