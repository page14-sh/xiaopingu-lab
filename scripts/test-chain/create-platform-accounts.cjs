const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {provision}=require('./setup.cjs');
const root=path.resolve(__dirname,'../..');
(async()=>{
 const verification=process.argv.includes('--verification');
 const stem=verification?'platform-verify-accounts':'platform-accounts';
 const file=root+'/.private/test-chain/'+stem+'.json';
 if(fs.existsSync(file)){console.log('Fixed platform accounts already exist; not reset.');return;}
 const backend=await provision({fresh:true});
 const password='XpgDemo-'+crypto.randomInt(10000,99999)+'!';
 const salt=crypto.randomBytes(16).toString('hex');
 const record={schema:'fixed-platform-demo-v1',created_at:new Date().toISOString(),backend,usernames:{visitor:'demo_visitor',counselor:'demo_counselor',admin:'demo_admin'},salt,password_hash:crypto.scryptSync(password,salt,64).toString('hex')};
 fs.writeFileSync(file,JSON.stringify(record,null,2),{mode:0o600});fs.chmodSync(file,0o600);
 fs.writeFileSync(root+'/.private/test-chain/'+stem+'.md','# 平台演示账号\n\n平台首页：http://127.0.0.1:'+(verification?8797:8796)+'/\n\n来访者：demo_visitor\n咨询师：demo_counselor\n管理员：demo_admin\n\n本组演示账号密码：'+password+'\n\n仅用于该独立演示环境。初评、匹配申请、咨询师审批和四评均未预先完成；请在平台原页面实际操作。\n',{mode:0o600});
 console.log(JSON.stringify({created:true,usernames:record.usernames,credentials_file:'.private/test-chain/'+stem+'.md',blank_visitor:true}));
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
