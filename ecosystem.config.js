module.exports = {
  apps: [
    {
      name: "moto-rooter",
      script: "server.js",
      cwd: "/volume1/web/moto-rooter.feralcreative.dev",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production", // Changed to production for server deployment
        PORT: 6686,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 6686,
      },

      // Enhanced logging for better monitoring
      log_file: "/volume1/web/logs/moto-rooter-combined.log",
      out_file: "/volume1/web/logs/moto-rooter-out.log",
      error_file: "/volume1/web/logs/moto-rooter-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      time: true,

      // Enhanced process management for maximum reliability
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",

      // Optimized restart settings for indefinite uptime
      min_uptime: "10s", // Prevent rapid restart loops
      max_restarts: 50, // Increased from 10 for better reliability
      restart_delay: 5000, // Slightly increased delay

      // Additional reliability settings
      kill_timeout: 5000, // Time to wait before force killing
      listen_timeout: 3000, // Time to wait for app to listen

      // Environment variables (add your specific ones here)
      // GOOGLE_MAPS_API_KEY will be loaded from .env file via dotenv
    },
  ],
};
