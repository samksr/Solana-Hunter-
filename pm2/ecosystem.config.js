module.exports = {
  apps: [{
    name: "solana-hunter-bot",
    script: "index.js",
    watch: false,
    autorestart: true,
    max_memory_restart: '450M' // Safety cap
  }]
};
