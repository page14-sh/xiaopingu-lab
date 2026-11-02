const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { AssessmentError } = require('../assessment/model');

const PHOTO_FIELDS = ['photo_daily', 'photo_license'];
const MAX_PHOTOS = 2;
const MAX_DATA_URL = 260000;
const LINK_TTL = 300;
const badPhoto = () => new AssessmentError('XPG_INVALID_PHOTO', '照片无效或超限，请重新选择（每类最多 2 张）', 400);
const unavailable = () => new AssessmentError('XPG_PHOTO_STORAGE', '照片存储暂不可用，请稍后重试', 503);
function fileId(value) {
  return typeof value === 'string' && value.startsWith('cloud://') ? value :
    value && typeof value === 'object' && typeof value.file_id === 'string' ? value.file_id : null;
}
function allIds(row) { return PHOTO_FIELDS.flatMap(key => (row?.[key] || []).map(fileId).filter(Boolean)); }
function success(result) { return result && (!result.code || result.code === 'SUCCESS'); }

// Decode and re-encode on the server: accept raster images only, discard EXIF/GPS,
// original filenames and all other metadata. Never fetch a client-supplied URL.
async function normalizePhoto(value) {
  if (typeof value !== 'string' || value.length > MAX_DATA_URL) throw badPhoto();
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw badPhoto();
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.toString('base64') !== match[2]) throw badPhoto();
  try {
    const image = sharp(bytes, { limitInputPixels: 16000000, failOn: 'warning' });
    const meta = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(meta.format) || (meta.pages || 1) !== 1) throw badPhoto();
    return await image.rotate().resize(900, 900, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 }).toBuffer();
  } catch { throw badPhoto(); }
}

function createCounselorPhotos({ storage, namespace, logger = console }) {
  if (!/^xg_(v2|preview)_[a-z0-9]{4,12}_$/.test(namespace)) throw new Error('Photos require an isolated namespace');
  const root = `counselor-photos/${namespace}/`;
  function owned(id, key, value) {
    const ref = fileId(value);
    // Scope every file to its deployment, owner and privacy category.
    return ref && /^cloud:\/\/[^/]+\//.test(ref) &&
      ref.slice(ref.indexOf('/', 8) + 1).startsWith(`${root}${id}/${key}/`) &&
      /^[a-f0-9-]{36}\.jpg$/.test(ref.split('/').at(-1));
  }
  async function remove(ids) {
    if (!ids.length) return;
    try {
      const r = await storage.deleteFile({ fileList: [...new Set(ids)] });
      if (!success(r) || r.fileList?.length !== new Set(ids).size || r.fileList.some(x => !success(x))) throw unavailable();
    } catch {
      // Do not log file identifiers, signed URLs or raw SDK errors. A failed
      // cleanup cannot expose a private object; operators can reconcile later.
      logger.warn('XPG_PHOTO_CLEANUP_REQUIRED');
    }
  }
  async function save(id, patch, previous, persist, reload) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw badPhoto();
    const next = { ...patch }, uploaded = [], prepared = {};
    // Validate *all* fields before any upload; category changes cannot promote
    // private certificates into public daily photos, even for the same owner.
    for (const key of PHOTO_FIELDS) {
      if (!(key in patch)) continue;
      if (!Array.isArray(patch[key]) || patch[key].length > MAX_PHOTOS) throw badPhoto();
      prepared[key] = [];
      for (const value of patch[key]) {
        const ref = fileId(value);
        if (ref) {
          if (!owned(id, key, ref) || !(previous?.[key] || []).some(x => fileId(x) === ref)) throw badPhoto();
          prepared[key].push(ref);
        } else prepared[key].push(await normalizePhoto(value));
      }
    }
    try {
      for (const [key, values] of Object.entries(prepared)) {
        next[key] = [];
        for (const value of values) {
          if (typeof value === 'string') { next[key].push(value); continue; }
          const cloudPath = `${root}${id}/${key}/${randomUUID()}.jpg`;
          let result;
          try { result = await storage.uploadFile({ cloudPath, fileContent: value }); } catch { throw unavailable(); }
          if (!success(result) || !owned(id, key, result.fileID)) throw unavailable();
          uploaded.push(result.fileID);
          next[key].push(result.fileID);
        }
      }
      await persist(next);
    } catch (error) {
      // A write timeout may have committed. Preserve objects still referenced
      // by the fresh record; if confirmation itself fails, retain privately.
      try {
        const fresh = await reload();
        await remove(uploaded.filter(ref => !allIds(fresh).includes(ref)));
      } catch { logger.warn('XPG_PHOTO_CLEANUP_REQUIRED'); }
      throw error;
    }
    // Only objects actually removed from this record are deleted. The caller
    // commits with a photo snapshot check to prevent stale editors reusing them.
    const kept = allIds({ ...previous, ...next });
    await remove(allIds(previous).filter(ref => !kept.includes(ref)));
    return next;
  }
  async function present(rows) {
    const ids = [...new Set(rows.flatMap(row => PHOTO_FIELDS.flatMap(key =>
      (row[key] || []).filter(value => owned(row.id, key, value)).map(fileId))))];
    const urls = new Map();
    for (let i = 0; i < ids.length; i += 50) {
      let r;
      try { r = await storage.getTempFileURL({ fileList: ids.slice(i, i + 50).map(fileID => ({ fileID, maxAge: LINK_TTL })) }); }
      catch { throw unavailable(); }
      if (!success(r) || !Array.isArray(r.fileList)) throw unavailable();
      for (const item of r.fileList) {
        if (!success(item) || !/^https:\/\//.test(item.tempFileURL || '')) throw unavailable();
        urls.set(item.fileID, item.tempFileURL);
      }
    }
    // MUST be called after authorization and sensitive-field filtering.
    return rows.map(row => {
      const out = { ...row };
      for (const key of PHOTO_FIELDS) if (Array.isArray(row[key])) {
        out[key] = row[key].map(value => {
          const ref = fileId(value);
          if (!ref) return value; // Existing Base64 remains readable until saved.
          if (!owned(row.id, key, ref) || !urls.has(ref)) throw unavailable();
          return { file_id: ref, url: urls.get(ref), expires_at: Date.now() + LINK_TTL * 1000 };
        });
      }
      return out;
    });
  }
  return { save, present };
}
module.exports = { createCounselorPhotos, normalizePhoto, PHOTO_FIELDS, MAX_PHOTOS, LINK_TTL };
