const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { COLLECTIONS: C, AssessmentError } = require('../assessment/model');
const { requirePrincipal, deny } = require('../assessment/authorization');
const scrypt = promisify(crypto.scrypt);
const SETUP_AUDIENCE = 'xpg-counselor-password-setup';
const PROFILE_AUDIENCE = 'xpg-counselor-profile';
const DAY = 86400000, LOCK_MS = 900000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = s => crypto.createHash('sha256').update(s).digest('hex');
const invalid = () => new AssessmentError('XPG_PHONE_LOGIN_FAILED', '手机号或密码不正确，或该档案尚未开通。请核对后重试。', 401);
const linkInvalid = () => new AssessmentError('XPG_INVITE_INVALID', '填写链接无效、已过期或已撤销，请联系管理员重新生成。', 401);
function normalizePhone(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  const phone = value.trim().replace(/[\s()-]/g, '').replace(/^(\+86|0086)/, '');
  return /^1[3-9]\d{9}$/.test(phone) ? phone : null;
}
function equal(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function real(row) {
  return row && !row.is_demo && UUID.test(row.id) && !/^00000000-0000-4000-8000-00000000000[12]$/.test(row.id);
}
function eligible(row) { return real(row) && row.is_active === true && row.review_status === 'approved'; }
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
async function checkPassword(password, stored) {
  if (!/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(stored || '')) return false;
  const [, salt, expected] = stored.split('$');
  return equal((await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex'), expected);
}
function newPasswordValid(value, phone) {
  return typeof value === 'string' && value.length >= 10 && value.length <= 128 &&
    /[A-Za-z]/.test(value) && /\d/.test(value) && value !== phone && value !== phone?.slice(-6);
}

function createCounselorAccess({ source, directory, now = Date.now }) {
  const stamp = () => new Date(now()).toISOString();
  async function uniqueOwner(phone) {
    const rows = (await directory()).filter(row => normalizePhone(row.contact_phone) === phone);
    return rows.length === 1 && real(rows[0]) ? rows[0] : null;
  }
  function freshAccount(id, phone, revision = 1) {
    return { counselor_id: id, phone_hash: digest(phone), revision, must_change: true,
      failures: 0, locked_until: 0, failure_window: 0, initial_expires_at: now() + 7 * DAY, updated_at: stamp() };
  }
  async function login(phoneInput, password) {
    const phone = normalizePhone(phoneInput);
    if (!phone || typeof password !== 'string' || !password.length || password.length > 128) throw invalid();
    const found = await uniqueOwner(phone);
    if (!eligible(found)) throw invalid();
    const result = await source.transaction(async tx => {
      const row = await tx.get('counselors', found.id);
      if (!eligible(row) || normalizePhone(row.contact_phone) !== phone) return { failed: true };
      let account = await tx.get(C.counselorAccounts, row.id);
      if (account && account.phone_hash !== digest(phone)) return { failed: true }; // Admin must rebind changed phone numbers.
      if (!account) account = freshAccount(row.id, phone);
      if (account.locked_until > now()) return { locked: true };
      const valid = account.must_change ? account.initial_expires_at > now() && equal(password, phone.slice(-6)) :
        await checkPassword(password, account.password_hash);
      if (!valid) {
        const failures = now() - account.failure_window < LOCK_MS ? account.failures + 1 : 1;
        account = { ...account, failures, failure_window: failures === 1 ? now() : account.failure_window,
          locked_until: failures >= 5 ? now() + LOCK_MS : 0, updated_at: stamp() };
        await tx.put(C.counselorAccounts, row.id, account);
        return { locked: failures >= 5, failed: true };
      }
      account = { ...account, failures: 0, locked_until: 0, failure_window: 0, updated_at: stamp() };
      await tx.put(C.counselorAccounts, row.id, account);
      return { id: row.id, revision: account.revision, must_change: account.must_change };
    });
    if (result.locked) throw new AssessmentError('XPG_PHONE_LOCKED', '登录尝试过多，请 15 分钟后再试，或联系管理员重置。', 429);
    if (result.failed) throw invalid();
    return result;
  }
  async function setPassword(session, password) {
    if (!session || session.aud !== SETUP_AUDIENCE || session.role !== 'counselor' || session.demo !== false ||
      session.auth_method !== 'counselor-phone-initial' || !UUID.test(session.subject || '') || !Number.isFinite(session.exp) || session.exp <= now()) throw invalid();
    const owner = await source.get('counselors', session.subject), phone = normalizePhone(owner?.contact_phone);
    if (!eligible(owner) || !phone || (await uniqueOwner(phone))?.id !== owner.id) throw invalid();
    if (!newPasswordValid(password, phone)) throw new AssessmentError('XPG_WEAK_PASSWORD', '新密码需为 10–128 位，同时包含字母和数字，不能使用手机号或默认密码。', 400);
    const hashed = await hashPassword(password);
    return source.transaction(async tx => {
      const row = await tx.get('counselors', owner.id), account = await tx.get(C.counselorAccounts, owner.id);
      if (!eligible(row) || normalizePhone(row.contact_phone) !== phone || !account?.must_change ||
        account.revision !== session.account_revision || account.phone_hash !== digest(phone) || account.initial_expires_at <= now()) throw invalid();
      const next = { ...account, must_change: false, password_hash: hashed, revision: account.revision + 1,
        failures: 0, locked_until: 0, failure_window: 0, password_changed_at: stamp(), updated_at: stamp() };
      await tx.put(C.counselorAccounts, owner.id, next);
      return { id: owner.id, revision: next.revision };
    });
  }
  async function validatePhone(session) {
    requirePrincipal(session);
    if (session.auth_method !== 'counselor-phone') deny();
    const [row, account] = await Promise.all([source.get('counselors', session.subject), source.get(C.counselorAccounts, session.subject)]);
    const phone = normalizePhone(row?.contact_phone);
    if (!eligible(row) || !phone || !account || account.must_change || account.revision !== session.account_revision ||
      account.phone_hash !== digest(phone) || (await uniqueOwner(phone))?.id !== row.id) throw invalid();
    return row;
  }
  function admin(session) { requirePrincipal(session); if (session.role !== 'admin') deny(); }
  async function resetPhone(session, id) {
    admin(session); if (!UUID.test(id || '')) deny();
    const row = await source.get('counselors', id), phone = normalizePhone(row?.contact_phone);
    if (!real(row) || !phone || (await uniqueOwner(phone))?.id !== id) throw new AssessmentError('XPG_PHONE_UNAVAILABLE', '档案需有唯一有效的手机号，请先核对联系方式。', 400);
    await source.transaction(async tx => {
      const current = await tx.get('counselors', id), old = await tx.get(C.counselorAccounts, id);
      if (normalizePhone(current?.contact_phone) !== phone) deny();
      await tx.put(C.counselorAccounts, id, { ...freshAccount(id, phone, (old?.revision || 0) + 1), reset_by: session.subject });
    });
    return { reset: true, phone_masked: phone.slice(0, 3) + '****' + phone.slice(-4), must_change_password: true };
  }
  async function issueInvite(session, id) {
    admin(session); if (!UUID.test(id || '')) deny();
    const secret = crypto.randomBytes(32).toString('base64url'), generation = crypto.randomUUID(), expires = now() + 7 * DAY;
    await source.transaction(async tx => {
      if (!real(await tx.get('counselors', id))) deny();
      await tx.put(C.counselorInvites, id, { counselor_id: id, secret_hash: digest(secret), generation,
        expires_at: expires, revoked: false, created_by: session.subject, created_at: stamp() });
    });
    return { invite: id + '.' + secret, expires_at: expires };
  }
  async function revokeInvite(session, id) {
    admin(session); if (!UUID.test(id || '')) deny();
    await source.transaction(async tx => {
      const row = await tx.get(C.counselorInvites, id);
      if (row) await tx.put(C.counselorInvites, id, { ...row, revoked: true, revoked_at: stamp() });
    });
    return { revoked: true };
  }
  async function exchangeInvite(token) {
    if (typeof token !== 'string' || token.length > 100) throw linkInvalid();
    const [id, secret, extra] = token.split('.');
    if (extra || !UUID.test(id || '') || !/^[A-Za-z0-9_-]{43}$/.test(secret || '')) throw linkInvalid();
    const [invite, row] = await Promise.all([source.get(C.counselorInvites, id), source.get('counselors', id)]);
    if (!real(row) || !invite || invite.revoked || invite.expires_at <= now() || !equal(invite.secret_hash, digest(secret))) throw linkInvalid();
    return { id, generation: invite.generation, expires_at: Math.min(invite.expires_at, now() + 30 * 60000) };
  }
  async function validateInvite(session) {
    if (!session || session.aud !== PROFILE_AUDIENCE || session.role !== 'counselor' || session.auth_method !== 'profile-invite' ||
      session.demo !== false || !UUID.test(session.subject || '') || !Number.isFinite(session.exp) || session.exp <= now()) throw linkInvalid();
    const [row, invite] = await Promise.all([source.get('counselors', session.subject), source.get(C.counselorInvites, session.subject)]);
    if (!real(row) || !invite || invite.revoked || invite.expires_at <= now() || session.invite_generation !== invite.generation) throw linkInvalid();
    return row;
  }
  return { login, setPassword, validatePhone, resetPhone, issueInvite, revokeInvite, exchangeInvite, validateInvite };
}
module.exports = { createCounselorAccess, normalizePhone, SETUP_AUDIENCE, PROFILE_AUDIENCE };
