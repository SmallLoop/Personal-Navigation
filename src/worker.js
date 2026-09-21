const SESSION_COOKIE = "__Host-admin_session";
const CSRF_COOKIE = "__Host-admin_csrf";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_BACKUP_JSON_BODY_BYTES = 2 * 1024 * 1024;
const MAX_BACKUP_LINKS = 1000;
const BACKUP_VERSION = 1;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store",
};

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers(JSON_HEADERS);

  for (const [name, value] of Object.entries(extraHeaders)) {
    if (name.toLowerCase() === "set-cookie") {
      for (const cookie of Array.isArray(value) ? value : [value]) {
        headers.append(name, cookie);
      }
    } else {
      headers.set(name, value);
    }
  }

  return new Response(JSON.stringify(data), { status, headers });
}

function methodNotAllowed(allow) {
  return json({ error: "Method Not Allowed" }, 405, { Allow: allow });
}

function getCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";

  for (const item of cookies.split(";")) {
    const separator = item.indexOf("=");
    if (separator === -1) continue;

    const key = item.slice(0, separator).trim();
    if (key === name) {
      return item.slice(separator + 1).trim();
    }
  }

  return null;
}

function cookie(name, value, maxAge, { httpOnly = false } = {}) {
  const attributes = [
    "Path=/",
    `Max-Age=${maxAge}`,
    "Secure",
    "SameSite=Strict",
  ];

  if (httpOnly) attributes.push("HttpOnly");
  return `${name}=${value}; ${attributes.join("; ")}`;
}

function getTrustedOrigins(env) {
  if (typeof env.TRUSTED_ORIGINS === "string" && env.TRUSTED_ORIGINS) {
    return env.TRUSTED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  }
  return [];
}

function sameOrigin(request, env = {}) {
  const origin = request.headers.get("Origin");
  const urlOrigin = new URL(request.url).origin;

  if (origin === null) return false;
  if (origin === urlOrigin) return true;

  // 允许信任的代理域名
  const trustedOrigins = getTrustedOrigins(env);
  if (trustedOrigins.length > 0 && trustedOrigins.includes(origin)) {
    return true;
  }

  return false;
}

