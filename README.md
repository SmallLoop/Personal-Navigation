# Personal Navigation - 个人导航页部署文档

基于 Cloudflare Workers + D1 的轻量级个人导航页，支持后台管理。

## 项目结构

```
personal-nav/
├── migrations/          # D1 数据库迁移脚本
│   └── 0001_init.sql   # 初始化表结构
├── public/              # 静态资源（Cloudflare Assets）
│   ├── index.html       # 公开导航页
│   └── admin.html       # 后台管理页
├── src/
│   └── worker.js        # Cloudflare Worker 后端
├── wrangler.toml        # Wrangler 配置文件
└── README.md            # 本文档
```

## 功能特性

| 功能 | 说明 |
|------|------|
| 公开导航页 | 分类筛选 + 关键词搜索，响应式设计 |
| 后台管理 | 添加、删除导航链接，导出和还原 JSON 备份（需登录） |
| 数据存储 | Cloudflare D1（SQLite） |
| 认证机制 | HMAC-SHA256 签名 Cookie + CSRF 保护 |
| 边缘部署 | 无后端服务器，纯 Cloudflare Workers |

## API 接口

| 接口 | 方法 | 说明 | 认证 |
|------|------|------|------|
| `/api/links` | GET | 获取所有导航数据 | 无 |
| `/api/admin/login` | POST | 登录 | 无 |
| `/api/admin/session` | GET | 检查登录状态 | 无 |
| `/api/admin/logout` | POST | 登出 | 需要 |
| `/api/admin/backup` | GET | 导出导航链接 JSON 备份 | 需要 |
| `/api/admin/restore` | POST | 完全替换并还原 JSON 备份 | 需要 + CSRF |
| `/api/admin/links` | POST | 添加链接 | 需要 + CSRF |
| `/api/admin/links/:id` | DELETE | 删除链接 | 需要 + CSRF |
| `/` | GET | 公开导航页 | 无 |
| `/admin` | GET | 后台管理页 | 无 |

## 部署步骤

### 前置准备

1. **Node.js 环境**（v18+）
   ```bash
   node --version
   ```

2. **安装 Wrangler CLI**
   ```bash
   npm install -g wrangler
   ```

3. **Cloudflare 账号**
   - 注册 https://dash.cloudflare.com
   - 登录：`wrangler login`

### 1. 初始化项目

```bash
cd personal-nav

# 本地安装依赖（如需）
npm install
```

### 2. 创建 D1 数据库

```bash
# 创建 D1 数据库
wrangler d1 create personal-nav-db

# 会输出 database_id，复制下来
```

### 3. 配置 wrangler.toml

编辑 `wrangler.toml`：

```toml
name = "personal-nav"
main = "src/worker.js"
compatibility_date = "2025-01-01"

[assets]
directory = "./public"
binding = "ASSETS"
not_found_handling = "404-page"
run_worker_first = ["/api/*"]

[[d1_databases]]
binding = "DB"
database_name = "personal-nav-db"
database_id = "替换为你的-D1-database-id"  # ← 填入上一步的 ID
migrations_dir = "migrations"
```

### 4. 配置管理密码

**方式一：wrangler.toml（推荐开发环境）**

```toml
[vars]
ADMIN_SECRET = "my-secret-password"
```

**方式二：环境变量（生产环境推荐）**

```bash
# 设置 secrets
wrangler secret put ADMIN_SECRET
# 输入你的管理密码

# 或使用命令创建
echo "my-secret-password" | wrangler secret put ADMIN_SECRET
```

**生成随机密码：**
```bash
openssl rand -hex 32
```

### 5. 执行数据库迁移

```bash
# 本地开发环境
wrangler d1 migrations apply personal-nav-db --local

# 生产环境
wrangler d1 migrations apply personal-nav-db --remote
```

### 6. 部署到 Cloudflare Workers

```bash
# 部署 Worker 和 Assets
wrangler deploy

# 部署成功后会输出域名，例如：
# https://personal-nav.your-subdomain.workers.dev
```

## 使用指南

### 访问地址

| 页面 | 地址 |
|------|------|
| 公开导航页 | `/` 或 `/index.html` |
| 后台管理页 | `/admin` 或 `/admin.html` |

### 添加导航链接

