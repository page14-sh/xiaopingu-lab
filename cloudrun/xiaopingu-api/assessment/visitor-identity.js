// Receipt identities are explicitly distinct from native verified WeChat identities.
const METHODS=Object.freeze({'wechat-cloud':'wechat-cloud','intake-receipt':'intake-receipt'});
function validVisitor(row,method){return !!row&&!row.disabled&&Object.hasOwn(METHODS,row.provider)&&(row.provider!=='intake-receipt'||/^[a-f0-9]{64}$/.test(row.credential_hash||''))&&(method===undefined||METHODS[row.provider]===method);}
module.exports={validVisitor};
