const {createHash,randomBytes,timingSafeEqual}=require('node:crypto');
const {AssessmentError}=require('../assessment/model');
const FORMAT=/^xpg2_[A-Za-z0-9_-]{43}$/;
function generate(){return 'xpg2_'+randomBytes(32).toString('base64url');}
function digest(value){if(typeof value!=='string'||!FORMAT.test(value))throw new AssessmentError('XG_UNAUTHORIZED','请使用新版独立填写凭证',401);return createHash('sha256').update(value).digest('hex');}
function matches(value,hash){try{const a=Buffer.from(digest(value)),b=Buffer.from(hash||'');return a.length===b.length&&timingSafeEqual(a,b);}catch{return false;}}
module.exports={generate,digest,matches};