1. 访问 `/admin`
2. 输入管理密码登录
3. 填写链接信息（标题、URL、分类、图标）
4. 点击「保存链接」

### 导出和还原备份

1. 在 `/admin` 登录后，点击「导出备份」下载 JSON 文件，并妥善保存。
2. 需要恢复时，点击「选择备份文件」并选择之前导出的 `.json` 文件。
3. 点击「还原备份」并确认。还原会**完全替换**当前全部导航链接；文件校验失败或数据库写入失败时，现有数据不会更改。
4. 备份格式版本为 `1`，最多支持 1000 个链接，文件大小上限为 2 MB。备份只包含标题、URL、图标和分类，恢复后由数据库重新生成 ID 和创建时间。

备份文件示例：

```json
{
  "version": 1,
  "exportedAt": "2025-01-01T00:00:00.000Z",
  "links": [
    {
      "title": "GitHub",
      "url": "https://github.com/",
      "icon": "🐙",
      "category": "开发"
    }
  ]
}
```

### 数据库表结构

```sql
CREATE TABLE links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,        -- 网站名称
  url         TEXT NOT NULL,        -- 链接地址
  icon        TEXT DEFAULT '🔗',    -- 图标（emoji）
  category    TEXT DEFAULT '其他',  -- 分类
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_links_category ON links(category);
CREATE INDEX idx_links_title ON links(title);
```

### 手动管理数据

```bash
# 插入链接
wrangler d1 execute personal-nav-db --remote --command="
INSERT INTO links (title, url, icon, category) VALUES
  ('GitHub', 'https://github.com', '🐙', '开发'),
  ('ChatGPT', 'https://chatgpt.com', '🤖', 'AI');
"

# 查询所有链接
wrangler d1 execute personal-nav-db --remote --command="SELECT * FROM links;"

# 删除链接
wrangler d1 execute personal-nav-db --remote --command="DELETE FROM links WHERE id = 1;"

# 导出数据
wrangler d1 export personal-nav-db --remote --output=./backup.sql

# 导入数据
wrangler d1 execute personal-nav-db --remote --file=./backup.sql
```

## 自定义配置

### 配置自定义域名

1. 在 Cloudflare Dashboard 添加域名
2. 部署时指定域名：
   ```bash
   wrangler deploy --route "your-domain.com/*"
   ```
3. 或在 Dashboard 中操作：Workers → 你的 Worker → 触发器 → 自定义域

### 修改前端标题

编辑 `public/index.html` 和 `public/admin.html`：

```html
<title>我的导航</title>
<meta name="description" content="一个简洁的个人导航页" />
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `wrangler dev` | 本地开发 |
| `wrangler deploy` | 部署到生产 |
| `wrangler secret put ADMIN_SECRET` | 设置管理密码 |
| `wrangler d1 execute personal-nav-db --remote --command="..."` | 执行 SQL |
| `wrangler d1 migrations apply personal-nav-db --remote` | 应用迁移 |
| `wrangler tail` | 查看实时日志 |

## 故障排查

### 部署失败

```bash
# 检查登录状态
wrangler whoami

# 重新登录
wrangler login
```

### 登录失败

```bash
# 确认 ADMIN_SECRET 已配置
wrangler secret list

# 如未配置，重新设置
wrangler secret put ADMIN_SECRET
```

### 数据库连接失败

```bash
# 检查 D1 数据库是否存在
wrangler d1 list

# 检查迁移状态
wrangler d1 migrations list personal-nav-db --remote
```

### 查看部署日志

```bash
wrangler tail
```

## 安全说明

| 安全措施 | 说明 |
|----------|------|
| 签名 Cookie | 使用 HMAC-SHA256 防止 Cookie 篡改 |
| CSRF 保护 | 使用 `__Host-` 前缀 Cookie + CSRF Token |
| HttpOnly | Session Cookie 设置 HttpOnly 防止 XSS |
| SameSite | Cookie 设置 SameSite=Strict |
| Secure | 仅在 HTTPS 下传输 Cookie |

**注意**：由于使用 `__Host-` 前缀 Cookie，本项目必须通过 HTTPS 访问。

## 相关链接

- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [Cloudflare D1 文档](https://developers.cloudflare.com/d1/)
- [Wrangler 文档](https://developers.cloudflare.com/workers/wrangler/)
