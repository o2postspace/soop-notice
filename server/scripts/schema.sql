CREATE DATABASE IF NOT EXISTS soop_notice
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE soop_notice;

-- 공지사항
CREATE TABLE IF NOT EXISTS notices (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  bj_id VARCHAR(64) NOT NULL,
  bj_name VARCHAR(128) NOT NULL,
  bj_tag VARCHAR(128) NOT NULL DEFAULT '',
  title_no BIGINT NOT NULL,
  title_name TEXT DEFAULT (''),
  content_html MEDIUMTEXT DEFAULT (''),
  reg_date DATETIME NOT NULL,
  read_cnt INT DEFAULT 0,
  is_pin TINYINT(1) DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_title_no (title_no),
  INDEX idx_notices_reg_date (reg_date DESC),
  INDEX idx_notices_bj_id (bj_id),
  INDEX idx_notices_read_cnt (read_cnt)
) ENGINE=InnoDB;

-- 방송 스케줄
CREATE TABLE IF NOT EXISTS schedules (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  bj_id VARCHAR(64) NOT NULL,
  bj_name VARCHAR(128) NOT NULL,
  title_no BIGINT NOT NULL,
  broadcast_start DATETIME NOT NULL,
  broadcast_end DATETIME DEFAULT NULL,
  description TEXT DEFAULT (''),
  raw_text TEXT DEFAULT (''),
  parsed_at DATETIME DEFAULT NULL,
  UNIQUE KEY uk_titleno_start (title_no, broadcast_start),
  INDEX idx_schedules_bj_id (bj_id),
  INDEX idx_schedules_start (broadcast_start)
) ENGINE=InnoDB;

-- 사이트 업데이트 공지
CREATE TABLE IF NOT EXISTS updates (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(512) NOT NULL,
  content TEXT NOT NULL,
  category VARCHAR(64) DEFAULT '업데이트',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 유저 피드백
CREATE TABLE IF NOT EXISTS feedback (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  subject VARCHAR(512) NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
