const crypto=require('node:crypto');
function verifyAccount(config,input){
 if(!input||!['visitor','counselor','admin'].includes(input.role)||typeof input.username!=='string'||typeof input.password!=='string'||input.password.length>256)return false;
 if(config.usernames[input.role]!==input.username)return false;
 const value=crypto.scryptSync(input.password,config.salt,64),expected=Buffer.from(config.password_hash,'hex');
 return value.length===expected.length&&crypto.timingSafeEqual(value,expected);
}
module.exports={verifyAccount};
