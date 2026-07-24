module.exports = {
  apps: [
    {
      name: "soop-notice",
      script: "./app.js",
      cwd: "/home/msbaek/deploy/soop-notice/server",
      instances: 1,
      env: {
        NODE_ENV: "production",
        PORT: 4000,
        ADAPTIVE_MIN_WORKERS: 1,
        ADAPTIVE_MAX_WORKERS: 8,
        DB_CONNECTION_LIMIT: 12,
      },
      max_memory_restart: "500M",
      // adaptive worker가 진행 중 응답을 최대 15초 동안 비운 뒤 종료할 시간을 보장한다.
      kill_timeout: 20000,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "/home/msbaek/deploy/logs/soop-notice-error.log",
      out_file: "/home/msbaek/deploy/logs/soop-notice-out.log",
      merge_logs: true,
    },
    // 친구 프로젝트 (필요 시 활성화)
    // {
    //   name: "game2017v-web",
    //   script: "./app.js",
    //   cwd: "/home/deploy/game2017v-web",
    //   instances: 1,
    //   env: { NODE_ENV: "production", PORT: 4001 },
    //   max_memory_restart: "500M",
    //   error_file: "/home/msbaek/deploy/logs/game2017v-error.log",
    //   out_file: "/home/msbaek/deploy/logs/game2017v-out.log",
    //   merge_logs: true,
    // },
  ],
};
