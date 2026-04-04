// PM2 config for AgentSignal Trader
// Start: npm start
// Logs:  npm run logs

module.exports = {
  apps: [
    {
      name: "trader",
      script: "node",
      args: "trader.mjs",
      cwd: __dirname,
      // 9:31 AM ET = 13:31 UTC on weekdays
      // Adjust if you're running in a different timezone
      cron_restart: "31 13 * * 1-5",
      autorestart: false,
      watch: false,
      env: { NODE_ENV: "production" },
    },
    {
      name: "trader-dashboard",
      script: "node",
      args: "dashboard.mjs",
      cwd: __dirname,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: "production" },
    },
  ],
};
