#!/bin/bash
# GitHub webhook에서 호출하는 배포 스크립트
# 사용법: deploy.sh [repo_name]

REPO_NAME=${1:-soop-notice}
DEPLOY_DIR="/home/msbaek/deploy"

case "$REPO_NAME" in
  soop-notice|afreecanotice)
    cd "$DEPLOY_DIR/soop-notice" || exit 1
    git pull origin master
    cd server
    npm install --production
    pm2 restart soop-notice
    echo "soop-notice deployed"
    ;;
  game2017v-web)
    cd "$DEPLOY_DIR/game2017v-web" || exit 1
    git pull origin master
    npm install --production
    pm2 restart game2017v-web
    echo "game2017v-web deployed"
    ;;
  *)
    echo "Unknown repo: $REPO_NAME"
    exit 1
    ;;
esac
