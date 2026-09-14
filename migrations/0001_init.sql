CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '🔗',
  category TEXT NOT NULL DEFAULT '其他',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_links_category
ON links(category);

CREATE INDEX IF NOT EXISTS idx_links_title
ON links(title);

-- 示例数据，可按需删除
INSERT INTO links (title, url, icon, category) VALUES
  ('Cloudflare', 'https://www.cloudflare.com', '☁️', '开发'),
  ('GitHub', 'https://github.com', '🐙', '开发'),
  ('MDN Web Docs', 'https://developer.mozilla.org', '📚', '开发'),
  ('Google', 'https://www.google.com', '🔍', '工具'),
  ('ChatGPT', 'https://chatgpt.com', '🤖', 'AI');
