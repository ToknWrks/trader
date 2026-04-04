// PM2 config for AgentSignal Trader
// Start: npm start
// Logs:  npm run logs

module.exports = {
  apps: [
    {
      name: "trader",
      script: "node",
      // Stocks/ETFs: run once at market open (9:31 AM ET = 13:31 UTC), weekdays only
      args: "trader.mjs --stocks-only",
      cwd: __dirname,
      cron_restart: "31 13 * * 1-5",
      autorestart: false,
      watch: false,
      env: { NODE_ENV: "production" },
    },
    {
      name: "trader-crypto",
      script: "node",
      // Crypto: run every hour — markets are 24/7, react to signal flips same day
      args: "trader.mjs --crypto-only",
      cwd: __dirname,
      cron_restart: "0 * * * *",
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