function getAdminSecret(env) {
  if (typeof env.ADMIN_SECRET === "string" && env.ADMIN_SECRET) {
    return env.ADMIN_SECRET;
  }
  if (typeof env.ADMIN_PASSWORD === "string" && env.ADMIN_PASSWORD) {
    return env.ADMIN_PASSWORD;
  }
  return "";
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function importSigningKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function createSession(secret) {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    jti: randomToken(16),
  };
  const payloadPart = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadPart),
  );

  return `${payloadPart}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function verifySession(token, secret) {
  if (!token || !secret) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const payloadBytes = base64UrlToBytes(parts[0]);
  const signature = base64UrlToBytes(parts[1]);
  if (!payloadBytes || !signature) return false;

  try {
    const key = await importSigningKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(parts[0]),
    );
    if (!valid) return false;

    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    return (
      typeof payload.exp === "number" &&
      Number.isSafeInteger(payload.exp) &&
      payload.exp > Math.floor(Date.now() / 1000) &&
      typeof payload.jti === "string" &&
      payload.jti.length > 0
    );
  } catch {
    return false;
  }
}

async function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;

  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = 0;

  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }

  return difference === 0;
}

async function readJson(request, maxBytes = MAX_JSON_BODY_BYTES) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestError("请求体过大", 413);
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) {
    throw new RequestError("请求体过大", 413);
  }

  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new RequestError("请求必须是有效的 JSON");
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new RequestError("请求数据格式错误");
  }

  return data;
}

function textField(value, name, maxLength, { required = false, fallback } = {}) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") {
    throw new RequestError(`${name} 格式错误`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new RequestError(`${name} 包含非法字符`);
  }

  const result = value.trim();
  if (required && result.length === 0) {
    throw new RequestError(`${name} 不能为空`);
  }
  if (result.length > maxLength) {
    throw new RequestError(`${name} 长度不能超过 ${maxLength} 个字符`);
  }

  return result;
}

function validateLinkInput(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new RequestError("链接数据格式错误");
  }

  const title = textField(data.title, "标题", 120, { required: true });
  const category = textField(data.category, "分类", 50, {
    fallback: "其他",
  });
  if (!category) throw new RequestError("分类不能为空");

  const icon = textField(data.icon, "图标", 16, { fallback: "🔗" }) || "🔗";
  const rawUrl = textField(data.url, "链接", 2048, { required: true });

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new RequestError("链接地址无效");
  }

  if (
    !["http:", "https:"].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new RequestError("只允许不包含账号信息的 http 或 https 链接");
  }

  return {
    title,
    url: parsedUrl.toString(),
    icon,
    category,
  };
}

async function isAuthenticated(request, env) {
  return verifySession(
    getCookie(request, SESSION_COOKIE),
    getAdminSecret(env),
  );
}

async function validateAdminMutation(request, env) {
  if (!sameOrigin(request, env)) {
    return json({ error: "请求来源不受信任" }, 403);
  }

  if (!(await isAuthenticated(request, env))) {
    return json({ error: "未登录或登录已过期" }, 401);
  }

  const csrfCookie = getCookie(request, CSRF_COOKIE);
  const csrfHeader = request.headers.get("X-CSRF-Token");
  if (!csrfCookie || !(await secureEqual(csrfCookie, csrfHeader))) {
    return json({ error: "CSRF 校验失败" }, 403);
  }

  return null;
}

async function handlePublicLinks(request, env) {
  if (request.method !== "GET") return methodNotAllowed("GET");

  try {
    const { results = [] } = await env.DB.prepare(`
      SELECT id, title, url, icon, category
      FROM links
      ORDER BY category COLLATE NOCASE, title COLLATE NOCASE
    `).all();

    return json(results);
  } catch (error) {
    console.error("D1 query failed:", error);
    return json({ error: "读取导航数据失败" }, 500);
  }
}

async function handleLogin(request, env) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!sameOrigin(request, env)) return json({ error: "请求来源不受信任" }, 403);
  const adminSecret = getAdminSecret(env);
  if (!adminSecret) {
    return json({ error: "后台密码尚未配置" }, 503);
  }

  let data;
  try {
    data = await readJson(request);
  } catch (error) {
    return json(
      { error: error instanceof RequestError ? error.message : "请求格式错误" },
      error instanceof RequestError ? error.status : 400,
    );
  }

  const password = data.password;
  const passwordMatches =
    typeof password === "string" &&
    password.length <= 1024 &&
    (await secureEqual(password, adminSecret));

  if (!passwordMatches) {
    return json({ error: "密码错误" }, 401);
  }

  const session = await createSession(adminSecret);
  const csrf = randomToken();

  return json(
    { authenticated: true },
    200,
    {
      "set-cookie": [
        cookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS, {
          httpOnly: true,
        }),
        cookie(CSRF_COOKIE, csrf, SESSION_TTL_SECONDS),
      ],
    },
  );
}

async function handleSession(request, env) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  return json({ authenticated: await isAuthenticated(request, env) });
}

async function handleLogout(request, env) {
  if (request.method !== "POST") return methodNotAllowed("POST");

  const errorResponse = await validateAdminMutation(request, env);
  if (errorResponse) return errorResponse;

  return json(
    { authenticated: false },
    200,
    {
      "set-cookie": [
        cookie(SESSION_COOKIE, "", 0, { httpOnly: true }),
        cookie(CSRF_COOKIE, "", 0),
      ],
    },
  );
}

async function handleBackup(request, env) {
  if (request.method !== "GET") return methodNotAllowed("GET");

  if (!(await isAuthenticated(request, env))) {
    return json({ error: "未登录或登录已过期" }, 401);
  }

  try {
    const { results = [] } = await env.DB.prepare(`
      SELECT title, url, icon, category
      FROM links
      ORDER BY category COLLATE NOCASE, title COLLATE NOCASE
    `).all();
    const date = new Date().toISOString().slice(0, 10);

    return json(
      {
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        links: results,
      },
      200,
      {
        "content-disposition": `attachment; filename="personal-nav-backup-${date}.json"`,
        "x-content-type-options": "nosniff",
      },
    );
  } catch (error) {
    console.error("D1 backup query failed:", error);
    return json({ error: "导出导航备份失败" }, 500);
  }
}

async function handleRestore(request, env) {
  if (request.method !== "POST") return methodNotAllowed("POST");

  const errorResponse = await validateAdminMutation(request, env);
  if (errorResponse) return errorResponse;

  let data;
  try {
    data = await readJson(request, MAX_BACKUP_JSON_BODY_BYTES);
  } catch (error) {
    return json(
      { error: error instanceof RequestError ? error.message : "请求格式错误" },
      error instanceof RequestError ? error.status : 400,
    );
  }

  if (data.version !== BACKUP_VERSION || !Array.isArray(data.links)) {
    return json({ error: "备份文件格式或版本不受支持" }, 400);
  }
  if (data.links.length > MAX_BACKUP_LINKS) {
    return json(
      { error: `备份最多支持 ${MAX_BACKUP_LINKS} 个链接` },
      400,
    );
  }

  let links;
  try {
    links = data.links.map((link) => validateLinkInput(link));
  } catch (error) {
    return json(
      { error: error instanceof RequestError ? error.message : "备份中的链接数据无效" },
      error instanceof RequestError ? error.status : 400,
    );
  }

  try {
    const statements = [env.DB.prepare("DELETE FROM links")];
    statements.push(
      ...links.map((link) =>
        env.DB.prepare(`
          INSERT INTO links (title, url, icon, category)
          VALUES (?, ?, ?, ?)
        `).bind(link.title, link.url, link.icon, link.category),
      ),
    );

    await env.DB.batch(statements);
    return json({ success: true, count: links.length });
  } catch (error) {
    console.error("D1 restore failed:", error);
    return json({ error: "还原导航备份失败，原有数据未更改" }, 500);
  }
}

async function handleDeleteLink(request, env) {
  if (request.method !== "DELETE") return methodNotAllowed("DELETE");

  const errorResponse = await validateAdminMutation(request, env);
  if (errorResponse) return errorResponse;

  const { pathname } = new URL(request.url);
  const idMatch = pathname.match(/^\/api\/admin\/links\/(\d+)$/);
  if (!idMatch) {
    return json({ error: "无效的链接 ID" }, 400);
  }

  const id = Number(idMatch[1]);
  if (!Number.isFinite(id) || id <= 0) {
    return json({ error: "无效的链接 ID" }, 400);
  }

  try {
    const result = await env.DB.prepare(`
      DELETE FROM links WHERE id = ?
    `)
      .bind(id)
      .run();

    if (result.meta?.changes === 0) {
      return json({ error: "链接不存在" }, 404);
    }

    return json({ success: true }, 200);
  } catch (error) {
    console.error("D1 delete failed:", error);
    return json({ error: "删除链接失败" }, 500);
  }
}

async function handleCreateLink(request, env) {
  if (request.method !== "POST") return methodNotAllowed("POST");

  const errorResponse = await validateAdminMutation(request, env);
  if (errorResponse) return errorResponse;

  let data;
  try {
    data = await readJson(request);
  } catch (error) {
    return json(
      { error: error instanceof RequestError ? error.message : "请求格式错误" },
      error instanceof RequestError ? error.status : 400,
    );
  }

  let link;
  try {
    link = validateLinkInput(data);
  } catch (error) {
    return json(
      { error: error instanceof RequestError ? error.message : "链接数据无效" },
      error instanceof RequestError ? error.status : 400,
    );
  }

  try {
    const result = await env.DB.prepare(`
      INSERT INTO links (title, url, icon, category)
      VALUES (?, ?, ?, ?)
    `)
      .bind(link.title, link.url, link.icon, link.category)
      .run();

    return json(
      {
        id: Number(result.meta?.last_row_id || 0),
        ...link,
      },
      201,
    );
  } catch (error) {
    console.error("D1 insert failed:", error);
    return json({ error: "保存导航链接失败" }, 500);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/links") {
      return handlePublicLinks(request, env);
    }
    if (pathname === "/api/admin/login") {
      return handleLogin(request, env);
    }
    if (pathname === "/api/admin/session") {
      return handleSession(request, env);
    }
    if (pathname === "/api/admin/logout") {
      return handleLogout(request, env);
    }
    if (pathname === "/api/admin/backup") {
      return handleBackup(request, env);
    }
    if (pathname === "/api/admin/restore") {
      return handleRestore(request, env);
    }
    if (pathname === "/api/admin/links") {
      return handleCreateLink(request, env);
    }
    if (pathname.startsWith("/api/admin/links/")) {
      return handleDeleteLink(request, env);
    }
    if (pathname.startsWith("/api/")) {
      return json({ error: "Not Found" }, 404);
    }

    if ((pathname === "/admin" || pathname === "/admin/") && request.method === "GET") {
      const adminUrl = new URL(request.url);
      adminUrl.pathname = "/admin.html";
      return env.ASSETS.fetch(new Request(adminUrl, request));
    }

    return env.ASSETS.fetch(request);
  },
};
