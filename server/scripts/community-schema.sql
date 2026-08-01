CREATE TABLE IF NOT EXISTS community_posts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  category ENUM('free', 'samguk', 'question') NOT NULL,
  title VARCHAR(120) NOT NULL,
  body TEXT NOT NULL,
  author_label VARCHAR(32) NOT NULL,
  author_key_hash BINARY(32) NULL,
  delete_password_hash VARCHAR(255) NULL,
  status ENUM('active', 'hidden', 'deleted') NOT NULL DEFAULT 'active',
  is_pinned TINYINT(1) NOT NULL DEFAULT 0,
  view_count INT UNSIGNED NOT NULL DEFAULT 0,
  comment_count INT UNSIGNED NOT NULL DEFAULT 0,
  recommend_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  INDEX idx_community_posts_all_latest (status, is_pinned, id),
  INDEX idx_community_posts_all_popular (status, is_pinned, recommend_count, id),
  INDEX idx_community_posts_category_latest (status, category, is_pinned, id),
  INDEX idx_community_posts_category_popular (status, category, is_pinned, recommend_count, id),
  FULLTEXT INDEX ft_community_posts_search (title, body) WITH PARSER ngram
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS community_comments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  post_id BIGINT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  author_label VARCHAR(32) NOT NULL,
  author_key_hash BINARY(32) NULL,
  delete_password_hash VARCHAR(255) NULL,
  status ENUM('active', 'hidden', 'deleted') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  INDEX idx_community_comments_post (post_id, status, id),
  CONSTRAINT fk_community_comments_post
    FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS community_reactions (
  post_id BIGINT UNSIGNED NOT NULL,
  actor_hash BINARY(32) NOT NULL,
  reaction_type ENUM('recommend') NOT NULL DEFAULT 'recommend',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, actor_hash, reaction_type),
  CONSTRAINT fk_community_reactions_post
    FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS community_post_views (
  post_id BIGINT UNSIGNED NOT NULL,
  viewer_hash BINARY(32) NOT NULL,
  view_token BINARY(16) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, viewer_hash),
  INDEX idx_community_post_views_expiry (expires_at),
  CONSTRAINT fk_community_post_views_post
    FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS community_reports (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  target_type ENUM('post', 'comment') NOT NULL,
  target_id BIGINT UNSIGNED NOT NULL,
  reporter_hash BINARY(32) NOT NULL,
  reason ENUM('profanity', 'spam', 'personal_info', 'other') NOT NULL,
  detail VARCHAR(500) NOT NULL DEFAULT '',
  status ENUM('pending', 'resolved', 'dismissed') NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_community_report_actor (target_type, target_id, reporter_hash),
  INDEX idx_community_reports_status (status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS community_rate_limits (
  bucket_key BINARY(32) NOT NULL,
  action_name VARCHAR(40) NOT NULL,
  window_start DATETIME NOT NULL,
  hits INT UNSIGNED NOT NULL DEFAULT 1,
  expires_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (bucket_key, action_name, window_start),
  INDEX idx_community_rate_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS community_submission_guards (
  actor_hash BINARY(32) NOT NULL,
  content_hash BINARY(32) NOT NULL,
  action_name VARCHAR(20) NOT NULL,
  claim_token BINARY(16) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (actor_hash, content_hash, action_name),
  INDEX idx_community_submission_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
