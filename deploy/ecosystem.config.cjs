module.exports = {
  apps: [
    {
      name: "hoteldesk-api",
      cwd: "/srv/hoteldesk/apps/api",
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "800M",
      env: {
        NODE_ENV: "production",
        PORT: "4000",
      },
      out_file: "/var/log/hoteldesk/api.out.log",
      error_file: "/var/log/hoteldesk/api.err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
