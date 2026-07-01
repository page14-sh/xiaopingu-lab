-- ============================================
-- 小平菇 · 小程序来访者 + Web 登录身份拆分迁移
-- 目标：
-- 1. 来访者端由评估编号访问升级为微信 openid 绑定访问
-- 2. 咨询师 Web 工作台由 URL cid 逐步升级为登录账号
-- 3. 后台 Web 管理员由前端固定密码逐步升级为登录账号
-- ============================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. 微信小程序来访者账号
CREATE TABLE IF NOT EXISTS visitor_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  openid TEXT UNIQUE NOT NULL,
  unionid TEXT,
  nickname TEXT,
  avatar_url TEXT,
  phone TEXT,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE assessments ADD COLUMN IF NOT EXISTS visitor_user_id UUID REFERENCES visitor_users(id) ON DELETE SET NULL;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS visitor_openid TEXT;

CREATE INDEX IF NOT EXISTS idx_assessments_visitor_user ON assessments(visitor_user_id);
CREATE INDEX IF NOT EXISTS idx_assessments_visitor_openid ON assessments(visitor_openid);

-- 2. 咨询师 Web 登录账号
CREATE TABLE IF NOT EXISTS counselor_web_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counselor_id UUID UNIQUE REFERENCES counselors(id) ON DELETE CASCADE,
  login_name TEXT UNIQUE,
  phone TEXT UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT,
  is_active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_counselor_web_accounts_counselor ON counselor_web_accounts(counselor_id);

-- 3. 后台管理员 Web 登录账号
CREATE TABLE IF NOT EXISTS admin_web_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  login_name TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'admin',
  is_active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 4. 轻量会话表：如果后续接入云函数/API，可把登录态落到这里
CREATE TABLE IF NOT EXISTS web_login_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_type TEXT NOT NULL CHECK (account_type IN ('admin','counselor','visitor')),
  account_id UUID,
  session_token TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_login_sessions_token ON web_login_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_web_login_sessions_account ON web_login_sessions(account_type, account_id);

-- 5. RLS 基础策略
ALTER TABLE visitor_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE counselor_web_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_web_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_login_sessions ENABLE ROW LEVEL SECURITY;

-- 实验版：小程序可通过 openid 轻量 upsert 来访者记录。
DROP POLICY IF EXISTS "anon_insert_visitor_user" ON visitor_users;
CREATE POLICY "anon_insert_visitor_user" ON visitor_users FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "anon_read_visitor_user" ON visitor_users;
CREATE POLICY "anon_read_visitor_user" ON visitor_users FOR SELECT USING (true);

DROP POLICY IF EXISTS "anon_update_visitor_user" ON visitor_users;
CREATE POLICY "anon_update_visitor_user" ON visitor_users FOR UPDATE USING (true) WITH CHECK (true);

-- Web 账号表默认不向匿名端开放读取；正式登录请通过云函数 / Supabase Auth 处理。
DROP POLICY IF EXISTS "deny_read_counselor_web_accounts" ON counselor_web_accounts;
CREATE POLICY "deny_read_counselor_web_accounts" ON counselor_web_accounts FOR SELECT USING (false);

DROP POLICY IF EXISTS "deny_read_admin_web_accounts" ON admin_web_accounts;
CREATE POLICY "deny_read_admin_web_accounts" ON admin_web_accounts FOR SELECT USING (false);

DROP POLICY IF EXISTS "deny_read_web_login_sessions" ON web_login_sessions;
CREATE POLICY "deny_read_web_login_sessions" ON web_login_sessions FOR SELECT USING (false);

COMMENT ON TABLE visitor_users IS '微信小程序来访者身份表，openid 绑定来访者评估与PCOMS数据';
COMMENT ON TABLE counselor_web_accounts IS '咨询师 Web 登录账号，建议由服务端或 Supabase Auth 管理';
COMMENT ON TABLE admin_web_accounts IS '后台管理员 Web 登录账号，建议由服务端或 Supabase Auth 管理';
